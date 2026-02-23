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
	"log/slog"
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
	// ── Structured JSON logging ─────────────────────────────────
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo})))

	// ── Config ─────────────────────────────────────────────────
	cfg, err := config.Load()
	if err != nil {
		slog.Error("Config error", "err", err)
		os.Exit(1)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// ── PostgreSQL ─────────────────────────────────────────────
	slog.Info("Connecting to PostgreSQL…")
	pool, err := db.NewPostgresPool(ctx, cfg.DatabaseURL)
	if err != nil {
		slog.Error("PostgreSQL connection failed", "err", err)
		os.Exit(1)
	}
	defer pool.Close()
	slog.Info("PostgreSQL connected ✓")

	// ── Redis ──────────────────────────────────────────────────
	slog.Info("Connecting to Redis…")
	rdb, err := db.NewRedisClient(ctx, cfg.RedisURL)
	if err != nil {
		slog.Error("Redis connection failed", "err", err)
		os.Exit(1)
	}
	defer rdb.Close()
	slog.Info("Redis connected ✓")

	// ── Scraper ────────────────────────────────────────────────
	fetcher := scraper.NewAdzunaFetcher(cfg.AdzunaAppID, cfg.AdzunaAppKey, cfg.AdzunaCountry)
	worker := scraper.NewWorker(pool, rdb, fetcher)

	if cfg.AdzunaAppID == "" || cfg.AdzunaAppKey == "" {
		slog.Warn("ADZUNA_APP_ID / ADZUNA_APP_KEY not set — scraper will be a no-op until credentials are provided")
	}

	// ── Scheduler ──────────────────────────────────────────────
	sched := scheduler.New(pool, rdb, worker, cfg.ScrapeIntervalHours)
	if err := sched.Start(ctx); err != nil {
		slog.Error("Scheduler start failed", "err", err)
		os.Exit(1)
	}
	defer sched.Stop()

	// ── HTTP server ────────────────────────────────────────────
	mux := http.NewServeMux()
	mux.HandleFunc("/health", healthHandler)
	// POST /trigger — manually fire a scrape cycle (useful for testing / dev)
	mux.HandleFunc("/trigger", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusMethodNotAllowed)
			w.Write([]byte(`{"error":"POST required"}`))
			return
		}
		slog.Info("Manual scrape triggered via /trigger")
		sched.RunOnce(ctx)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusAccepted)
		w.Write([]byte(`{"status":"scrape started"}`))
	})
	srv := &http.Server{
		Addr:         fmt.Sprintf(":%s", cfg.Port),
		Handler:      mux,
		ReadTimeout:  10 * time.Second,
		WriteTimeout: 10 * time.Second,
	}

	go func() {
		slog.Info("discovery-service listening", "port", cfg.Port, "scrapeIntervalHours", cfg.ScrapeIntervalHours)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			slog.Error("HTTP server error", "err", err)
			os.Exit(1)
		}
	}()

	// ── Graceful shutdown ───────────────────────────────────────
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	slog.Info("discovery-service shutting down…")
	cancel()

	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer shutdownCancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		slog.Error("HTTP shutdown error", "err", err)
	}
	slog.Info("discovery-service stopped.")
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
