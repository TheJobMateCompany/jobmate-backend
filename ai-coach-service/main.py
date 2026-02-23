"""
jobmate-ai-coach-service — Stub placeholder

TODO:
  - Subscribe to Redis channel `CMD_ANALYZE_JOB`
  - On message: fetch application from PostgreSQL, run MatchScore + LLM generation
  - Write ai_analysis + generated_cover_letter back to applications table
  - Publish `EVENT_ANALYSIS_DONE` to Redis for the Gateway to forward via SSE
"""

import asyncio
import logging
import os

from fastapi import FastAPI
import uvicorn

logging.basicConfig(
    level=logging.INFO,
    format="[ai-coach-service] %(asctime)s %(levelname)s %(message)s",
)
logger = logging.getLogger(__name__)

app = FastAPI(title="jobmate-ai-coach-service", version="0.1.0")


@app.get("/health")
async def health():
    return {"status": "ok", "service": "ai-coach-service", "version": "0.1.0"}


async def redis_listener():
    """
    Long-running coroutine that consumes CMD_ANALYZE_JOB events from Redis Pub/Sub.
    Placeholder: logs the channel subscription and waits.
    """
    redis_url = os.getenv("REDIS_URL", "redis://redis:6379")
    logger.info(f"Redis listener starting — connecting to {redis_url}")
    # TODO: import redis.asyncio as aioredis
    #       async with aioredis.from_url(redis_url) as r:
    #           pubsub = r.pubsub()
    #           await pubsub.subscribe("CMD_ANALYZE_JOB")
    #           async for message in pubsub.listen():
    #               await handle_analyze_job(message)
    logger.info("Redis listener stub active (no-op).")
    while True:
        await asyncio.sleep(60)


async def lifespan(application: FastAPI):
    # Start background Redis listener on app startup
    task = asyncio.create_task(redis_listener())
    yield
    task.cancel()


app.router.lifespan_context = lifespan


if __name__ == "__main__":
    port = int(os.getenv("AI_COACH_PORT", 8083))
    logger.info(f"Starting on port {port}")
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=False)
