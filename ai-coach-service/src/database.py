"""
Async PostgreSQL connection pool via asyncpg.
The pool is created once at startup and shared across all coroutines.
"""

import logging

import asyncpg

from config import DATABASE_URL

logger = logging.getLogger(__name__)

_pool: asyncpg.Pool | None = None


async def create_pool() -> asyncpg.Pool:
    global _pool
    logger.info("Connecting to PostgreSQL…")
    _pool = await asyncpg.create_pool(
        DATABASE_URL,
        min_size=2,
        max_size=10,
        command_timeout=30,
    )
    # Verify connectivity
    async with _pool.acquire() as conn:
        await conn.fetchval("SELECT 1")
    logger.info("PostgreSQL connected ✓")
    return _pool


async def close_pool() -> None:
    global _pool
    if _pool:
        await _pool.close()
        logger.info("PostgreSQL pool closed.")


def get_pool() -> asyncpg.Pool:
    if _pool is None:
        raise RuntimeError("Database pool has not been initialised yet.")
    return _pool
