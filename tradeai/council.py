"""AI Council: Claude (fundamental/risk lens) + Gemini (technical/momentum lens).

Both are called over plain REST with httpx. Keys come from env only.
Voting is UNANIMOUS: both models must agree, and a BUY/SELL hard split
always blocks the trade.
"""
import json
import logging
import os

import httpx

log = logging.getLogger("tradeai.council")

ANTHROPIC_URL = "https://api.anthropic.com/v1/messages"
GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"

CLAUDE_ROLE = (
    "You are a cautious, risk-aware fundamental analyst for Indian equities (NSE). "
    "Focus on downside risk: is this a sane trade right now? Ask 'what could go wrong?'. "
    "Lower your confidence when signals conflict or momentum looks overextended."
)
GEMINI_ROLE = (
    "You are a technical analyst for Indian equities (NSE), focused purely on price action: "
    "trend vs EMA20/EMA50, RSI, volume confirmation, momentum. Ignore news and narrative. "
    "Lower your confidence when technical signals are mixed."
)

OUTPUT_SPEC = (
    'Respond ONLY with valid JSON, no markdown fences, exactly: '
    '{"action": "BUY"|"SELL"|"HOLD", "confidence": <0-100>, "reasoning": "<2 sentences>"}'
)


def _prompt(analysis: dict, position: dict | None) -> str:
    pos_line = (
        f"We HOLD {position['qty']} shares, entry {position['entry_price']}, "
        f"stop-loss {position['stop_loss']}, target {position['target']}. "
        "SELL means exit this position; BUY is not allowed on a held stock — prefer HOLD or SELL."
        if position else "We hold NO position in this stock. SELL is not applicable — choose BUY or HOLD."
    )
    return (
        f"Market data for {analysis['symbol']}:\n{json.dumps(analysis, indent=1)}\n\n"
        f"Position status: {pos_line}\n\n{OUTPUT_SPEC}"
    )


def _parse_verdict(raw: str, model: str) -> dict:
    text = raw.strip()
    if text.startswith("```"):
        text = text.strip("`")
        text = text[text.index("{"):]
    start, end = text.find("{"), text.rfind("}")
    parsed = json.loads(text[start:end + 1])
    action = str(parsed["action"]).upper()
    if action not in ("BUY", "SELL", "HOLD"):
        raise ValueError(f"bad action {action!r}")
    return {
        "model": model,
        "action": action,
        "confidence": float(parsed.get("confidence", 0)),
        "reasoning": str(parsed.get("reasoning", ""))[:500],
    }


async def ask_claude(client: httpx.AsyncClient, analysis: dict, position: dict | None) -> dict:
    key = os.environ["ANTHROPIC_API_KEY"]
    model = os.environ.get("CLAUDE_MODEL", "claude-sonnet-4-5")
    r = await client.post(
        ANTHROPIC_URL,
        headers={"x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json"},
        json={
            "model": model,
            "max_tokens": 300,
            "system": CLAUDE_ROLE,
            "messages": [{"role": "user", "content": _prompt(analysis, position)}],
        },
        timeout=45.0,
    )
    r.raise_for_status()
    return _parse_verdict(r.json()["content"][0]["text"], "claude")


async def ask_gemini(client: httpx.AsyncClient, analysis: dict, position: dict | None) -> dict:
    key = os.environ["GEMINI_API_KEY"]
    model = os.environ.get("GEMINI_MODEL", "gemini-1.5-flash")
    r = await client.post(
        GEMINI_URL.format(model=model),
        params={"key": key},
        json={
            "contents": [{"role": "user", "parts": [{"text": f"{GEMINI_ROLE}\n\n{_prompt(analysis, position)}"}]}],
            "generationConfig": {"temperature": 0.1, "maxOutputTokens": 300, "responseMimeType": "application/json"},
        },
        timeout=45.0,
    )
    r.raise_for_status()
    return _parse_verdict(r.json()["candidates"][0]["content"]["parts"][0]["text"], "gemini")


def arbitrate(claude: dict, gemini: dict, min_confidence: float) -> tuple[str, str]:
    """Unanimous vote. Returns (final_action, outcome)."""
    if claude["action"] == gemini["action"]:
        avg = (claude["confidence"] + gemini["confidence"]) / 2
        if claude["action"] == "HOLD":
            return "HOLD", "UNANIMOUS_HOLD"
        if avg >= min_confidence:
            return claude["action"], "EXECUTE"
        return "HOLD", "LOW_CONFIDENCE_HOLD"
    if {claude["action"], gemini["action"]} == {"BUY", "SELL"}:
        return "HOLD", "HARD_SPLIT"
    return "HOLD", "SOFT_SPLIT"


def keys_present() -> tuple[bool, str]:
    missing = [k for k in ("ANTHROPIC_API_KEY", "GEMINI_API_KEY") if not os.environ.get(k)]
    if missing:
        return False, f"Missing API keys: {', '.join(missing)}. Set them in tradeai/.env"
    gem = os.environ["GEMINI_API_KEY"]
    if not gem.startswith("AIza"):
        return False, "GEMINI_API_KEY does not start with 'AIza' — verify it came from aistudio.google.com"
    return True, ""


async def deliberate(analysis: dict, position: dict | None, min_confidence: float) -> dict:
    """Run both models in parallel and arbitrate. Raises on API failure."""
    import asyncio
    async with httpx.AsyncClient() as client:
        claude, gemini = await asyncio.gather(
            ask_claude(client, analysis, position),
            ask_gemini(client, analysis, position),
        )
    final_action, outcome = arbitrate(claude, gemini, min_confidence)
    return {"claude": claude, "gemini": gemini, "final_action": final_action, "outcome": outcome}
