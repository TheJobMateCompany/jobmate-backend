"""
Redis Pub/Sub consumer.

Subscribes to CMD_ANALYZE_JOB and dispatches each message to the analyzer.

Expected message payload (JSON):
    {
        "applicationId": "<uuid>",
        "userId":        "<uuid>",
        "jobFeedId":     "<uuid>"
    }
"""

import asyncio
import json
import logging

import redis.asyncio as aioredis

import analyzer
from config import REDIS_URL

logger = logging.getLogger(__name__)

CHANNEL = "CMD_ANALYZE_JOB"


async def start(rdb: aioredis.Redis) -> None:
    """
    Long-running coroutine that listens on CMD_ANALYZE_JOB forever.
    Should be run as an asyncio task.
    """
    pubsub = rdb.pubsub()
    await pubsub.subscribe(CHANNEL)
    logger.info("Subscribed to Redis channel: %s", CHANNEL)

    async for message in pubsub.listen():
        if message["type"] != "message":
            continue

        raw = message.get("data", b"")
        if isinstance(raw, bytes):
            raw = raw.decode("utf-8")

        logger.info("Received %s: %s", CHANNEL, raw[:200])

        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            logger.error("Invalid JSON payload: %s", raw)
            continue

        application_id = payload.get("applicationId")
        user_id = payload.get("userId")

        if not application_id or not user_id:
            logger.error("Missing applicationId or userId in payload: %s", payload)
            continue

        # Run analysis in a separate task so subscriber loop stays responsive
        asyncio.create_task(
            _safe_analyze(application_id, user_id, rdb),
            name=f"analyze-{application_id}",
        )


async def _safe_analyze(application_id: str, user_id: str, rdb: aioredis.Redis) -> None:
    """Wrapper that catches and logs any exception from the analyzer."""
    try:
        await analyzer.analyze(application_id, user_id, rdb)
    except Exception as exc:
        logger.exception(
            "Unhandled error analyzing application %s: %s", application_id, exc
        )


async def create_redis_client() -> aioredis.Redis:
    """Create and verify an async Redis connection."""
    logger.info("Connecting Redis consumer to %s…", REDIS_URL)
    rdb = await aioredis.from_url(REDIS_URL, decode_responses=False)
    await rdb.ping()
    logger.info("Redis consumer connected ✓")
    return rdb
