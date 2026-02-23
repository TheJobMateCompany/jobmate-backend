"""
jobmate-ai-coach-service — Phase 3

Startup sequence:
  1. Validate required environment variables (config.py — fail-fast)
  2. Open asyncpg connection pool (database.py)
  3. Open Redis async connection (redis_consumer.py)
  4. Spawn CMD_ANALYZE_JOB subscriber as a background task (redis_consumer.py)
  5. Expose /health endpoint

On CMD_ANALYZE_JOB:
  - Fetch application + job_feed + profile from PostgreSQL
  - Run MatchScore (keyword matching, deterministic)
  - Call OpenRouter LLM for Pros/Cons, Cover Letter, CV suggestions
  - Write ai_analysis + generated_cover_letter back to applications
  - Publish EVENT_ANALYSIS_DONE for the Gateway SSE stream
"""

import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI

# config import is the fail-fast check — raises RuntimeError if any required
# env var is missing, which prevents the service from starting with bad config.
from config import AI_COACH_PORT, SERVICE_VERSION
import database
import redis_consumer

logging.basicConfig(
    level=logging.INFO,
    format="[ai-coach-service] %(asctime)s %(levelname)s %(message)s",
)
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
    try:
        await consumer_task
    except asyncio.CancelledError:
        pass

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


if __name__ == "__main__":
    port = int(os.getenv("AI_COACH_PORT", 8083))
    logger.info(f"Starting on port {port}")
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=False)
