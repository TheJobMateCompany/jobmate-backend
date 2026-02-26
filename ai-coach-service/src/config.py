"""
Fail-fast configuration loader for the AI Coach Service.
Every required variable raises at import time if missing.
"""

import os


def _require(key: str) -> str:
    value = os.getenv(key, "").strip()
    if not value:
        raise RuntimeError(f"[ai-coach-service] Required env var '{key}' is not set.")
    return value


def _optional(key: str, default: str = "") -> str:
    return os.getenv(key, default).strip()


def _optional_int(key: str, default: int) -> int:
    raw = os.getenv(key, str(default)).strip()
    try:
        return int(raw)
    except ValueError as err:
        raise RuntimeError(
            f"[ai-coach-service] Env var '{key}' must be an integer, got '{raw}'."
        ) from err


# ── PostgreSQL ─────────────────────────────────────────────────
DATABASE_URL: str = _require("DATABASE_URL")

# ── Redis ──────────────────────────────────────────────────────
REDIS_URL: str = _require("REDIS_URL")

# ── OpenRouter ─────────────────────────────────────────────────
OPENROUTER_API_KEY: str = _optional("OPENROUTER_API_KEY")
OPENROUTER_BASE_URL: str = _optional(
    "OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1"
)
OPENROUTER_MODEL: str = _optional(
    "OPENROUTER_MODEL", "meta-llama/llama-3.3-70b-instruct"
)
OPENROUTER_TIMEOUT_SECONDS: int = _optional_int("OPENROUTER_TIMEOUT_SECONDS", 45)
ANALYSIS_TIMEOUT_SECONDS: int = _optional_int("ANALYSIS_TIMEOUT_SECONDS", 120)

# ── Service ────────────────────────────────────────────────────
AI_COACH_PORT: int = int(_optional("AI_COACH_PORT", "8083"))
SERVICE_VERSION: str = "1.0.0"
