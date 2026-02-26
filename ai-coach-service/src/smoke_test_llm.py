import asyncio
import os

from openai import AsyncOpenAI


async def main() -> int:
    api_key = os.getenv("OPENROUTER_API_KEY", "").strip()
    base_url = os.getenv("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1").strip()
    model = os.getenv("OPENROUTER_MODEL", "meta-llama/llama-3.3-70b-instruct").strip()
    timeout_s = int(os.getenv("OPENROUTER_TIMEOUT_SECONDS", "45").strip())

    print(f"Model: {model}")
    print(f"Base URL: {base_url}")
    print(f"Timeout(s): {timeout_s}")

    if not api_key:
        print("ERROR: OPENROUTER_API_KEY is not configured.")
        return 1

    client = AsyncOpenAI(
        api_key=api_key,
        base_url=base_url,
        default_headers={
            "HTTP-Referer": "https://api.meelkyway.com",
            "X-Title": "JobMate AI Coach",
        },
    )

    response = await client.chat.completions.create(
        model=model,
        messages=[
            {"role": "system", "content": "You are a health-check assistant."},
            {"role": "user", "content": "Reply with exactly: OK"},
        ],
        temperature=0.0,
        timeout=timeout_s,
    )
    result = (response.choices[0].message.content or "").strip()

    if not result:
        print("ERROR: LLM request failed or returned empty response.")
        return 1

    print(f"LLM response: {result}")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
