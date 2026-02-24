"""Async Redis publisher for profile-service."""

from __future__ import annotations

import json
import logging

import redis.asyncio as aioredis

import config

logger = logging.getLogger(__name__)

_client: aioredis.Redis | None = None


def get_client() -> aioredis.Redis:
    global _client
    if _client is None:
        _client = aioredis.from_url(config.REDIS_URL, decode_responses=True)
    return _client


async def publish(channel: str, payload: dict) -> None:
    try:
        await get_client().publish(channel, json.dumps(payload))
    except Exception as exc:
        logger.warning("Redis publish failed channel=%s err=%s", channel, exc)
