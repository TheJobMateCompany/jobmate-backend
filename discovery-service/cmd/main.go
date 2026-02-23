// jobmate-discovery-service
//
// Scrapes active SearchConfigs from PostgreSQL, fetches matching job offers
// from external job boards (Adzuna API), applies red-flag filtering, and
// inserts deduplicated offers into job_feed (status = PENDING).
//
// Also exposes GET /health for Docker + Traefik health checks.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"jobmate/discovery-service/internal/config"
	"jobmate/discovery-service/internal/db"
	"jobmate/discovery-service/internal/scheduler"
	"jobmate/discovery-service/internal/scraper"
)

func main() {
	// ── Config ─────────────────────────────────────────────────
	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("[discovery-service] Config error: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// ── PostgreSQL ─────────────────────────────────────────────
	log.Println("[discovery-service] Connecting to PostgreSQL…")
	pool, err := db.NewPostgresPool(ctx, cfg.DatabaseURL)
	if err != nil {
		log.Fatalf("[discovery-service] PostgreSQL: %v", err)
	}
	defer pool.Close()
	log.Println("[discovery-service] PostgreSQL connected ✓")

	// ── Redis ──────────────────────────────────────────────────
	log.Println("[discovery-service] Connecting to Redis…")
	rdb, err := db.NewRedisClient(ctx, cfg.RedisURL)
	if err != nil {
		log.Fatalf("[discovery-service] Redis: %v", err)
	}
	defer rdb.Close()
	log.Println("[discovery-service] Redis connected ✓")

	// ── Scraper ────────────────────────────────────────────────
	fetcher := scraper.NewAdzunaFetcher(cfg.AdzunaAppID, cfg.AdzunaAppKey, cfg.AdzunaCountry)
	worker := scraper.NewWorker(pool, rdb, fetcher)

	if cfg.AdzunaAppID == "" || cfg.AdzunaAppKey == "" {
		log.Println("[discovery-service] ⚠ ADZUNA_APP_ID / ADZUNA_APP_KEY not set — scraper will be a no-op until credentials are provided")
	}

	// ── Scheduler ──────────────────────────────────────────────
	sched := scheduler.New(pool, rdb, worker, cfg.ScrapeIntervalHours)
	if err := sched.Start(ctx); err != nil {
		log.Fatalf("[discovery-service] Scheduler start failed: %v", err)
	}
	defer sched.Stop()

	// ── HTTP server ────────────────────────────────────────────
	mux := http.NewServeMux()
	mux.HandleFunc("/health", healthHandler)

	srv := &http.Server{
		Addr:         fmt.Sprintf(":%s", cfg.Port),
		Handler:      mux,
		ReadTimeout:  10 * time.Second,
		WriteTimeout: 10 * time.Second,
	}

	go func() {
		log.Printf("[discovery-service] Listening on port %s (scrape interval: %dh)", cfg.Port, cfg.ScrapeIntervalHours)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("[discovery-service] HTTP server error: %v", err)
		}
	}()

	// ── Graceful shutdown ───────────────────────────────────────
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	log.Println("[discovery-service] Shutting down…")
	cancel()

	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer shutdownCancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		log.Printf("[discovery-service] HTTP shutdown error: %v", err)
	}
}

type healthResponse struct {
	Status  string `json:"status"`
	Service string `json:"service"`
	Version string `json:"version"`
}

func healthHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(healthResponse{
		Status:  "ok",
		Service: "discovery-service",
		Version: "1.0.0",
	})
}
