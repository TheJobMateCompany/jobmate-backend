-- Migration 001 — Add title & description columns to job_feed
-- Run once on an existing database (init.sql already includes them for fresh setups).
-- Safe to run multiple times (IF NOT EXISTS / idempotent).

ALTER TABLE job_feed
  ADD COLUMN IF NOT EXISTS title       VARCHAR(512),
  ADD COLUMN IF NOT EXISTS description TEXT;

-- Optional: index title for fast ORDER BY / LIKE queries
CREATE INDEX IF NOT EXISTS idx_job_feed_title ON job_feed (title);
