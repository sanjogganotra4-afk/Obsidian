# TradeAI — Lean Paper-Trading Engine with an AI Council

Autonomous paper trading for Indian markets (NSE) with a two-model AI Council:
**Claude** (fundamental/risk lens) and **Gemini** (technical/momentum lens) each
analyse the same live data independently; a trade executes only when both agree
(unanimous vote — a BUY/SELL hard split always blocks). Live prices come free
from Yahoo Finance via `yfinance`. Everything runs from one FastAPI server that
also serves the iPad dashboard — no build step, no Node, ~7 files.

**Mode: PAPER only.** You start with ₹5,00,000 virtual cash. Live trading via
Kite Connect is Phase 2 — `engine.execute_buy/execute_sell` is the seam where a
Kite adapter drops in once you have API credentials.

## Setup

```bash
cd tradeai
pip install -r requirements.txt
cp .env.example .env        # then paste your two keys into .env
uvicorn main:app --host 0.0.0.0 --port 8000
```

Keys (both required for the council; the rest of the app works without them):
- `ANTHROPIC_API_KEY` — console.anthropic.com → API Keys
- `GEMINI_API_KEY` — aistudio.google.com → Get API Key (starts with `AIza`)

## Open it on your iPad

1. Run the server on your computer with `--host 0.0.0.0` (as above).
2. Find your computer's local IP (Mac: System Settings → Wi-Fi → Details;
   or `ipconfig getifaddr en0`).
3. On the iPad (same Wi-Fi), open Safari → `http://<that-ip>:8000`.
4. Share button → **Add to Home Screen** → it installs as a full-screen app.

To use it away from home, deploy the `tradeai/` folder to Railway/Render
(free tiers work) with the two keys as environment variables, or keep it
local and use Tailscale. If you expose it to the internet, put auth in
front of it first.

## How a trading cycle works

Every 15 min during market hours (9:15–15:30 IST, Mon–Fri), or on demand
via the **Run council cycle now** button:

1. For each watchlist stock, fetch 3 months of daily candles and compute
   RSI-14, EMA-20/50, volume ratio, momentum.
2. Claude and Gemini analyse the same packet **in parallel**, each returning
   `{action, confidence, reasoning}`.
3. Arbitration (unanimous mode):
   - Both BUY or both SELL, avg confidence ≥ 60 → **execute**
   - Agreement but low confidence → hold
   - BUY vs SELL → **hard split, never trade**
   - Any other disagreement → soft split, hold
4. Risk rules on every buy: max 20% of portfolio per position, max 5
   positions, 10% cash reserve, mandatory stop-loss (−3%) and target (+6%).
5. A separate 1-minute monitor auto-exits positions that hit stop or target.
6. Every council session is logged with both models' reasoning — the
   Council tab shows the full debate.

You always have override: kill switch pauses everything instantly; manual
buy/sell bypasses the council (risk rules still apply).

## Fallback ladder — the engine never goes offline

If an API is down (or its key isn't configured), the council degrades
instead of stopping. The header badge shows the current tier:

| Tier | When | Behaviour |
|---|---|---|
| **FULL COUNCIL** | Both keys work | Unanimous voting, trade bar = min confidence (60) |
| **SOLO: CLAUDE / GEMINI** | One model unavailable | Survivor decides alone, but trade bar rises to 75 |
| **RULE-ONLY** | Both unavailable | Indicator rules may *exit* positions protectively (EMA breakdown, RSI ≥ 78) but **never open new ones** |

The stop-loss/target monitor is pure price logic and runs in every tier.
A model that errors mid-cycle is treated the same as one with no key —
each cycle uses whatever responds.

## API

| Endpoint | What |
|---|---|
| `GET /api/state` | Portfolio, positions, trades, council log, status |
| `POST /api/cycle` | Run a council cycle now (ignores market hours) |
| `POST /api/killswitch` `{"active": true}` | Pause/resume all trading |
| `POST /api/watchlist` `{"symbols": [...]}` | Replace watchlist |
| `POST /api/buy` / `POST /api/sell` `{"symbol": "X.NS"}` | Manual override |
| `GET /api/quote/{symbol}` | Live LTP |

## Test

```bash
python3 test_smoke.py   # offline — engine, risk rules, arbitration (17 checks)
```

## Files

```
main.py       FastAPI app, trading-cycle orchestrator, background scheduler
engine.py     paper execution, risk rules, stop-loss/target monitor
council.py    Claude + Gemini REST clients, unanimous arbitrator
market.py     yfinance quotes + indicator computation
db.py         SQLite (stdlib sqlite3), schema + helpers
static/       single-file iPad PWA dashboard
```

⚠️ This is a personal learning tool, not financial advice. Paper results
do not guarantee live results.
