// Package scheduler wires up the cron job that periodically triggers scraping
// for all active SearchConfigs.
package scheduler

import (
	"context"
	"fmt"
	"log"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
	"github.com/robfig/cron/v3"

	"jobmate/discovery-service/internal/scraper"
)

// Scheduler wraps robfig/cron and manages the scrape loop.
type Scheduler struct {
	cron    *cron.Cron
	pool    *pgxpool.Pool
	rdb     *redis.Client
	worker  *scraper.Worker
	spec    string // cron spec, e.g. "@every 6h"
}

// New creates a Scheduler that fires every intervalHours hours.
func New(pool *pgxpool.Pool, rdb *redis.Client, worker *scraper.Worker, intervalHours int) *Scheduler {
	return &Scheduler{
		cron:   cron.New(cron.WithLogger(cron.DefaultLogger)),
		pool:   pool,
		rdb:    rdb,
		worker: worker,
		spec:   fmt.Sprintf("@every %dh", intervalHours),
	}
}

// Start registers the job and starts the scheduler. Also runs one scrape
// immediately so the feed is populated without waiting for the first tick.
func (s *Scheduler) Start(ctx context.Context) error {
	_, err := s.cron.AddFunc(s.spec, func() {
		s.runScrape(ctx)
	})
	if err != nil {
		return fmt.Errorf("cron.AddFunc: %w", err)
	}

	s.cron.Start()
	log.Printf("[scheduler] Cron started — spec: %s", s.spec)

	// Run immediately on startup (non-blocking)
	go s.runScrape(ctx)

	return nil
}

// Stop gracefully shuts down the scheduler.
func (s *Scheduler) Stop() {
	s.cron.Stop()
	log.Println("[scheduler] Cron stopped")
}

// runScrape loads all active configs and runs a Worker for each one.
func (s *Scheduler) runScrape(ctx context.Context) {
	log.Println("[scheduler] Scrape cycle started")

	configs, err := scraper.LoadActiveConfigs(ctx, s.pool)
	if err != nil {
		log.Printf("[scheduler] LoadActiveConfigs error: %v", err)
		return
	}

	if len(configs) == 0 {
		log.Println("[scheduler] No active search configs — nothing to scrape")
		return
	}

	log.Printf("[scheduler] Running scrape for %d config(s)", len(configs))
	for _, cfg := range configs {
		if err := s.worker.Run(ctx, cfg); err != nil {
			log.Printf("[scheduler] Worker error for config %s: %v", cfg.ID, err)
		}
	}

	log.Println("[scheduler] Scrape cycle complete")
}
