// jobmate-tracker-service — gRPC edition
//
// Kanban state machine for job applications.
// Exposes a gRPC API on port 9082 (internal Docker network) used by the
// Gateway, implementing TrackerService:
//   - ListApplications — list user's kanban cards
//   - MoveCard         — state machine transitions
//   - AddNote          — free-text note update
//   - RateApplication  — 1-5 star rating
//
// A minimal HTTP server is kept on port 8082 for the /health endpoint
// required by Traefik. All application logic is accessed only via gRPC.
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
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	pb "jobmate/tracker-service/internal/pb"

	"jobmate/tracker-service/internal/config"
	"jobmate/tracker-service/internal/db"
	"jobmate/tracker-service/internal/grpcserver"
	"jobmate/tracker-service/internal/kanban"

	"google.golang.org/grpc"
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

	// ── Business logic + gRPC server ────────────────────────────────────────
	svc := kanban.NewService(pool, rdb)
	grpcSrv := grpc.NewServer()
	pb.RegisterTrackerServiceServer(grpcSrv, grpcserver.NewServer(svc))

	grpcPort := os.Getenv("TRACKER_GRPC_PORT")
	if grpcPort == "" {
		grpcPort = "9082"
	}
	lis, err := net.Listen("tcp", ":"+grpcPort)
	if err != nil {
		slog.Error("gRPC listen failed", "port", grpcPort, "err", err)
		os.Exit(1)
	}

	go func() {
		slog.Info("tracker-service gRPC listening", "port", grpcPort, "version", version)
		if err := grpcSrv.Serve(lis); err != nil {
			slog.Error("gRPC server error", "err", err)
			os.Exit(1)
		}
	}()

	// ── HTTP server (/health only — required by Traefik) ─────────────────────
	mux := http.NewServeMux()
	mux.HandleFunc("/health", healthHandler)

	srv := &http.Server{
		Addr:         fmt.Sprintf(":%s", cfg.Port),
		Handler:      mux,
		ReadTimeout:  10 * time.Second,
		WriteTimeout: 10 * time.Second,
	}

	go func() {
		slog.Info("tracker-service HTTP listening", "port", cfg.Port)
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

	grpcSrv.GracefulStop()

	if err := srv.Shutdown(shutdownCtx); err != nil {
		slog.Error("HTTP shutdown error", "err", err)
	}
	slog.Info("tracker-service stopped.")
}

func healthHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	if err := json.NewEncoder(w).Encode(map[string]string{
		"status":  "ok",
		"service": "tracker-service",
		"version": version,
	}); err != nil {
		slog.Error("health encode error", "err", err)
	}
}

