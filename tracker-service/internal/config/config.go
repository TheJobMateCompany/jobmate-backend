// Package config loads and validates environment variables at startup.
// Fail-fast: if a required variable is missing, the process exits with an error.
package config

import (
	"fmt"
	"os"
)

// Config holds all runtime configuration for the tracker service.
type Config struct {
	Port        string
	DatabaseURL string
	RedisURL    string
}

// Load reads environment variables and returns a validated Config.
func Load() (*Config, error) {
	dbURL := os.Getenv("DATABASE_URL")
	if dbURL == "" {
		return nil, fmt.Errorf("DATABASE_URL is required")
	}

	redisURL := os.Getenv("REDIS_URL")
	if redisURL == "" {
		return nil, fmt.Errorf("REDIS_URL is required")
	}

	port := os.Getenv("TRACKER_PORT")
	if port == "" {
		port = "8082"
	}

	return &Config{
		Port:        port,
		DatabaseURL: dbURL,
		RedisURL:    redisURL,
	}, nil
}
