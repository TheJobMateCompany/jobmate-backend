"""
MatchScore — keyword-based fit score between a candidate profile and a job offer.

Algorithm:
  1. Extract keywords from the job description (from raw_data.description + title).
  2. Normalise both sets (lowercase, strip punctuation).
  3. Score = (profile_keywords ∩ job_keywords) / job_keywords × 100.
  4. Clamp to [0, 100].

This is a fast, deterministic baseline. The LLM Pros/Cons adds semantic nuance.
"""

import json
import re
from typing import Any

# Common English/French stop words to ignore in keyword extraction
_STOP_WORDS = {
    "the",
    "a",
    "an",
    "and",
    "or",
    "of",
    "to",
    "in",
    "for",
    "with",
    "on",
    "at",
    "by",
    "from",
    "is",
    "are",
    "be",
    "as",
    "this",
    "that",
    "it",
    "we",
    "you",
    "our",
    "your",
    "have",
    "has",
    "will",
    "would",
    "can",
    "could",
    "should",
    "may",
    "must",
    "not",
    "more",
    "than",
    "also",
    "but",
    "if",
    # French
    "le",
    "la",
    "les",
    "de",
    "du",
    "des",
    "un",
    "une",
    "et",
    "ou",
    "en",
    "au",
    "aux",
    "par",
    "sur",
    "avec",
    "pour",
    "dans",
    "est",
    "sont",
    "nous",
    "vous",
    "ils",
    "qui",
    "que",
    "mais",
    "si",
    "plus",
    "très",
    "votre",
    "notre",
    "ses",
    "mon",
    "ton",
}


def _tokenise(text: str) -> set[str]:
    """Lowercase, remove punctuation, split into tokens, drop stop words."""
    text = text.lower()
    tokens = re.findall(r"\b[a-zA-ZÀ-ÿ][a-zA-ZÀ-ÿ0-9+#\-.]{1,}\b", text)
    return {t for t in tokens if t not in _STOP_WORDS and len(t) > 2}


def _extract_profile_keywords(
    skills: list[Any],
    experience: list[dict],
) -> set[str]:
    """Flatten profile skills + experience titles/descriptions into a keyword set."""
    parts: list[str] = []

    for s in skills:
        if isinstance(s, str):
            parts.append(s)
        elif isinstance(s, dict):
            parts.append(s.get("name", "") + " " + s.get("level", ""))

    for exp in experience:
        parts.append(
            exp.get("role", "")
            + " "
            + exp.get("title", "")
            + " "
            + exp.get("description", "")
        )

    return _tokenise(" ".join(parts))


def _extract_job_keywords(raw_data: dict) -> set[str]:
    """Extract relevant keywords from a job offer's raw_data JSONB."""

    def _to_text(value: Any) -> str:
        if value is None:
            return ""
        if isinstance(value, str):
            return value
        if isinstance(value, dict):
            # Common Adzuna shape: {"display_name": "..."}
            display_name = value.get("display_name")
            if isinstance(display_name, str):
                return display_name
            return " ".join(str(v) for v in value.values() if isinstance(v, str))
        if isinstance(value, list | tuple | set):
            return " ".join(_to_text(v) for v in value)
        return str(value)

    parts = [
        _to_text(raw_data.get("title", "")),
        _to_text(raw_data.get("description", "")),
        _to_text(raw_data.get("company", "")),
    ]
    # Some Adzuna fields
    parts.append(_to_text(raw_data.get("contractType", "")))
    return _tokenise(" ".join(p for p in parts if p))


def compute(
    skills: list[Any],
    experience: list[dict],
    raw_data: dict | str,
) -> int:
    """
    Compute a MatchScore (0–100) between the profile and the job offer.

    Args:
        skills:     profile.skills_json (list of str or {"name":..., "level":...})
        experience: profile.experience_json
        raw_data:   job_feed.raw_data (dict or JSON string)

    Returns:
        Integer score from 0 to 100.
    """
    if isinstance(raw_data, str):
        try:
            raw_data = json.loads(raw_data)
        except json.JSONDecodeError:
            raw_data = {}

    profile_kw = _extract_profile_keywords(skills, experience)
    job_kw = _extract_job_keywords(raw_data)

    if not job_kw:
        return 50  # No data to compare — neutral score

    overlap = profile_kw & job_kw
    raw_score = len(overlap) / len(job_kw) * 100

    # Scale: a 30%+ keyword overlap is considered excellent (→ 100).
    # Anything below 5% is considered poor (→ remain low).
    scaled = min(100, int(raw_score * (100 / 30)))
    return max(0, scaled)
