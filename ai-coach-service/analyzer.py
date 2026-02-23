"""
Analyzer — main AI pipeline for a single job application.

Flow triggered by CMD_ANALYZE_JOB:
  1. Fetch application + job_feed + profile from PostgreSQL
  2. Compute MatchScore (keyword-based, deterministic)
  3. LLM: generate Pros/Cons
  4. LLM: generate cover letter
  5. LLM: generate ATS CV suggestions
  6. Write ai_analysis + generated_cover_letter to applications table
  7. Publish EVENT_ANALYSIS_DONE to Redis → Gateway → SSE → client
"""

import json
import logging
from datetime import datetime, timezone

import asyncpg

import llm
import match_score as ms
import prompts
from database import get_pool

logger = logging.getLogger(__name__)


async def analyze(application_id: str, user_id: str, rdb) -> None:
    """
    Full analysis pipeline for one application.

    Args:
        application_id: UUID of the applications row.
        user_id:        UUID of the owning user (for publishing SSE event).
        rdb:            Connected redis.asyncio client for publishing.
    """
    pool = get_pool()

    # ── 1. Fetch all required data in one query ─────────────────
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT
                a.id               AS app_id,
                a.user_id,
                jf.raw_data        AS job_raw_data,
                jf.source_url      AS job_url,
                p.full_name,
                p.skills_json      AS skills,
                p.experience_json  AS experience
            FROM applications a
            JOIN job_feed jf   ON jf.id = a.job_feed_id
            JOIN profiles p    ON p.user_id = a.user_id
            WHERE a.id = $1 AND a.user_id = $2
            """,
            application_id,
            user_id,
        )

    if row is None:
        logger.error(
            "Application %s not found for user %s — aborting.", application_id, user_id
        )
        return

    # Deserialise JSONB fields
    raw_data: dict = dict(row["job_raw_data"]) if row["job_raw_data"] else {}
    skills: list = _load_json(row["skills"])
    experience: list = _load_json(row["experience"])

    job_title: str = raw_data.get("title", "Unknown position")
    company: str = raw_data.get("company", "Unknown company")
    description: str = raw_data.get("description", "")
    full_name: str = row["full_name"] or ""
    skills_flat: list[str] = _flatten_skills(skills)

    logger.info(
        "Analyzing application %s — '%s' at '%s'", application_id, job_title, company
    )

    # ── 2. MatchScore (fast, synchronous) ──────────────────────
    score = ms.compute(skills, experience, raw_data)
    logger.info("MatchScore = %d/100", score)

    # ── 3. LLM: Pros / Cons ────────────────────────────────────
    sys_p, usr_p = prompts.pros_cons_prompt(
        job_title, description, company, skills_flat, experience, score
    )
    pros_cons = await llm.chat_json(sys_p, usr_p, temperature=0.3)
    pros: list[str] = (pros_cons or {}).get("pros", [])
    cons: list[str] = (pros_cons or {}).get("cons", [])

    # ── 4. LLM: Cover Letter ───────────────────────────────────
    sys_cl, usr_cl = prompts.cover_letter_prompt(
        job_title, company, description, full_name, skills_flat, experience
    )
    cover_letter: str | None = await llm.chat_text(sys_cl, usr_cl, temperature=0.7)

    # ── 5. LLM: CV Suggestions ─────────────────────────────────
    sys_cv, usr_cv = prompts.cv_suggestions_prompt(job_title, description, skills_flat)
    cv_result = await llm.chat_json(sys_cv, usr_cv, temperature=0.3)
    cv_suggestions: list[str] = (cv_result or {}).get("suggestions", [])

    # ── 6. Write results to DB ─────────────────────────────────
    ai_analysis = {
        "score": score,
        "pros": pros,
        "cons": cons,
        "suggested_cv_content": "\n".join(f"• {s}" for s in cv_suggestions),
        "analyzed_at": datetime.now(timezone.utc).isoformat(),
    }

    async with pool.acquire() as conn:
        await conn.execute(
            """
            UPDATE applications
            SET
                ai_analysis            = $1::jsonb,
                generated_cover_letter = $2,
                updated_at             = NOW()
            WHERE id = $3
            """,
            json.dumps(ai_analysis),
            cover_letter,
            application_id,
        )

    logger.info("Analysis written to DB for application %s", application_id)

    # ── 7. Publish EVENT_ANALYSIS_DONE ─────────────────────────
    event_payload = json.dumps(
        {
            "type": "EVENT_ANALYSIS_DONE",
            "applicationId": application_id,
            "userId": user_id,
            "matchScore": score,
            "hasCoverLetter": cover_letter is not None,
            "analyzedAt": ai_analysis["analyzed_at"],
        }
    )
    await rdb.publish("EVENT_ANALYSIS_DONE", event_payload)
    logger.info("EVENT_ANALYSIS_DONE published for application %s", application_id)


# ── Helpers ────────────────────────────────────────────────────


def _load_json(value) -> list:
    if value is None:
        return []
    if isinstance(value, (list, dict)):
        return value if isinstance(value, list) else [value]
    try:
        return json.loads(value)
    except (json.JSONDecodeError, TypeError):
        return []


def _flatten_skills(skills: list) -> list[str]:
    """Normalise skills to a flat list of strings."""
    result = []
    for s in skills:
        if isinstance(s, str):
            result.append(s)
        elif isinstance(s, dict):
            name = s.get("name", "")
            if name:
                result.append(name)
    return result
