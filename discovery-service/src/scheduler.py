"""APScheduler setup for periodic Adzuna scraping."""

from __future__ import annotations

import asyncio
import logging

from apscheduler.schedulers.asyncio import AsyncIOScheduler

import config
import scraper

logger = logging.getLogger(__name__)

_scheduler: AsyncIOScheduler | None = None


async def _run_scrape() -> None:
    logger.info("Scheduled scrape starting")
    try:
        await scraper.run_all()
    except Exception as exc:
        logger.error("Scheduled scrape error: %s", exc)


def start() -> AsyncIOScheduler:
    global _scheduler
    _scheduler = AsyncIOScheduler()
    _scheduler.add_job(
        _run_scrape,
        trigger="interval",
        hours=config.SCRAPE_INTERVAL_HOURS,
        id="adzuna_scrape",
        replace_existing=True,
    )
    _scheduler.start()
    logger.info("Scheduler started (interval=%sh)", config.SCRAPE_INTERVAL_HOURS)
    return _scheduler


def stop() -> None:
    if _scheduler and _scheduler.running:
        _scheduler.shutdown(wait=False)
