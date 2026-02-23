package db

import (
	"context"
	"fmt"

	"github.com/redis/go-redis/v9"
)

// NewRedisClient parses redisURL and verifies connectivity.
func NewRedisClient(ctx context.Context, redisURL string) (*redis.Client, error) {
	opts, err := redis.ParseURL(redisURL)
	if err != nil {
		return nil, fmt.Errorf("redis.ParseURL(%q): %w", redisURL, err)
	}

	client := redis.NewClient(opts)
	if err := client.Ping(ctx).Err(); err != nil {
		return nil, fmt.Errorf("redis ping failed: %w", err)
	}

	return client, nil
}
