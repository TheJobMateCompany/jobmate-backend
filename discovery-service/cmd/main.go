// jobmate-discovery-service — Stub placeholder
//
// TODO: Implement job scraper workers (Goroutines), cron scheduler,
// Red Flag filtering, and job_feed insertion via PostgreSQL.

package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
)

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
		Version: "0.1.0",
	})
}

func main() {
	port := os.Getenv("DISCOVERY_PORT")
	if port == "" {
		port = "8081"
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/health", healthHandler)

	addr := fmt.Sprintf(":%s", port)
	log.Printf("[discovery-service] Listening on %s", addr)

	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Fatalf("[discovery-service] Fatal: %v", err)
	}
}
