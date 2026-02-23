// Package config loads and validates environment variables at startup.
// Fail-fast: if a required variable is missing, the process exits.
package config

import (
	"fmt"
	"os"
	"strconv"
)

// Config holds all runtime configuration for the discovery service.
type Config struct {
	Port                string
	DatabaseURL         string
	RedisURL            string
	AdzunaAppID         string
	AdzunaAppKey        string
	AdzunaCountry       string // e.g. "fr", "gb", "us"
	ScrapeIntervalHours int    // How often the cron job fires
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

	interval := 6
	if s := os.Getenv("SCRAPE_INTERVAL_HOURS"); s != "" {
		v, err := strconv.Atoi(s)
		if err != nil || v < 1 {
			return nil, fmt.Errorf("SCRAPE_INTERVAL_HOURS must be a positive integer, got %q", s)
		}
		interval = v
	}

	country := os.Getenv("ADZUNA_COUNTRY")
	if country == "" {
		country = "fr"
	}

	port := os.Getenv("DISCOVERY_PORT")
	if port == "" {
		port = "8081"
	}

	return &Config{
		Port:                port,
		DatabaseURL:         dbURL,
		RedisURL:            redisURL,
		AdzunaAppID:         os.Getenv("ADZUNA_APP_ID"),
		AdzunaAppKey:        os.Getenv("ADZUNA_APP_KEY"),
		AdzunaCountry:       country,
		ScrapeIntervalHours: interval,
	}, nil
}
