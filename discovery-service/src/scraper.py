"""Adzuna job scraper — ported from Go discovery-service."""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field

import httpx

import config
import database
import redis_client

logger = logging.getLogger(__name__)

ADZUNA_BASE = "https://api.adzuna.com/v1/api/jobs"
PAGE_SIZE = 50
MAX_PAGES = 3
HTTP_TIMEOUT = 15.0


@dataclass
class JobResult:
    external_id: str
    title: str
    description: str
    company_name: str
    location: str
    salary_min: float
    salary_max: float
    source_url: str
    raw_data: dict = field(default_factory=dict)


def _has_red_flag(text: str) -> bool:
    lower = text.lower()
    return any(kw in lower for kw in config.RED_FLAG_KEYWORDS)


async def _fetch_page(
    client: httpx.AsyncClient, job_title: str, location: str, page: int
) -> list[JobResult]:
    if not config.ADZUNA_APP_ID or not config.ADZUNA_APP_KEY:
        return []

    params = {
        "app_id": config.ADZUNA_APP_ID,
        "app_key": config.ADZUNA_APP_KEY,
        "results_per_page": PAGE_SIZE,
        "what": job_title,
        "where": location,
        "content-type": "application/json",
    }
    url = f"{ADZUNA_BASE}/{config.ADZUNA_COUNTRY}/search/{page}"
    try:
        resp = await client.get(url, params=params, timeout=HTTP_TIMEOUT)
        resp.raise_for_status()
        data = resp.json()
    except Exception as exc:
        logger.warning("Adzuna fetch error page=%d: %s", page, exc)
        return []

    results: list[JobResult] = []
    for r in data.get("results", []):
        results.append(
            JobResult(
                external_id=str(r.get("id", "")),
                title=r.get("title", ""),
                description=r.get("description", ""),
                company_name=(r.get("company") or {}).get("display_name", ""),
                location=(r.get("location") or {}).get("display_name", ""),
                salary_min=float(r.get("salary_min") or 0),
                salary_max=float(r.get("salary_max") or 0),
                source_url=r.get("redirect_url", ""),
                raw_data=r,
            )
        )
    return results


async def _fetch_all(job_title: str, location: str) -> list[JobResult]:
    async with httpx.AsyncClient() as client:
        results: list[JobResult] = []
        for page in range(1, MAX_PAGES + 1):
            batch = await _fetch_page(client, job_title, location, page)
            results.extend(batch)
            if len(batch) < PAGE_SIZE:
                break
        return results


async def _upsert_job(pool, job: JobResult, search_config_id: str | None) -> str | None:
    """
    Insert a job into job_feed, skipping if the source_url already exists.
    Returns the new job_feed row id, or None if skipped.
    """
    row = await pool.fetchrow(
        """
        INSERT INTO job_feed
          (search_config_id, title, description, source_url, salary_min, salary_max,
           status, raw_data, company_name, is_manual)
        VALUES ($1, $2, $3, $4, $5, $6, 'PENDING', $7, $8, FALSE)
        ON CONFLICT (source_url) DO NOTHING
        RETURNING id
        """,
        search_config_id,
        job.title,
        job.description,
        job.source_url,
        int(job.salary_min),
        int(job.salary_max),
        json.dumps(job.raw_data),
        job.company_name or None,
    )
    return str(row["id"]) if row else None


async def run_for_config(
    search_config_id: str, user_id: str, job_titles: list[str], locations: list[str]
) -> int:
    """
    Scrape Adzuna for a specific search config and insert results.
    Returns the number of new jobs inserted.
    """
    pool = await database.get_pool()
    inserted = 0

    for title in job_titles:
        for location in locations:
            jobs = await _fetch_all(title, location)
            for job in jobs:
                combined = f"{job.title} {job.description}"
                if _has_red_flag(combined):
                    logger.debug("Red flag filtered: %s", job.title)
                    continue
                jid = await _upsert_job(pool, job, search_config_id)
                if jid:
                    inserted += 1
                    await redis_client.publish(
                        "EVENT_JOB_DISCOVERED",
                        {
                            "jobFeedId": jid,
                            "userId": user_id,
                            "searchConfigId": search_config_id,
                        },
                    )

    logger.info("Scrape done config=%s inserted=%d", search_config_id, inserted)
    return inserted


async def run_all() -> None:
    """Automatic scheduled scrape: iterate all active search configs."""
    pool = await database.get_pool()
    rows = await pool.fetch(
        """
        SELECT sc.id, p.user_id, sc.job_titles, sc.locations
        FROM search_configs sc
        JOIN profiles p ON p.user_id = sc.user_id
        WHERE sc.is_active = TRUE
        """,
    )
    logger.info("Scheduled scrape: %d active configs", len(rows))
    for row in rows:
        await run_for_config(
            search_config_id=str(row["id"]),
            user_id=str(row["user_id"]),
            job_titles=list(row["job_titles"] or []),
            locations=list(row["locations"] or []),
        )
