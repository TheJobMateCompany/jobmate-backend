"""URL scraper: fetch a job page and extract structured data using BeautifulSoup."""

from __future__ import annotations

import logging
import re

import httpx
from bs4 import BeautifulSoup

logger = logging.getLogger(__name__)

HTTP_TIMEOUT = 20.0
MAX_DESC_LEN = 5000


async def extract_job_from_url(url: str) -> dict:
    """
    Fetch the given URL and extract job data.
    Returns a dict with keys: title, description, company_name, location, source_url.
    Falls back to empty strings on failure.
    """
    try:
        async with httpx.AsyncClient(
            follow_redirects=True, timeout=HTTP_TIMEOUT
        ) as client:
            resp = await client.get(url, headers={"User-Agent": "JobmateBot/1.0"})
            resp.raise_for_status()
            html = resp.text
    except Exception as exc:
        logger.warning("URL fetch failed url=%s err=%s", url, exc)
        return _empty(url)

    try:
        return _parse(html, url)
    except Exception as exc:
        logger.warning("HTML parse failed url=%s err=%s", url, exc)
        return _empty(url)


def _parse(html: str, url: str) -> dict:
    soup = BeautifulSoup(html, "lxml")

    # Title: prefer og:title > <title> > h1
    title = _meta(soup, "og:title") or _text(soup, "title") or _text(soup, "h1") or ""
    title = _clean(title)[:200]

    # Company: common selectors used by job boards
    company = (
        _meta(soup, "og:site_name")
        or _attr(soup, "[itemprop='hiringOrganization'] [itemprop='name']", "content")
        or _text(soup, "[itemprop='hiringOrganization']")
        or ""
    )
    company = _clean(company)[:200]

    # Location
    location = (
        _attr(soup, "[itemprop='jobLocation']", "content")
        or _text(soup, "[itemprop='jobLocation']")
        or ""
    )
    location = _clean(location)[:200]

    # Description: og:description > itemprop > <article> > <main>
    description = (
        _meta(soup, "og:description")
        or _text(soup, "[itemprop='description']")
        or _text(soup, "article")
        or _text(soup, "main")
        or ""
    )
    description = _clean(description)[:MAX_DESC_LEN]

    return {
        "title": title,
        "description": description,
        "company_name": company,
        "location": location,
        "source_url": url,
    }


def _empty(url: str) -> dict:
    return {
        "title": "",
        "description": "",
        "company_name": "",
        "location": "",
        "source_url": url,
    }


def _clean(s: str) -> str:
    return re.sub(r"\s+", " ", s).strip()


def _meta(soup: BeautifulSoup, prop: str) -> str:
    tag = soup.find("meta", property=prop) or soup.find("meta", attrs={"name": prop})
    return (tag.get("content") or "") if tag else ""


def _text(soup: BeautifulSoup, selector: str) -> str:
    tag = soup.select_one(selector)
    return tag.get_text(separator=" ") if tag else ""


def _attr(soup: BeautifulSoup, selector: str, attr: str) -> str:
    tag = soup.select_one(selector)
    return (tag.get(attr) or "") if tag else ""
