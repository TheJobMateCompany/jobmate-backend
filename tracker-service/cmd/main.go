// jobmate-tracker-service — Stub placeholder
//
// TODO: Implement Kanban state machine (TO_APPLY → APPLIED → INTERVIEW → OFFER → HIRED),
// history_log audit trail writes, and Redis event listeners.

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
		Service: "tracker-service",
		Version: "0.1.0",
	})
}

func main() {
	port := os.Getenv("TRACKER_PORT")
	if port == "" {
		port = "8082"
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/health", healthHandler)

	addr := fmt.Sprintf(":%s", port)
	log.Printf("[tracker-service] Listening on %s", addr)

	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Fatalf("[tracker-service] Fatal: %v", err)
	}
}
