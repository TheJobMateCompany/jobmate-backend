"""
Prompt templates for all AI Coach generation tasks.
Each function returns (system_prompt, user_prompt) ready to pass to llm.chat_*
"""


def pros_cons_prompt(
    job_title: str,
    job_description: str,
    company: str,
    profile_skills: list[str],
    profile_experience: list[dict],
    match_score: int,
) -> tuple[str, str]:
    system = (
        "You are an expert career coach. Analyse the fit between a candidate profile "
        "and a job offer. You MUST respond with valid JSON only — no markdown, no explanation. "
        "The JSON MUST follow this exact schema:\n"
        '{"pros": ["string", ...], "cons": ["string", ...]}\n'
        "Each pro/con should be a concrete, actionable sentence (max 20 words)."
    )
    user = f"""
Job title: {job_title}
Company: {company}
Match score: {match_score}/100

Job description (truncated to 1500 chars):
{job_description[:1500]}

Candidate skills: {', '.join(profile_skills) or 'Not specified'}

Recent experience:
{_format_experience(profile_experience[:3])}

Give 3-5 pros and 2-4 cons. Be specific and honest.
Respond with JSON only.
""".strip()
    return system, user


def cover_letter_prompt(
    job_title: str,
    company: str,
    job_description: str,
    full_name: str,
    profile_skills: list[str],
    profile_experience: list[dict],
) -> tuple[str, str]:
    system = (
        "You are a professional cover letter writer. Write a concise, compelling cover letter "
        "tailored to the job and the candidate's background. "
        "The letter should be in the same language as the job description. "
        "Keep it under 300 words. Use a professional but human tone."
    )
    user = f"""
Write a cover letter for:

Position: {job_title} at {company}
Candidate name: {full_name or 'the candidate'}
Skills: {', '.join(profile_skills) or 'Not specified'}

Experience:
{_format_experience(profile_experience[:3])}

Job description (truncated):
{job_description[:1200]}

Output ONLY the cover letter text (no subject line, no JSON wrapper).
""".strip()
    return system, user


def cv_suggestions_prompt(
    job_title: str,
    job_description: str,
    profile_skills: list[str],
) -> tuple[str, str]:
    system = (
        "You are an ATS (Applicant Tracking System) expert. Analyse the job description and "
        "suggest concrete improvements to make the candidate's CV rank higher. "
        "You MUST respond with valid JSON only.\n"
        'Schema: {"suggestions": ["string", ...]}\n'
        "Give 3-5 actionable bullet points. Focus on keywords to add, skills to highlight, "
        "and formatting best practices."
    )
    user = f"""
Target role: {job_title}
Current skills listed: {', '.join(profile_skills) or 'None'}
Job description keywords (first 1000 chars): {job_description[:1000]}

What specific changes should the candidate make to their CV?
Respond with JSON only.
""".strip()
    return system, user


# ── Helpers ────────────────────────────────────────────────────


def _format_experience(experience: list[dict]) -> str:
    if not experience:
        return "No experience provided."
    lines = []
    for item in experience:
        role = item.get("role") or item.get("title") or "Unknown role"
        company = item.get("company", "")
        desc = item.get("description", "")
        lines.append(f"- {role} at {company}: {desc[:150]}")
    return "\n".join(lines)
