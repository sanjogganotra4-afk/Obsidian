"""Paper trading engine: risk-checked execution + stop-loss/target monitor.

Execution goes through execute_buy/execute_sell so a Kite adapter can be
swapped in for Phase 2 (live) without touching the rest of the system.
"""
import logging
from datetime import datetime, time as dtime
from zoneinfo import ZoneInfo

import db
import market

log = logging.getLogger("tradeai.engine")
IST = ZoneInfo("Asia/Kolkata")

STOP_LOSS_PCT = 0.03   # mandatory stop 3% below entry
TARGET_PCT = 0.06      # target 6% above entry


def is_market_open() -> bool:
    now = datetime.now(IST)
    if now.weekday() >= 5:
        return False
    return dtime(9, 15) <= now.time() <= dtime(15, 30)


def portfolio_value() -> dict:
    cash = db.get_cash()
    positions = db.open_positions()
    invested = 0.0
    unrealized = 0.0
    enriched = []
    for p in positions:
        ltp = market.get_ltp(p["symbol"]) or p["entry_price"]
        value = ltp * p["qty"]
        invested += value
        unrealized += (ltp - p["entry_price"]) * p["qty"]
        enriched.append({**p, "ltp": round(ltp, 2), "pnl": round((ltp - p["entry_price"]) * p["qty"], 2)})
    initial = float(db.get_config("initial_capital"))
    total = cash + invested
    return {
        "cash": round(cash, 2),
        "invested": round(invested, 2),
        "total": round(total, 2),
        "unrealized_pnl": round(unrealized, 2),
        "realized_pnl": round(db.realized_pnl(), 2),
        "total_return_pct": round((total / initial - 1) * 100, 2),
        "positions": enriched,
    }


def risk_check_buy(symbol: str, ltp: float) -> tuple[int, str]:
    """Return (approved_qty, reason). qty 0 means rejected."""
    positions = db.open_positions()
    if any(p["symbol"] == symbol for p in positions):
        return 0, "already holding this stock"
    max_positions = int(db.get_config("max_positions"))
    if len(positions) >= max_positions:
        return 0, f"max positions ({max_positions}) reached"
    cash = db.get_cash()
    pf = portfolio_value()
    max_position_value = pf["total"] * float(db.get_config("max_position_pct")) / 100
    min_cash = pf["total"] * float(db.get_config("min_cash_pct")) / 100
    budget = min(max_position_value, cash - min_cash)
    qty = int(budget // ltp)
    if qty < 1:
        return 0, "insufficient cash after reserve/position-size limits"
    return qty, f"sized to {qty} shares (₹{qty * ltp:,.0f})"


def execute_buy(symbol: str, note: str) -> dict:
    ltp = market.get_ltp(symbol)
    if not ltp:
        return {"ok": False, "reason": "no live quote available"}
    qty, reason = risk_check_buy(symbol, ltp)
    if qty == 0:
        return {"ok": False, "reason": f"risk-rejected: {reason}"}
    cost = qty * ltp
    db.set_cash(db.get_cash() - cost)
    db.create_position(symbol, qty, ltp, round(ltp * (1 - STOP_LOSS_PCT), 2), round(ltp * (1 + TARGET_PCT), 2))
    db.log_trade(symbol, "BUY", qty, ltp, note)
    log.info("BUY %s x%d @ %.2f (%s)", symbol, qty, ltp, note)
    return {"ok": True, "qty": qty, "price": ltp, "reason": reason}


def execute_sell(symbol: str, note: str) -> dict:
    pos = next((p for p in db.open_positions() if p["symbol"] == symbol), None)
    if not pos:
        return {"ok": False, "reason": "no open position in this stock"}
    ltp = market.get_ltp(symbol) or pos["entry_price"]
    db.close_position(pos["id"], ltp, note)
    db.set_cash(db.get_cash() + ltp * pos["qty"])
    db.log_trade(symbol, "SELL", pos["qty"], ltp, note)
    log.info("SELL %s x%d @ %.2f (%s)", symbol, pos["qty"], ltp, note)
    return {"ok": True, "qty": pos["qty"], "price": ltp, "reason": note}


def check_exits() -> list[dict]:
    """Stop-loss / target monitor — call every minute during market hours."""
    exits = []
    for p in db.open_positions():
        ltp = market.get_ltp(p["symbol"])
        if not ltp:
            continue
        if ltp <= p["stop_loss"]:
            exits.append(execute_sell(p["symbol"], "STOP_LOSS_HIT"))
        elif ltp >= p["target"]:
            exits.append(execute_sell(p["symbol"], "TARGET_HIT"))
    return exits
