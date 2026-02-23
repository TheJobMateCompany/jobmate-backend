// jobmate-tracker-service — Phase 4
//
// Kanban state machine for job applications.
// Exposes a REST API used by the Gateway to implement:
//   - moveCard(applicationId, newStatus) — state machine transitions
//   - addNote(applicationId, note)       — free-text notes
//   - rateApplication(applicationId, rating) — 1-5 star rating
//   - myApplications query               — list applications
//
// On HIRED transition: deactivates the linked search_config (archival).
// Publishes EVENT_CARD_MOVED to Redis for Gateway SSE forward.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"jobmate/tracker-service/internal/config"
	"jobmate/tracker-service/internal/db"
	"jobmate/tracker-service/internal/kanban"
)

const version = "1.0.0"

func main() {
	// ── Structured JSON logging ──────────────────────────────────
	jsonHandler := slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo})
	slog.SetDefault(slog.New(jsonHandler))
	log.SetFlags(0) // log.Printf calls will still work but output raw lines

	// ── Config ────────────────────────────────────────────
	cfg, err := config.Load()
	if err != nil {
		slog.Error("Config error", "err", err)
		os.Exit(1)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// ── PostgreSQL ───────────────────────────────────────────────────────────
	slog.Info("Connecting to PostgreSQL…")
	pool, err := db.NewPostgresPool(ctx, cfg.DatabaseURL)
	if err != nil {
		slog.Error("PostgreSQL connection failed", "err", err)
		os.Exit(1)
	}
	defer pool.Close()
	slog.Info("PostgreSQL connected ✓")

	// ── Redis ────────────────────────────────────────────
	slog.Info("Connecting to Redis…")
	rdb, err := db.NewRedisClient(ctx, cfg.RedisURL)
	if err != nil {
		slog.Error("Redis connection failed", "err", err)
		os.Exit(1)
	}
	defer rdb.Close()
	slog.Info("Redis connected ✓")

	// ── HTTP server ──────────────────────────────────────────────────────────
	mux := http.NewServeMux()
	mux.HandleFunc("/health", healthHandler)

	h := kanban.NewHandler(pool, rdb)
	h.RegisterRoutes(mux)

	srv := &http.Server{
		Addr:         fmt.Sprintf(":%s", cfg.Port),
		Handler:      mux,
		ReadTimeout:  10 * time.Second,
		WriteTimeout: 10 * time.Second,
	}

	go func() {
		slog.Info("tracker-service listening", "port", cfg.Port, "version", version)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			slog.Error("HTTP server error", "err", err)
			os.Exit(1)
		}
	}()

	// ── Graceful shutdown ────────────────────────────────────────────────────
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	slog.Info("tracker-service shutting down…")
	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer shutdownCancel()

	if err := srv.Shutdown(shutdownCtx); err != nil {
		slog.Error("Shutdown error", "err", err)
	}
	slog.Info("tracker-service stopped.")
}

func healthHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]string{
		"status":  "ok",
		"service": "tracker-service",
		"version": version,
	})
}

