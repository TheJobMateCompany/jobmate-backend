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
	// ── Config ──────────────────────────────────────────────────────────────
	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("[tracker-service] Config error: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// ── PostgreSQL ───────────────────────────────────────────────────────────
	log.Println("[tracker-service] Connecting to PostgreSQL…")
	pool, err := db.NewPostgresPool(ctx, cfg.DatabaseURL)
	if err != nil {
		log.Fatalf("[tracker-service] PostgreSQL: %v", err)
	}
	defer pool.Close()
	log.Println("[tracker-service] PostgreSQL connected ✓")

	// ── Redis ────────────────────────────────────────────────────────────────
	log.Println("[tracker-service] Connecting to Redis…")
	rdb, err := db.NewRedisClient(ctx, cfg.RedisURL)
	if err != nil {
		log.Fatalf("[tracker-service] Redis: %v", err)
	}
	defer rdb.Close()
	log.Println("[tracker-service] Redis connected ✓")

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
		log.Printf("[tracker-service] v%s listening on :%s", version, cfg.Port)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("[tracker-service] HTTP server error: %v", err)
		}
	}()

	// ── Graceful shutdown ────────────────────────────────────────────────────
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	log.Println("[tracker-service] Shutting down…")
	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer shutdownCancel()

	if err := srv.Shutdown(shutdownCtx); err != nil {
		log.Printf("[tracker-service] Shutdown error: %v", err)
	}
	log.Println("[tracker-service] Stopped.")
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

