"""SQLite persistence layer. No ORM — plain sqlite3, one file."""
import json
import os
import sqlite3
import threading
from datetime import datetime, timezone

DB_PATH = os.environ.get("TRADEAI_DB", os.path.join(os.path.dirname(__file__), "data", "tradeai.db"))
_lock = threading.Lock()

SCHEMA = """
CREATE TABLE IF NOT EXISTS config (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS positions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol      TEXT NOT NULL,
    qty         INTEGER NOT NULL,
    entry_price REAL NOT NULL,
    stop_loss   REAL NOT NULL,
    target      REAL NOT NULL,
    status      TEXT NOT NULL DEFAULT 'OPEN',
    exit_price  REAL,
    exit_reason TEXT,
    opened_at   TEXT NOT NULL,
    closed_at   TEXT
);
CREATE TABLE IF NOT EXISTS trades (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol  TEXT NOT NULL,
    side    TEXT NOT NULL,
    qty     INTEGER NOT NULL,
    price   REAL NOT NULL,
    note    TEXT,
    ts      TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS council_sessions (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol            TEXT NOT NULL,
    claude_action     TEXT,
    claude_confidence REAL,
    claude_reasoning  TEXT,
    gemini_action     TEXT,
    gemini_confidence REAL,
    gemini_reasoning  TEXT,
    final_action      TEXT NOT NULL,
    outcome           TEXT NOT NULL,
    ts                TEXT NOT NULL
);
"""

DEFAULTS = {
    "cash": "500000",
    "initial_capital": "500000",
    "watchlist": json.dumps(["RELIANCE.NS", "HDFCBANK.NS", "INFY.NS", "TATAMOTORS.NS", "ICICIBANK.NS"]),
    "kill_switch": "0",
    "max_position_pct": "20",
    "max_positions": "5",
    "min_cash_pct": "10",
    "min_confidence": "60",
}


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def conn() -> sqlite3.Connection:
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    c = sqlite3.connect(DB_PATH)
    c.row_factory = sqlite3.Row
    return c


def init():
    with _lock, conn() as c:
        c.executescript(SCHEMA)
        for k, v in DEFAULTS.items():
            c.execute("INSERT OR IGNORE INTO config (key, value) VALUES (?, ?)", (k, v))


def get_config(key: str) -> str:
    with conn() as c:
        row = c.execute("SELECT value FROM config WHERE key = ?", (key,)).fetchone()
        return row["value"] if row else DEFAULTS.get(key, "")


def set_config(key: str, value: str):
    with _lock, conn() as c:
        c.execute("INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", (key, value))


def get_cash() -> float:
    return float(get_config("cash"))


def set_cash(v: float):
    set_config("cash", f"{v:.2f}")


def get_watchlist() -> list[str]:
    return json.loads(get_config("watchlist"))


def open_positions() -> list[dict]:
    with conn() as c:
        return [dict(r) for r in c.execute("SELECT * FROM positions WHERE status = 'OPEN' ORDER BY opened_at")]


def create_position(symbol: str, qty: int, entry_price: float, stop_loss: float, target: float) -> int:
    with _lock, conn() as c:
        cur = c.execute(
            "INSERT INTO positions (symbol, qty, entry_price, stop_loss, target, opened_at) VALUES (?, ?, ?, ?, ?, ?)",
            (symbol, qty, entry_price, stop_loss, target, now()),
        )
        return cur.lastrowid


def close_position(pos_id: int, exit_price: float, reason: str):
    with _lock, conn() as c:
        c.execute(
            "UPDATE positions SET status = 'CLOSED', exit_price = ?, exit_reason = ?, closed_at = ? WHERE id = ? AND status = 'OPEN'",
            (exit_price, reason, now(), pos_id),
        )


def log_trade(symbol: str, side: str, qty: int, price: float, note: str = ""):
    with _lock, conn() as c:
        c.execute("INSERT INTO trades (symbol, side, qty, price, note, ts) VALUES (?, ?, ?, ?, ?, ?)",
                  (symbol, side, qty, price, note, now()))


def recent_trades(limit: int = 50) -> list[dict]:
    with conn() as c:
        return [dict(r) for r in c.execute("SELECT * FROM trades ORDER BY id DESC LIMIT ?", (limit,))]


def log_council(symbol: str, claude: dict | None, gemini: dict | None, final_action: str, outcome: str):
    cl = claude or {}
    ge = gemini or {}
    with _lock, conn() as c:
        c.execute(
            """INSERT INTO council_sessions
               (symbol, claude_action, claude_confidence, claude_reasoning,
                gemini_action, gemini_confidence, gemini_reasoning, final_action, outcome, ts)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (symbol, cl.get("action"), cl.get("confidence"), cl.get("reasoning"),
             ge.get("action"), ge.get("confidence"), ge.get("reasoning"), final_action, outcome, now()),
        )


def recent_council(limit: int = 30) -> list[dict]:
    with conn() as c:
        return [dict(r) for r in c.execute("SELECT * FROM council_sessions ORDER BY id DESC LIMIT ?", (limit,))]


def realized_pnl() -> float:
    with conn() as c:
        row = c.execute(
            "SELECT COALESCE(SUM((exit_price - entry_price) * qty), 0) AS pnl FROM positions WHERE status = 'CLOSED'"
        ).fetchone()
        return float(row["pnl"])
