"""
OpenRouter LLM client (OpenAI-compatible API).
Returns structured JSON for all generation tasks.
"""

import json
import logging
from typing import Any

from openai import AsyncOpenAI

import config

logger = logging.getLogger(__name__)

_client: AsyncOpenAI | None = None


def is_configured() -> bool:
    return bool(config.OPENROUTER_API_KEY)


def get_client() -> AsyncOpenAI | None:
    """Returns the LLM client, or None if no API key is configured."""
    global _client
    if _client is None and config.OPENROUTER_API_KEY:
        _client = AsyncOpenAI(
            api_key=config.OPENROUTER_API_KEY,
            base_url=config.OPENROUTER_BASE_URL,
            default_headers={
                "HTTP-Referer": "https://api.meelkyway.com",
                "X-Title": "JobMate AI Coach",
            },
        )
    return _client


async def chat_json(
    system: str, user: str, temperature: float = 0.4
) -> dict[str, Any] | None:
    """
    Call the LLM with a system + user prompt and parse the response as JSON.

    Returns:
        Parsed dict on success.
        None if no API key is set or the response cannot be parsed.
    """
    client = get_client()
    if client is None:
        logger.warning("OPENROUTER_API_KEY not set — LLM generation skipped.")
        return None

    try:
        response = await client.chat.completions.create(
            model=config.OPENROUTER_MODEL,
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            temperature=temperature,
            timeout=config.OPENROUTER_TIMEOUT_SECONDS,
            # Ask the model to return JSON — not all routed models support
            # response_format natively, so we also enforce it in the prompts.
            response_format={"type": "json_object"},
        )
        raw = response.choices[0].message.content or "{}"
        return json.loads(raw)
    except json.JSONDecodeError as exc:
        logger.error("LLM returned non-JSON: %s", exc)
        return None
    except Exception as exc:
        logger.error("LLM call failed: %s", exc)
        return None


async def chat_text(system: str, user: str, temperature: float = 0.7) -> str | None:
    """Call the LLM and return a plain text response."""
    client = get_client()
    if client is None:
        logger.warning("OPENROUTER_API_KEY not set — LLM generation skipped.")
        return None

    try:
        response = await client.chat.completions.create(
            model=config.OPENROUTER_MODEL,
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            temperature=temperature,
            timeout=config.OPENROUTER_TIMEOUT_SECONDS,
        )
        return (response.choices[0].message.content or "").strip()
    except Exception as exc:
        logger.error("LLM call failed: %s", exc)
        return None
