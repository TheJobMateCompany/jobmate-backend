"""asyncpg connection pool with retry logic."""

from __future__ import annotations

import asyncio
import logging

import asyncpg

import config

logger = logging.getLogger(__name__)

_pool: asyncpg.Pool | None = None


async def get_pool() -> asyncpg.Pool:
    """Return the shared connection pool, creating it if necessary."""
    global _pool
    if _pool is None:
        _pool = await _create_pool()
    return _pool


async def _create_pool(retries: int = 10, delay: float = 2.0) -> asyncpg.Pool:
    for attempt in range(1, retries + 1):
        try:
            pool = await asyncpg.create_pool(
                config.DATABASE_URL, min_size=2, max_size=10
            )
            logger.info("Database pool created")
            return pool
        except Exception as exc:
            logger.warning(
                "DB connection attempt %d/%d failed: %s", attempt, retries, exc
            )
            if attempt == retries:
                raise
            await asyncio.sleep(delay)
    raise RuntimeError("unreachable")


async def close_pool() -> None:
    global _pool
    if _pool:
        await _pool.close()
        _pool = None
