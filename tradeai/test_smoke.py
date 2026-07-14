"""Offline smoke test: engine + db + council arbitration, with quotes stubbed.

Run: python3 test_smoke.py   (uses a throwaway DB, no network needed)
"""
import os
import tempfile

os.environ["TRADEAI_DB"] = os.path.join(tempfile.mkdtemp(), "test.db")

import db
import engine
import market
from council import arbitrate, _parse_verdict, resolve_degraded, rule_signal

FAKE_PRICES = {"RELIANCE.NS": 2450.0}
market.get_ltp = lambda symbol: FAKE_PRICES.get(symbol)

passed = 0

def check(name, cond):
    global passed
    assert cond, f"FAIL: {name}"
    passed += 1
    print(f"  ok: {name}")

db.init()
print("engine:")
r = engine.execute_buy("RELIANCE.NS", "test")
check("buy executes", r["ok"] and r["price"] == 2450.0)
check("position sized to 20% cap", r["qty"] == int(100000 // 2450))  # 20% of 5L
check("cash deducted", abs(db.get_cash() - (500000 - r["qty"] * 2450)) < 0.01)
check("duplicate buy rejected", not engine.execute_buy("RELIANCE.NS", "test")["ok"])

pf = engine.portfolio_value()
check("portfolio total conserved", abs(pf["total"] - 500000) < 0.01)

FAKE_PRICES["RELIANCE.NS"] = 2450 * 0.96  # below 3% stop
exits = engine.check_exits()
check("stop-loss auto-exit fires", len(exits) == 1 and exits[0]["reason"] == "STOP_LOSS_HIT")
check("position closed", not db.open_positions())
check("realized loss recorded", db.realized_pnl() < 0)
check("sell without position rejected", not engine.execute_sell("INFY.NS", "test")["ok"])

print("council arbitration:")
buy = lambda c: {"action": "BUY", "confidence": c, "reasoning": ""}
sell = lambda c: {"action": "SELL", "confidence": c, "reasoning": ""}
hold = lambda c: {"action": "HOLD", "confidence": c, "reasoning": ""}
check("unanimous buy executes", arbitrate(buy(80), buy(70), 60) == ("BUY", "EXECUTE"))
check("low confidence holds", arbitrate(buy(50), buy(55), 60) == ("HOLD", "LOW_CONFIDENCE_HOLD"))
check("hard split blocks", arbitrate(buy(90), sell(90), 60) == ("HOLD", "HARD_SPLIT"))
check("soft split holds", arbitrate(buy(80), hold(50), 60) == ("HOLD", "SOFT_SPLIT"))
check("unanimous hold", arbitrate(hold(80), hold(80), 60) == ("HOLD", "UNANIMOUS_HOLD"))
check("unanimous sell executes", arbitrate(sell(75), sell(70), 60) == ("SELL", "EXECUTE"))

print("fallback ladder:")
bull = {"symbol": "X.NS", "rsi14": 58, "above_ema20": True, "above_ema50": True, "volume_ratio": 1.5}
bear = {"symbol": "X.NS", "rsi14": 30, "above_ema20": False, "above_ema50": False, "volume_ratio": 1.0}
pos = {"qty": 10, "entry_price": 100.0, "stop_loss": 97.0, "target": 106.0}

r = resolve_degraded(buy(80), buy(70), bull, None, 60)
check("full council still works", r["mode"] == "FULL" and r["outcome"] == "EXECUTE")
r = resolve_degraded(None, buy(80), bull, None, 60)
check("solo executes above raised bar", r["mode"] == "SOLO_GEMINI" and r["outcome"] == "EXECUTE_SOLO")
r = resolve_degraded(None, buy(70), bull, None, 60)
check("solo blocks below raised bar (70 < 75)", r["outcome"] == "SOLO_LOW_CONFIDENCE" and r["final_action"] == "HOLD")
r = resolve_degraded(buy(90), None, bull, None, 60)
check("claude solo mode labelled", r["mode"] == "SOLO_CLAUDE")
r = resolve_degraded(None, None, bear, pos, 60)
check("rule engine protective exit executes", r["mode"] == "RULE_ONLY" and r["outcome"] == "EXECUTE_RULE_EXIT" and r["final_action"] == "SELL")
r = resolve_degraded(None, None, bull, None, 60)
check("rule engine never opens positions", r["outcome"] == "RULE_SUGGEST_BUY" and r["final_action"] == "HOLD")
check("rule signal holds on mixed data", rule_signal({"symbol": "X.NS", "rsi14": 50, "above_ema20": True, "above_ema50": False, "volume_ratio": 1.0}, None)["action"] == "HOLD")

print("verdict parsing:")
v = _parse_verdict('{"action": "buy", "confidence": 72, "reasoning": "x"}', "m")
check("parses plain json + uppercases", v["action"] == "BUY" and v["confidence"] == 72)
v = _parse_verdict('```json\n{"action": "HOLD", "confidence": 40, "reasoning": "y"}\n```', "m")
check("parses fenced json", v["action"] == "HOLD")

print(f"\nALL {passed} CHECKS PASSED")
