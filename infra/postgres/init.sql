-- ─────────────────────────────────────────────────────────────
-- JobMate — PostgreSQL Schema Initialization
-- Executed once on first container start via docker-entrypoint-initdb.d/
-- ─────────────────────────────────────────────────────────────

-- Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";   -- uuid_generate_v4()
CREATE EXTENSION IF NOT EXISTS "pg_trgm";      -- Fast ILIKE / similarity search on text columns

-- ─────────────────────────────────────────────────────────────
-- ENUM Types
-- ─────────────────────────────────────────────────────────────

CREATE TYPE job_status AS ENUM (
  'PENDING',    -- Freshly scraped, awaiting user triage
  'APPROVED',   -- User approved → triggers AI analysis
  'REJECTED'    -- User rejected → cleaned up by TTL job
);

CREATE TYPE application_status AS ENUM (
  'TO_APPLY',   -- Approved but not yet applied
  'APPLIED',    -- Application sent
  'INTERVIEW',  -- Interview scheduled
  'OFFER',      -- Offer received
  'REJECTED',   -- Application rejected
  'HIRED'       -- Accepted offer — triggers search archival
);

CREATE TYPE remote_policy AS ENUM (
  'REMOTE',
  'HYBRID',
  'ON_SITE'
);

CREATE TYPE profile_status AS ENUM (
  'STUDENT',
  'JUNIOR',
  'MID',
  'SENIOR',
  'OPEN_TO_WORK'
);

-- ─────────────────────────────────────────────────────────────
-- users
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email         VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────────
-- profiles
-- One-to-one with users. Holds the candidate's full professional DNA.
-- skills_json, experience_json, etc. are populated by the CV parser (Python).
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS profiles (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  full_name       VARCHAR(255),
  status          profile_status,
  skills_json     JSONB NOT NULL DEFAULT '[]',     -- [{ "name": "React", "level": "expert" }]
  experience_json JSONB NOT NULL DEFAULT '[]',     -- [{ "title": "...", "company": "...", ... }]
  projects_json   JSONB NOT NULL DEFAULT '[]',     -- [{ "name": "...", "description": "...", ... }]
  education_json  JSONB NOT NULL DEFAULT '[]',     -- [{ "degree": "...", "school": "...", ... }]
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────────
-- search_configs
-- A saved job search configuration. The Discovery Service polls active ones.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS search_configs (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_titles    TEXT[]        NOT NULL DEFAULT '{}',   -- ["Software Engineer", "Fullstack Dev"]
  locations     TEXT[]        NOT NULL DEFAULT '{}',   -- ["Paris", "Lyon", "Remote"]
  remote_policy remote_policy NOT NULL DEFAULT 'HYBRID',
  keywords      TEXT[]        NOT NULL DEFAULT '{}',   -- must-have tech terms ["React", "Go"]
  red_flags     TEXT[]        NOT NULL DEFAULT '{}',   -- exclusion terms ["ESN", "Stage"]
  salary_min    INT,                                   -- Annual, in local currency (€)
  salary_max    INT,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────────
-- job_feed
-- The "Inbox" / triage queue populated by the Discovery Service.
-- TTL enforced via expires_at — a cleanup cron job DELETEs expired rows.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS job_feed (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  search_config_id UUID NOT NULL REFERENCES search_configs(id) ON DELETE CASCADE,
  raw_data         JSONB NOT NULL,          -- Full scraped job offer payload
  source_url       TEXT,                   -- Original URL of the job posting
  status           job_status NOT NULL DEFAULT 'PENDING',
  expires_at       TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '30 days'),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────────
-- applications
-- Active candidatures post-approval. The CRM Kanban data model.
-- ai_analysis is populated asynchronously by the AI Coach Service.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS applications (
  id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id                 UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_feed_id             UUID REFERENCES job_feed(id) ON DELETE SET NULL,
  current_status          application_status NOT NULL DEFAULT 'TO_APPLY',
  ai_analysis             JSONB NOT NULL DEFAULT '{}',
  -- Structure: { "score": 85, "pros": [...], "cons": [...], "suggested_cv_content": "..." }
  generated_cover_letter  TEXT,
  user_notes              TEXT,
  user_rating             SMALLINT CHECK (user_rating BETWEEN 1 AND 5),
  history_log             JSONB NOT NULL DEFAULT '[]',
  -- Structure: [{ "from": "TO_APPLY", "to": "APPLIED", "at": "2026-01-01T10:00:00Z" }]
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- One application per user per job feed item
  UNIQUE (user_id, job_feed_id)
);

-- ─────────────────────────────────────────────────────────────
-- Indexes
-- ─────────────────────────────────────────────────────────────

-- profiles
CREATE INDEX IF NOT EXISTS idx_profiles_user_id
  ON profiles (user_id);

-- search_configs
CREATE INDEX IF NOT EXISTS idx_search_configs_user_id
  ON search_configs (user_id);

CREATE INDEX IF NOT EXISTS idx_search_configs_active
  ON search_configs (is_active)
  WHERE is_active = TRUE;

-- job_feed
CREATE INDEX IF NOT EXISTS idx_job_feed_search_config_id
  ON job_feed (search_config_id);

CREATE INDEX IF NOT EXISTS idx_job_feed_status
  ON job_feed (status);

CREATE INDEX IF NOT EXISTS idx_job_feed_expires_at
  ON job_feed (expires_at);

-- applications
CREATE INDEX IF NOT EXISTS idx_applications_user_id
  ON applications (user_id);

CREATE INDEX IF NOT EXISTS idx_applications_current_status
  ON applications (current_status);

CREATE INDEX IF NOT EXISTS idx_applications_job_feed_id
  ON applications (job_feed_id);

-- ─────────────────────────────────────────────────────────────
-- update_updated_at trigger helper
-- Automatically refreshes updated_at on row modification
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION trigger_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER set_updated_at_users
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

CREATE TRIGGER set_updated_at_profiles
  BEFORE UPDATE ON profiles
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

CREATE TRIGGER set_updated_at_search_configs
  BEFORE UPDATE ON search_configs
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

CREATE TRIGGER set_updated_at_applications
  BEFORE UPDATE ON applications
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
