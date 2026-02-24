"""
CV Parser — AI Coach pipeline for CMD_PARSE_CV.

Flow:
  1. Read PDF bytes from disk (path provided in message payload)
  2. Extract raw text using pdfminer.six
  3. Call LLM to extract structured profile fields:
       skills_json, experience_json, education_json,
       certifications_json, projects_json
  4. PATCH the profiles table (only non-empty fields are overwritten)
  5. Publish EVENT_CV_PARSED → Gateway SSE → client

Expected CMD_PARSE_CV payload:
  { "userId": "<uuid>", "cvUrl": "<relative-path e.g. /uploads/abc.pdf>" }
"""

from __future__ import annotations

import json
import logging
import os

import redis.asyncio as aioredis
from pdfminer.high_level import extract_text

import llm
from database import get_pool

logger = logging.getLogger(__name__)

# Base directory where profile-service stores uploaded CVs.
# In production both services share the cv_uploads Docker volume.
UPLOAD_BASE = os.getenv("UPLOAD_DIR", "/app/uploads")


# ─── Public entry point ───────────────────────────────────────────────────────


async def parse(user_id: str, cv_url: str, rdb: aioredis.Redis) -> None:
    """
    Full CV parsing pipeline for one user.

    Args:
        user_id: UUID of the owning user.
        cv_url:  Relative path as stored in profiles.cv_url, e.g. "/uploads/abc.pdf".
        rdb:     Connected redis.asyncio client for publishing.
    """
    # ── 1. Resolve path ────────────────────────────────────────
    # cv_url is like "/uploads/<filename>"; strip the leading "/uploads"
    # and join with UPLOAD_BASE so we don't get double-slashes.
    filename = os.path.basename(cv_url)
    file_path = os.path.join(UPLOAD_BASE, filename)

    if not os.path.exists(file_path):
        logger.error("CV file not found: %s (resolved from %s)", file_path, cv_url)
        await _publish_error(rdb, user_id, "CV file not found on disk")
        return

    # ── 2. Extract text from PDF ───────────────────────────────
    try:
        text = extract_text(file_path)
    except Exception as exc:
        logger.error("PDF extraction failed for %s: %s", file_path, exc)
        await _publish_error(rdb, user_id, f"PDF extraction failed: {exc}")
        return

    if not text or not text.strip():
        logger.warning("Extracted empty text from %s", file_path)
        await _publish_error(rdb, user_id, "No readable text found in PDF")
        return

    text = text[:8000]  # cap to keep LLM context manageable
    logger.info("Extracted %d chars from CV for user %s", len(text), user_id)

    # ── 3. LLM: extract structured profile ────────────────────
    sys_p, usr_p = _cv_extract_prompt(text)
    parsed = await llm.chat_json(sys_p, usr_p, temperature=0.1)

    if not parsed:
        logger.error("LLM returned empty response for user %s CV", user_id)
        await _publish_error(rdb, user_id, "LLM failed to parse CV")
        return

    skills = parsed.get("skills") or []
    experience = parsed.get("experience") or []
    education = parsed.get("education") or []
    certifications = parsed.get("certifications") or []
    projects = parsed.get("projects") or []

    # ── 4. Write back to profiles table ───────────────────────
    pool = get_pool()
    async with pool.acquire() as conn:
        await conn.execute(
            """
            UPDATE profiles SET
                skills_json          = CASE WHEN $1::jsonb != '[]'::jsonb
                                            THEN $1::jsonb ELSE skills_json END,
                experience_json      = CASE WHEN $2::jsonb != '[]'::jsonb
                                            THEN $2::jsonb ELSE experience_json END,
                education_json       = CASE WHEN $3::jsonb != '[]'::jsonb
                                            THEN $3::jsonb ELSE education_json END,
                certifications_json  = CASE WHEN $4::jsonb != '[]'::jsonb
                                            THEN $4::jsonb ELSE certifications_json END,
                projects_json        = CASE WHEN $5::jsonb != '[]'::jsonb
                                            THEN $5::jsonb ELSE projects_json END,
                updated_at           = NOW()
            WHERE user_id = $6
            """,
            json.dumps(skills),
            json.dumps(experience),
            json.dumps(education),
            json.dumps(certifications),
            json.dumps(projects),
            user_id,
        )
    logger.info("Profile enriched from CV for user %s", user_id)

    # ── 5. Publish EVENT_CV_PARSED ─────────────────────────────
    event = json.dumps(
        {
            "type": "EVENT_CV_PARSED",
            "userId": user_id,
            "fieldsUpdated": {
                "skills": len(skills),
                "experience": len(experience),
                "education": len(education),
                "certifications": len(certifications),
                "projects": len(projects),
            },
        }
    )
    await rdb.publish("EVENT_CV_PARSED", event)
    logger.info("EVENT_CV_PARSED published for user %s", user_id)


# ─── Prompt ───────────────────────────────────────────────────────────────────


def _cv_extract_prompt(cv_text: str) -> tuple[str, str]:
    system = (
        "You are an expert HR data extractor. Parse the following CV/résumé text and "
        "return ONLY a valid JSON object with these exact keys:\n"
        "{\n"
        '  "skills": [{"name": "string", "level": "beginner|intermediate|expert"}],\n'
        '  "experience": [{"title": "string", "company": "string", "start": "YYYY-MM", '
        '"end": "YYYY-MM or present", "description": "string"}],\n'
        '  "education": [{"degree": "string", "school": "string", "year": 2024}],\n'
        '  "certifications": [{"name": "string", "issuer": "string", "year": 2024}],\n'
        '  "projects": [{"name": "string", "description": "string", "technologies": ["string"]}]\n'
        "}\n"
        "Rules:\n"
        "- Infer skill levels from context (years, job titles, project complexity).\n"
        "- Use empty arrays [] for sections absent from the CV.\n"
        "- Do NOT include any text outside the JSON object.\n"
        "- Dates: use YYYY-MM format; use 'present' for current roles."
    )
    user = f"CV text:\n\n{cv_text}"
    return system, user


# ─── Helpers ─────────────────────────────────────────────────────────────────


async def _publish_error(rdb: aioredis.Redis, user_id: str, reason: str) -> None:
    event = json.dumps(
        {
            "type": "EVENT_CV_PARSED",
            "userId": user_id,
            "error": reason,
        }
    )
    try:
        await rdb.publish("EVENT_CV_PARSED", event)
    except Exception as exc:
        logger.warning("Failed to publish CV parse error event: %s", exc)
