"""
Unit tests for match_score.compute().

Run with:  pytest tests/test_match_score.py -v
"""

import json
import os
import sys

# Allow importing from ai-coach-service/src
_SERVICE_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(_SERVICE_ROOT, "src"))

import match_score as ms  # noqa: E402

# ── Fixtures ──────────────────────────────────────────────────────────────────

PYTHON_SKILLS = ["Python", "FastAPI", "Docker", "PostgreSQL", "Redis"]
PYTHON_JOB = {
    "title": "Développeur Python Backend",
    "description": "Nous recherchons un développeur Python maîtrisant FastAPI, Docker et PostgreSQL.",
    "company": "TechCorp",
}

JAVA_SKILLS = ["Java", "Spring Boot", "Maven", "Hibernate"]
JS_JOB = {
    "title": "JavaScript Frontend Developer",
    "description": "React, TypeScript, Node.js, CSS, HTML required.",
    "company": "StartupXYZ",
}

PARTIAL_SKILLS = ["Python", "Linux", "Bash"]
PARTIAL_JOB = {
    "title": "DevOps Engineer",
    "description": "Python scripting, Linux administration, Docker, Kubernetes, Terraform.",
    "company": "Infra Inc",
}


# ── compute() — basic cases ───────────────────────────────────────────────────


class TestComputeBasic:
    def test_high_overlap_returns_high_score(self):
        score = ms.compute(PYTHON_SKILLS, [], PYTHON_JOB)
        assert score > 60, f"Expected >60, got {score}"

    def test_zero_overlap_returns_low_score(self):
        score = ms.compute(JAVA_SKILLS, [], JS_JOB)
        assert score <= 15, f"Expected ≤15, got {score}"

    def test_partial_overlap_in_range(self):
        score = ms.compute(PARTIAL_SKILLS, [], PARTIAL_JOB)
        assert 10 <= score <= 90, f"Expected 10–90, got {score}"

    def test_score_is_integer(self):
        score = ms.compute(PYTHON_SKILLS, [], PYTHON_JOB)
        assert isinstance(score, int)

    def test_score_clamped_to_100(self):
        # A profile with ALL the job keywords should not exceed 100
        very_rich_skills = [
            "Python",
            "FastAPI",
            "Docker",
            "PostgreSQL",
            "Développeur",
            "Backend",
            "TechCorp",
            "Recherchons",
            "Maîtrisant",
        ]
        score = ms.compute(very_rich_skills, [], PYTHON_JOB)
        assert score <= 100

    def test_score_not_negative(self):
        score = ms.compute([], [], PYTHON_JOB)
        assert score >= 0


# ── compute() — empty / edge inputs ──────────────────────────────────────────


class TestComputeEdge:
    def test_empty_job_keywords_returns_neutral_50(self):
        score = ms.compute(PYTHON_SKILLS, [], {})
        assert score == 50

    def test_empty_skills_returns_0_when_job_has_keywords(self):
        score = ms.compute([], [], PYTHON_JOB)
        assert score == 0

    def test_raw_data_as_json_string(self):
        raw_string = json.dumps(PYTHON_JOB)
        score_dict = ms.compute(PYTHON_SKILLS, [], PYTHON_JOB)
        score_str = ms.compute(PYTHON_SKILLS, [], raw_string)
        assert score_dict == score_str

    def test_invalid_json_string_falls_back_to_neutral(self):
        score = ms.compute(PYTHON_SKILLS, [], "not-valid-json{{{")
        assert score == 50

    def test_empty_raw_data_dict_returns_neutral(self):
        score = ms.compute(PYTHON_SKILLS, [], {})
        assert score == 50


# ── compute() — skills formats ────────────────────────────────────────────────


class TestComputeSkillsFormats:
    def test_skills_as_strings(self):
        score = ms.compute(["Python", "Docker"], [], PYTHON_JOB)
        assert score > 0

    def test_skills_as_dicts_with_name_level(self):
        skills = [
            {"name": "Python", "level": "senior"},
            {"name": "Docker", "level": "intermediate"},
        ]
        score = ms.compute(skills, [], PYTHON_JOB)
        assert score > 0

    def test_skills_mixed_strings_and_dicts(self):
        skills = ["FastAPI", {"name": "Docker", "level": "junior"}]
        score = ms.compute(skills, [], PYTHON_JOB)
        assert score > 0


# ── compute() — experience contributes ────────────────────────────────────────


class TestComputeExperience:
    def test_experience_boosts_score(self):
        experience = [
            {
                "role": "Backend Developer",
                "title": "Python Developer",
                "description": "Developed REST APIs with FastAPI and PostgreSQL.",
            }
        ]
        score_without = ms.compute([], [], PYTHON_JOB)
        score_with = ms.compute([], experience, PYTHON_JOB)
        assert score_with > score_without

    def test_irrelevant_experience_does_not_help(self):
        experience = [
            {
                "role": "Chef cuisinier",
                "title": "Chef",
                "description": "Préparation de plats gastronomiques en cuisine professionnelle.",
            }
        ]
        score = ms.compute([], experience, JS_JOB)
        assert score <= 15
