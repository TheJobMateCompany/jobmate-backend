"""
Unit tests for cv_parser.parse().

Run with:  pytest tests/test_cv_parser.py -v

All external I/O is mocked:
  - pdfminer.high_level.extract_text   → returns a fake CV text
  - llm.chat_json                      → returns a structured dict
  - database.get_pool                  → returns an async mock
  - rdb.publish                        → async mock
"""

import json
import os
import sys
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

# Allow importing from ai-coach-service/src
_SERVICE_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(_SERVICE_ROOT, "src"))

import cv_parser  # noqa: E402

# ── Fixtures ──────────────────────────────────────────────────────────────────

FAKE_CV_TEXT = """
John Doe — Software Engineer
Skills: Python, FastAPI, Docker, PostgreSQL, Redis
Experience:
  - Acme Corp (2022-01 to present): Backend Developer, built REST APIs.
  - StartupXYZ (2020-06 to 2021-12): Junior Developer, React + Node.js.
Education:
  - Ynov Campus: Bachelor Informatique (2018-2022)
Certifications:
  - AWS Solutions Architect, Amazon, 2023
Projects:
  - JobMate: AI career copilot (Python, FastAPI, React)
"""

FAKE_LLM_RESPONSE = {
    "skills": [
        {"name": "Python", "level": "expert"},
        {"name": "FastAPI", "level": "intermediate"},
        {"name": "Docker", "level": "intermediate"},
    ],
    "experience": [
        {
            "title": "Backend Developer",
            "company": "Acme Corp",
            "start": "2022-01",
            "end": "present",
            "description": "Built REST APIs.",
        }
    ],
    "education": [
        {"degree": "Bachelor Informatique", "school": "Ynov Campus", "year": 2022}
    ],
    "certifications": [
        {"name": "AWS Solutions Architect", "issuer": "Amazon", "year": 2023}
    ],
    "projects": [
        {
            "name": "JobMate",
            "description": "AI career copilot",
            "technologies": ["Python", "FastAPI", "React"],
        }
    ],
}


# ── Helpers ───────────────────────────────────────────────────────────────────


def _make_pool_mock():
    """Build a fake asyncpg pool that records the SQL executed."""
    conn = AsyncMock()
    conn.execute = AsyncMock(return_value=None)
    pool = MagicMock()
    pool.acquire = MagicMock(return_value=_AsyncCtxMgr(conn))
    return pool, conn


class _AsyncCtxMgr:
    """Minimal async context manager returning a fixed value."""

    def __init__(self, value):
        self._value = value

    async def __aenter__(self):
        return self._value

    async def __aexit__(self, *_):
        pass


# ── Tests ─────────────────────────────────────────────────────────────────────


class TestParse:
    """Happy-path and edge-case tests for cv_parser.parse()."""

    @pytest.mark.asyncio
    async def test_happy_path_updates_profile_and_publishes(self, tmp_path):
        """Full flow: PDF found → LLM returns data → DB updated → event published."""
        # Create a dummy PDF file the parser expects to find
        pdf_file = tmp_path / "cv.pdf"
        pdf_file.write_bytes(b"%PDF-1.4 fake content")

        pool_mock, conn_mock = _make_pool_mock()
        rdb_mock = AsyncMock()

        with (
            patch("cv_parser.UPLOAD_BASE", str(tmp_path)),
            patch("cv_parser.extract_text", return_value=FAKE_CV_TEXT),
            patch(
                "cv_parser.llm.chat_json",
                new_callable=AsyncMock,
                return_value=FAKE_LLM_RESPONSE,
            ),
            patch("cv_parser.get_pool", return_value=pool_mock),
        ):
            await cv_parser.parse("user-uuid-1", "/uploads/cv.pdf", rdb_mock)

        # DB should have been updated once
        conn_mock.execute.assert_awaited_once()
        sql_call_args = conn_mock.execute.call_args[0]
        assert "UPDATE profiles" in sql_call_args[0]
        assert "user-uuid-1" in sql_call_args  # user_id passed as $6

        # EVENT_CV_PARSED should have been published
        rdb_mock.publish.assert_awaited_once()
        channel, raw = rdb_mock.publish.call_args[0]
        assert channel == "EVENT_CV_PARSED"
        event = json.loads(raw)
        assert event["type"] == "EVENT_CV_PARSED"
        assert event["userId"] == "user-uuid-1"
        assert "fieldsUpdated" in event

    @pytest.mark.asyncio
    async def test_missing_file_publishes_error_event(self, tmp_path):
        """If the PDF does not exist, publish an error event and abort."""
        rdb_mock = AsyncMock()

        with patch("cv_parser.UPLOAD_BASE", str(tmp_path)):
            await cv_parser.parse("user-uuid-2", "/uploads/missing.pdf", rdb_mock)

        rdb_mock.publish.assert_awaited_once()
        channel, raw = rdb_mock.publish.call_args[0]
        assert channel == "EVENT_CV_PARSED"
        event = json.loads(raw)
        assert "error" in event
        assert event["userId"] == "user-uuid-2"

    @pytest.mark.asyncio
    async def test_empty_pdf_text_publishes_error_event(self, tmp_path):
        """If pdfminer returns empty text, publish an error event and abort."""
        pdf_file = tmp_path / "empty.pdf"
        pdf_file.write_bytes(b"%PDF-1.4")

        rdb_mock = AsyncMock()

        with (
            patch("cv_parser.UPLOAD_BASE", str(tmp_path)),
            patch("cv_parser.extract_text", return_value="   "),
        ):
            await cv_parser.parse("user-uuid-3", "/uploads/empty.pdf", rdb_mock)

        rdb_mock.publish.assert_awaited_once()
        event = json.loads(rdb_mock.publish.call_args[0][1])
        assert "error" in event

    @pytest.mark.asyncio
    async def test_llm_returns_none_publishes_error_event(self, tmp_path):
        """If the LLM call fails (returns None), publish an error and abort."""
        pdf_file = tmp_path / "cv2.pdf"
        pdf_file.write_bytes(b"%PDF-1.4 content")

        rdb_mock = AsyncMock()

        with (
            patch("cv_parser.UPLOAD_BASE", str(tmp_path)),
            patch("cv_parser.extract_text", return_value=FAKE_CV_TEXT),
            patch("cv_parser.llm.chat_json", new_callable=AsyncMock, return_value=None),
        ):
            await cv_parser.parse("user-uuid-4", "/uploads/cv2.pdf", rdb_mock)

        rdb_mock.publish.assert_awaited_once()
        event = json.loads(rdb_mock.publish.call_args[0][1])
        assert "error" in event

    @pytest.mark.asyncio
    async def test_llm_partial_response_still_updates_db(self, tmp_path):
        """If LLM only returns skills (no experience), we still patch the skills."""
        pdf_file = tmp_path / "partial.pdf"
        pdf_file.write_bytes(b"%PDF-1.4")

        partial_response = {"skills": [{"name": "Python", "level": "expert"}]}

        pool_mock, conn_mock = _make_pool_mock()
        rdb_mock = AsyncMock()

        with (
            patch("cv_parser.UPLOAD_BASE", str(tmp_path)),
            patch("cv_parser.extract_text", return_value=FAKE_CV_TEXT),
            patch(
                "cv_parser.llm.chat_json",
                new_callable=AsyncMock,
                return_value=partial_response,
            ),
            patch("cv_parser.get_pool", return_value=pool_mock),
        ):
            await cv_parser.parse("user-uuid-5", "/uploads/partial.pdf", rdb_mock)

        conn_mock.execute.assert_awaited_once()
        rdb_mock.publish.assert_awaited_once()
        event = json.loads(rdb_mock.publish.call_args[0][1])
        assert event["type"] == "EVENT_CV_PARSED"
        # fieldsUpdated.experience should be 0 (empty list from LLM)
        assert event["fieldsUpdated"]["experience"] == 0


class TestCvExtractPrompt:
    """Sanity checks on the private prompt builder."""

    def test_returns_two_strings(self):
        system, user = cv_parser._cv_extract_prompt("some text")
        assert isinstance(system, str) and len(system) > 0
        assert isinstance(user, str) and "some text" in user

    def test_system_mentions_json_keys(self):
        system, _ = cv_parser._cv_extract_prompt("text")
        for key in ("skills", "experience", "education", "certifications", "projects"):
            assert key in system, f"Key '{key}' missing from system prompt"
