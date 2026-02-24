"""
jobmate-ai-coach-service — Phase 3

Startup sequence:
  1. Validate required environment variables (config.py — fail-fast)
  2. Open asyncpg connection pool (database.py)
  3. Open Redis async connection (redis_consumer.py)
  4. Spawn Redis subscriber as a background task (redis_consumer.py)
  5. Expose /health endpoint

On CMD_ANALYZE_JOB:
  - Fetch application + job_feed + profile from PostgreSQL
  - Run MatchScore (keyword matching, deterministic)
  - Call OpenRouter LLM for Pros/Cons, Cover Letter, CV suggestions
  - Write ai_analysis + generated_cover_letter back to applications
  - Publish EVENT_ANALYSIS_DONE for the Gateway SSE stream

On CMD_PARSE_CV:
  - Extract text from uploaded PDF using pdfminer.six
  - Call LLM to extract skills, experience, education, certifications, projects
  - PATCH the profiles table with the extracted structured data
  - Publish EVENT_CV_PARSED for the Gateway SSE stream
"""

import asyncio
import logging
import logging.config
from contextlib import asynccontextmanager, suppress

from fastapi import FastAPI
from pythonjsonlogger import jsonlogger

import database
import redis_consumer
from config import AI_COACH_PORT, SERVICE_VERSION


# ── JSON structured logging ────────────────────────────────
def _configure_json_logging() -> None:
    handler = logging.StreamHandler()
    formatter = jsonlogger.JsonFormatter(
        fmt="%(asctime)s %(name)s %(levelname)s %(message)s",
        datefmt="%Y-%m-%dT%H:%M:%S",
        rename_fields={"levelname": "level", "asctime": "time"},
        static_fields={"service": "ai-coach-service", "version": SERVICE_VERSION},
    )
    handler.setFormatter(formatter)
    root = logging.getLogger()
    root.handlers = [handler]
    root.setLevel(logging.INFO)


_configure_json_logging()
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(application: FastAPI):
    # ── Startup ───────────────────────────────────────────────────────────────
    logger.info("ai-coach-service %s starting…", SERVICE_VERSION)

    await database.create_pool()

    rdb = await redis_consumer.create_redis_client()

    consumer_task = asyncio.create_task(
        redis_consumer.start(rdb),
        name="redis-consumer",
    )
    logger.info("ai-coach-service ready ✓")

    yield

    # ── Shutdown ──────────────────────────────────────────────────────────────
    logger.info("ai-coach-service shutting down…")
    consumer_task.cancel()
    with suppress(asyncio.CancelledError):
        await consumer_task

    await database.close_pool()
    await rdb.aclose()
    logger.info("ai-coach-service stopped.")


app = FastAPI(
    title="jobmate-ai-coach-service",
    version=SERVICE_VERSION,
    lifespan=lifespan,
)


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "service": "ai-coach-service",
        "version": SERVICE_VERSION,
    }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=int(AI_COACH_PORT),
        log_level="info",
    )
