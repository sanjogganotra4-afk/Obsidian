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
    model = os.environ.get("GEMINI_MODEL", "gemini-flash-latest")
    r = await client.post(
        GEMINI_URL.format(model=model),
        params={"key": key},
        json={
            "contents": [{"role": "user", "parts": [{"text": f"{GEMINI_ROLE}\n\n{_prompt(analysis, position)}"}]}],
            "generationConfig": {
                "temperature": 0.1,
                "maxOutputTokens": 1000,
                "responseMimeType": "application/json",
                # newer flash models "think" by default, burning the output
                # budget before any JSON is emitted — turn that off
                "thinkingConfig": {"thinkingBudget": 0},
            },
        },
        timeout=45.0,
    )
    r.raise_for_status()
    candidate = r.json()["candidates"][0]
    text = "".join(p.get("text", "") for p in candidate.get("content", {}).get("parts", []))
    if not text:
        raise ValueError(f"Gemini returned no text (finishReason={candidate.get('finishReason')})")
    return _parse_verdict(text, "gemini")


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


SOLO_CONFIDENCE_MARGIN = 15  # solo mode needs min_confidence + this to trade


def council_mode() -> tuple[str, str]:
    """What the council can run as right now, based on configured keys."""
    has_claude = bool(os.environ.get("ANTHROPIC_API_KEY"))
    gem = os.environ.get("GEMINI_API_KEY", "")
    # AI Studio keys start with "AIza"; Vertex AI express-mode keys start with "AQ."
    has_gemini = gem.startswith("AIza") or gem.startswith("AQ.")
    if has_claude and has_gemini:
        return "FULL", "Full council: Claude + Gemini, unanimous voting"
    if has_gemini:
        return "SOLO_GEMINI", f"Solo mode: Gemini only (no ANTHROPIC_API_KEY) — trades need confidence ≥ min+{SOLO_CONFIDENCE_MARGIN}"
    if has_claude:
        return "SOLO_CLAUDE", f"Solo mode: Claude only (no valid GEMINI_API_KEY) — trades need confidence ≥ min+{SOLO_CONFIDENCE_MARGIN}"
    return "RULE_ONLY", "No API keys — rule engine only: protective exits allowed, no new positions"


def rule_signal(analysis: dict, position: dict | None) -> dict:
    """Deterministic indicator-based fallback. Conservative by design."""
    rsi = analysis.get("rsi14") or 50
    trend_up = analysis.get("above_ema20") and analysis.get("above_ema50")
    trend_down = not analysis.get("above_ema20") and not analysis.get("above_ema50")
    vol = analysis.get("volume_ratio") or 1.0
    if position and trend_down:
        return {"model": "rule-engine", "action": "SELL", "confidence": 70,
                "reasoning": "Price below both EMA20 and EMA50 — protective exit."}
    if position and rsi >= 78:
        return {"model": "rule-engine", "action": "SELL", "confidence": 65,
                "reasoning": f"RSI {rsi} overbought — protective profit-take."}
    if not position and trend_up and 50 <= rsi <= 70 and vol >= 1.2:
        return {"model": "rule-engine", "action": "BUY", "confidence": 60,
                "reasoning": f"Uptrend above both EMAs, RSI {rsi}, volume {vol}x — but rule engine never opens positions."}
    return {"model": "rule-engine", "action": "HOLD", "confidence": 50,
            "reasoning": "No strong rule signal."}


def resolve_degraded(claude: dict | None, gemini: dict | None, analysis: dict,
                     position: dict | None, min_confidence: float) -> dict:
    """Arbitrate with whatever survived. Never raises — always returns a verdict."""
    if claude and gemini:
        action, outcome = arbitrate(claude, gemini, min_confidence)
        return {"claude": claude, "gemini": gemini, "final_action": action,
                "outcome": outcome, "mode": "FULL", "note": ""}
    solo = claude or gemini
    if solo:
        mode = "SOLO_CLAUDE" if claude else "SOLO_GEMINI"
        bar = min_confidence + SOLO_CONFIDENCE_MARGIN
        if solo["action"] == "HOLD":
            action, outcome = "HOLD", "SOLO_HOLD"
        elif solo["confidence"] >= bar:
            action, outcome = solo["action"], "EXECUTE_SOLO"
        else:
            action, outcome = "HOLD", "SOLO_LOW_CONFIDENCE"
        return {"claude": claude, "gemini": gemini, "final_action": action, "outcome": outcome,
                "mode": mode, "note": f"One panel unavailable — solo trade bar {bar}."}
    rule = rule_signal(analysis, position)
    if rule["action"] == "SELL" and position:
        action, outcome = "SELL", "EXECUTE_RULE_EXIT"
    elif rule["action"] == "BUY":
        action, outcome = "HOLD", "RULE_SUGGEST_BUY"  # never open positions without an AI
    else:
        action, outcome = "HOLD", "RULE_HOLD"
    return {"claude": None, "gemini": None, "final_action": action, "outcome": outcome,
            "mode": "RULE_ONLY", "note": f"Rule engine: {rule['reasoning']}"}


async def deliberate(analysis: dict, position: dict | None, min_confidence: float) -> dict:
    """Ask every model whose key is configured; degrade gracefully if any call fails."""
    import asyncio
    claude = gemini = None
    async with httpx.AsyncClient() as client:
        tasks = {}
        if os.environ.get("ANTHROPIC_API_KEY"):
            tasks["claude"] = ask_claude(client, analysis, position)
        if os.environ.get("GEMINI_API_KEY"):
            tasks["gemini"] = ask_gemini(client, analysis, position)
        results = await asyncio.gather(*tasks.values(), return_exceptions=True)
        for name, res in zip(tasks, results):
            if isinstance(res, Exception):
                log.warning("%s panel failed for %s: %s", name, analysis["symbol"], res)
            elif name == "claude":
                claude = res
            else:
                gemini = res
    return resolve_degraded(claude, gemini, analysis, position, min_confidence)
