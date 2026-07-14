"""TradeAI — lean paper-trading server with an AI Council (Claude + Gemini).

Run:  uvicorn main:app --host 0.0.0.0 --port 8000
Open: http://<your-computer-ip>:8000 from iPad Safari on the same Wi-Fi.
"""
import asyncio
import contextlib
import logging
import os

from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))

import secrets as pysecrets

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import council
import db
import engine
import market

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
log = logging.getLogger("tradeai")

CYCLE_MINUTES = int(os.environ.get("CYCLE_INTERVAL_MINUTES", "15"))
STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")

cycle_lock = asyncio.Lock()
last_cycle: dict = {"ts": None, "summary": "not run yet"}


async def run_cycle(force: bool = False) -> dict:
    """One trading cycle: analyse watchlist -> council deliberates -> execute unanimous verdicts."""
    if db.get_config("kill_switch") == "1":
        return {"ran": False, "reason": "kill switch is ON"}
    if not force and not engine.is_market_open():
        return {"ran": False, "reason": "market closed (NSE 9:15-15:30 IST, Mon-Fri)"}

    async with cycle_lock:
        min_conf = float(db.get_config("min_confidence"))
        positions = {p["symbol"]: p for p in db.open_positions()}
        results = []
        for symbol in db.get_watchlist():
            analysis = await asyncio.to_thread(market.get_analysis, symbol)
            if not analysis:
                results.append({"symbol": symbol, "outcome": "NO_DATA"})
                continue
            try:
                verdict = await council.deliberate(analysis, positions.get(symbol), min_conf)
            except Exception as e:  # deliberate degrades internally; this is a last resort
                log.exception("council failed for %s", symbol)
                db.log_council(symbol, None, None, "HOLD", "COUNCIL_ERROR", str(e)[:300])
                results.append({"symbol": symbol, "outcome": "COUNCIL_ERROR"})
                continue
            db.log_council(symbol, verdict["claude"], verdict["gemini"], verdict["final_action"],
                           verdict["outcome"], verdict["note"])
            executed = None
            if verdict["outcome"].startswith("EXECUTE"):
                trade_note = f"{verdict['mode']}_{verdict['final_action']}"
                if verdict["final_action"] == "BUY" and symbol not in positions:
                    executed = await asyncio.to_thread(engine.execute_buy, symbol, trade_note)
                elif verdict["final_action"] == "SELL" and symbol in positions:
                    executed = await asyncio.to_thread(engine.execute_sell, symbol, trade_note)
            results.append({"symbol": symbol, "outcome": verdict["outcome"],
                            "action": verdict["final_action"], "executed": executed})
        last_cycle.update(ts=db.now(), summary=results)
        return {"ran": True, "results": results}


async def background_loop():
    """Every minute: check stop-loss/target exits. Every CYCLE_MINUTES: full council cycle."""
    tick = 0
    while True:
        try:
            if db.get_config("kill_switch") != "1" and engine.is_market_open():
                exits = await asyncio.to_thread(engine.check_exits)
                if exits:
                    log.info("auto-exits: %s", exits)
                if tick % CYCLE_MINUTES == 0:
                    await run_cycle()
        except Exception:
            log.exception("background loop error")
        tick += 1
        await asyncio.sleep(60)


@contextlib.asynccontextmanager
async def lifespan(app: FastAPI):
    db.init()
    task = asyncio.create_task(background_loop())
    log.info("TradeAI up — paper mode, cycle every %d min during market hours", CYCLE_MINUTES)
    yield
    task.cancel()


app = FastAPI(title="TradeAI", lifespan=lifespan)

PASSWORD = os.environ.get("TRADEAI_PASSWORD", "")


@app.middleware("http")
async def require_password(request: Request, call_next):
    """If TRADEAI_PASSWORD is set, every /api call must carry it. Set it
    whenever the server is reachable from outside your home network."""
    if PASSWORD and request.url.path.startswith("/api"):
        supplied = request.headers.get("x-auth", "")
        if not pysecrets.compare_digest(supplied, PASSWORD):
            return JSONResponse({"error": "unauthorized"}, status_code=401)
    return await call_next(request)


class WatchlistBody(BaseModel):
    symbols: list[str]


class ToggleBody(BaseModel):
    active: bool


class TradeBody(BaseModel):
    symbol: str


@app.get("/api/state")
async def state():
    mode, mode_msg = council.council_mode()
    return {
        "portfolio": await asyncio.to_thread(engine.portfolio_value),
        "trades": db.recent_trades(30),
        "council": db.recent_council(20),
        "watchlist": db.get_watchlist(),
        "kill_switch": db.get_config("kill_switch") == "1",
        "market_open": engine.is_market_open(),
        "council_mode": mode,
        "council_status": mode_msg,
        "last_cycle": last_cycle,
        "mode": "PAPER",
    }


@app.post("/api/cycle")
async def cycle_now():
    return await run_cycle(force=True)


@app.post("/api/killswitch")
async def killswitch(body: ToggleBody):
    db.set_config("kill_switch", "1" if body.active else "0")
    return {"kill_switch": body.active}


@app.post("/api/watchlist")
async def set_watchlist(body: WatchlistBody):
    symbols = [s.strip().upper() for s in body.symbols if s.strip()]
    symbols = [s if s.endswith(".NS") else f"{s}.NS" for s in symbols]
    db.set_config("watchlist", __import__("json").dumps(symbols))
    return {"watchlist": symbols}


@app.post("/api/buy")
async def manual_buy(body: TradeBody):
    return await asyncio.to_thread(engine.execute_buy, body.symbol.upper(), "MANUAL_OVERRIDE_BUY")


@app.post("/api/sell")
async def manual_sell(body: TradeBody):
    return await asyncio.to_thread(engine.execute_sell, body.symbol.upper(), "MANUAL_OVERRIDE_SELL")


@app.get("/api/quote/{symbol}")
async def quote(symbol: str):
    price = await asyncio.to_thread(market.get_ltp, symbol.upper())
    return {"symbol": symbol.upper(), "ltp": price}


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/")
async def index():
    return FileResponse(os.path.join(STATIC_DIR, "index.html"))


@app.get("/manifest.json")
async def manifest():
    return FileResponse(os.path.join(STATIC_DIR, "manifest.json"))
