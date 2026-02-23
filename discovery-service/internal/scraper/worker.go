package scraper

import (
	"context"
	"encoding/json"
	"fmt"
	"log"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"

	"jobmate/discovery-service/internal/model"
)

// Worker runs the full scrape cycle for a single SearchConfig.
// It fetches offers, applies red-flag filtering, deduplicates by source_url,
// and inserts new offers into job_feed with status PENDING.
type Worker struct {
	pool    *pgxpool.Pool
	rdb     *redis.Client
	fetcher *AdzunaFetcher
}

// NewWorker constructs a Worker.
func NewWorker(pool *pgxpool.Pool, rdb *redis.Client, fetcher *AdzunaFetcher) *Worker {
	return &Worker{pool: pool, rdb: rdb, fetcher: fetcher}
}

// Run executes one scrape cycle for the given SearchConfig.
// For each (jobTitle × location) pair it fetches from Adzuna, filters red
// flags, and upserts into job_feed (skipping duplicates by source_url).
func (w *Worker) Run(ctx context.Context, cfg model.SearchConfig) error {
	log.Printf("[worker] Starting scrape for config %s (user %s): titles=%v locations=%v",
		cfg.ID, cfg.UserID, cfg.JobTitles, cfg.Locations)

	var totalInserted, totalFiltered, totalDuplicate int

	for _, title := range cfg.JobTitles {
		for _, location := range cfg.Locations {
			inserted, filtered, dupes, err := w.scrapeAndInsert(ctx, cfg, title, location)
			if err != nil {
				log.Printf("[worker] Error scraping (%q, %q): %v — continuing", title, location, err)
				continue
			}
			totalInserted += inserted
			totalFiltered += filtered
			totalDuplicate += dupes
		}
	}

	log.Printf("[worker] Config %s done — inserted=%d filtered=%d duplicates=%d",
		cfg.ID, totalInserted, totalFiltered, totalDuplicate)
	return nil
}

func (w *Worker) scrapeAndInsert(
	ctx context.Context,
	cfg model.SearchConfig,
	title, location string,
) (inserted, filtered, dupes int, err error) {
	results, err := w.fetcher.Fetch(ctx, title, location)
	if err != nil {
		return 0, 0, 0, fmt.Errorf("fetch: %w", err)
	}
	if len(results) == 0 {
		return 0, 0, 0, nil
	}

	for _, job := range results {
		// ── Red-flag filter ────────────────────────────────
		if ContainsRedFlag(job.Title, job.Company, job.Description, cfg.RedFlags) {
			filtered++
			continue
		}

		// ── Serialise to JSONB ─────────────────────────────
		rawJSON, err := json.Marshal(job)
		if err != nil {
			log.Printf("[worker] json.Marshal error: %v", err)
			continue
		}

		// ── Dedup insert (skip if source_url already exists) ──
		if job.SourceURL == "" {
			job.SourceURL = fmt.Sprintf("adzuna:%s", job.ExternalID)
		}

		tag, err := w.pool.Exec(ctx,
			`INSERT INTO job_feed (search_config_id, raw_data, source_url, status)
			 SELECT $1, $2::jsonb, $3, 'PENDING'
			 WHERE NOT EXISTS (
			   SELECT 1 FROM job_feed WHERE source_url = $3
			 )`,
			cfg.ID, string(rawJSON), job.SourceURL,
		)
		if err != nil {
			log.Printf("[worker] DB insert error: %v", err)
			continue
		}

		if tag.RowsAffected() == 0 {
			dupes++
		} else {
			inserted++
		}
	}

	return inserted, filtered, dupes, nil
}

// LoadActiveConfigs fetches all is_active = true search configs from the DB.
func LoadActiveConfigs(ctx context.Context, pool *pgxpool.Pool) ([]model.SearchConfig, error) {
	rows, err := pool.Query(ctx,
		`SELECT id, user_id, job_titles, locations, remote_policy, keywords, red_flags,
		        salary_min, salary_max
		 FROM search_configs
		 WHERE is_active = true`,
	)
	if err != nil {
		return nil, fmt.Errorf("query search_configs: %w", err)
	}
	defer rows.Close()

	var configs []model.SearchConfig
	for rows.Next() {
		var c model.SearchConfig
		var salaryMin, salaryMax *int
		if err := rows.Scan(
			&c.ID, &c.UserID, &c.JobTitles, &c.Locations,
			&c.RemotePolicy, &c.Keywords, &c.RedFlags,
			&salaryMin, &salaryMax,
		); err != nil {
			return nil, fmt.Errorf("scan: %w", err)
		}
		c.SalaryMin = salaryMin
		c.SalaryMax = salaryMax
		configs = append(configs, c)
	}

	return configs, rows.Err()
}
