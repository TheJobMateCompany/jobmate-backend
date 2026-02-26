"""
Redis Pub/Sub consumer.

Subscribes to:
  - CMD_ANALYZE_JOB  → analyzer.analyze(applicationId, userId)
  - CMD_PARSE_CV     → cv_parser.parse(userId, cvUrl)

Message payloads (JSON):

  CMD_ANALYZE_JOB:
    { "applicationId": "<uuid>", "userId": "<uuid>", "jobFeedId": "<uuid>" }

  CMD_PARSE_CV:
    { "userId": "<uuid>", "cvUrl": "<relative-path>" }
"""

import asyncio
import json
import logging

import redis.asyncio as aioredis

import analyzer
import cv_parser
from config import ANALYSIS_TIMEOUT_SECONDS, REDIS_URL

logger = logging.getLogger(__name__)

CHANNELS = ["CMD_ANALYZE_JOB", "CMD_PARSE_CV"]


async def start(rdb: aioredis.Redis) -> None:
    """
    Long-running coroutine that listens on all command channels forever.
    Should be run as an asyncio task.
    """
    pubsub = rdb.pubsub()
    await pubsub.subscribe(*CHANNELS)
    logger.info("Subscribed to Redis channels: %s", CHANNELS)

    async for message in pubsub.listen():
        if message["type"] != "message":
            continue

        channel = message.get("channel", b"")
        if isinstance(channel, bytes):
            channel = channel.decode("utf-8")

        raw = message.get("data", b"")
        if isinstance(raw, bytes):
            raw = raw.decode("utf-8")

        logger.info("Received [%s]: %s", channel, raw[:200])

        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            logger.error("Invalid JSON on channel %s: %s", channel, raw)
            continue

        if channel == "CMD_ANALYZE_JOB":
            _dispatch_analyze(payload, rdb)
        elif channel == "CMD_PARSE_CV":
            _dispatch_parse_cv(payload, rdb)
        else:
            logger.warning("Unhandled channel: %s", channel)


# ─── Dispatchers ─────────────────────────────────────────────────────────────


def _dispatch_analyze(payload: dict, rdb: aioredis.Redis) -> None:
    application_id = payload.get("applicationId")
    user_id = payload.get("userId")

    if not application_id or not user_id:
        logger.error("CMD_ANALYZE_JOB missing required fields: %s", payload)
        return

    asyncio.create_task(
        _safe_analyze(application_id, user_id, rdb),
        name=f"analyze-{application_id}",
    )


def _dispatch_parse_cv(payload: dict, rdb: aioredis.Redis) -> None:
    user_id = payload.get("userId")
    cv_url = payload.get("cvUrl")

    if not user_id or not cv_url:
        logger.error("CMD_PARSE_CV missing required fields: %s", payload)
        return

    asyncio.create_task(
        _safe_parse_cv(user_id, cv_url, rdb),
        name=f"parse-cv-{user_id}",
    )


# ─── Safe wrappers ────────────────────────────────────────────────────────────


async def _safe_analyze(application_id: str, user_id: str, rdb: aioredis.Redis) -> None:
    """Wrapper that catches and logs any exception from the analyzer."""
    try:
        await asyncio.wait_for(
            analyzer.analyze(application_id, user_id, rdb),
            timeout=ANALYSIS_TIMEOUT_SECONDS,
        )
    except asyncio.TimeoutError:
        logger.error(
            "Analysis timeout after %ss for application %s",
            ANALYSIS_TIMEOUT_SECONDS,
            application_id,
        )
        await rdb.publish(
            "EVENT_ANALYSIS_DONE",
            json.dumps(
                {
                    "type": "EVENT_ANALYSIS_DONE",
                    "applicationId": application_id,
                    "userId": user_id,
                    "matchScore": None,
                    "hasCoverLetter": False,
                    "status": "timeout",
                    "error": "Analysis exceeded max duration",
                }
            ),
        )
    except Exception as exc:
        logger.exception(
            "Unhandled error analyzing application %s: %s", application_id, exc
        )
        await rdb.publish(
            "EVENT_ANALYSIS_DONE",
            json.dumps(
                {
                    "type": "EVENT_ANALYSIS_DONE",
                    "applicationId": application_id,
                    "userId": user_id,
                    "matchScore": None,
                    "hasCoverLetter": False,
                    "status": "error",
                    "error": "Analysis failed",
                }
            ),
        )


async def _safe_parse_cv(user_id: str, cv_url: str, rdb: aioredis.Redis) -> None:
    """Wrapper that catches and logs any exception from the CV parser."""
    try:
        await cv_parser.parse(user_id, cv_url, rdb)
    except Exception as exc:
        logger.exception("Unhandled error parsing CV for user %s: %s", user_id, exc)


async def create_redis_client() -> aioredis.Redis:
    """Create and verify an async Redis connection."""
    logger.info("Connecting Redis consumer to %s…", REDIS_URL)
    rdb = await aioredis.from_url(REDIS_URL, decode_responses=False)
    await rdb.ping()
    logger.info("Redis consumer connected ✓")
    return rdb
