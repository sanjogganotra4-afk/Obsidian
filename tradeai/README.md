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

## One-time setup for permanent iPad access

Two options, both set-and-forget:

**A. Cloud (laptop can be off) — Render.com**
1. Push this repo to your GitHub, then on render.com: New → Web Service →
   connect the repo.
2. Root Directory: `tradeai` • Build: `pip install -r requirements.txt` •
   Start: `uvicorn main:app --host 0.0.0.0 --port $PORT`
3. Environment tab: add `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, and
   `TRADEAI_PASSWORD` (required — this makes the public URL safe).
4. Open the `https://….onrender.com` URL on the iPad, enter the password
   once, Add to Home Screen. Done forever.
5. Free-tier caveat: Render sleeps the app after ~15 idle minutes and the
   scheduler stops while asleep. Fix free with a monitor
   (e.g. UptimeRobot pinging `/` every 5 min), or pay ~$7/mo to keep it
   always-on. Free instances also have ephemeral disk — the paper
   portfolio resets on redeploys; a paid persistent disk (mount at a path
   and set `TRADEAI_DB` to a file on it) survives.

**B. Home server (₹0) — laptop stays home, plugged in**
1. Set the laptop to never sleep when plugged in (lid can be closed on
   Mac with an external display setting or `caffeinate`; Windows: Power
   settings → never sleep).
2. Install [Tailscale](https://tailscale.com) (free) on both laptop and
   iPad, sign in with the same account — the iPad can then reach the
   laptop from anywhere, encrypted, no port forwarding.
3. Auto-start the server on boot (Windows Task Scheduler / Mac launchd)
   so reboots need nothing from you.
4. On the iPad: `http://<laptop-tailscale-name>:8000` → Add to Home Screen.

If the server is only ever on your home Wi-Fi, `TRADEAI_PASSWORD` can stay
blank; set it the moment the app is reachable from outside.

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
