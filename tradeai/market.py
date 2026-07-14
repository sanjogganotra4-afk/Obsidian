"""Live Indian market data via yfinance (free, NSE symbols end in .NS)."""
import logging
import time

import yfinance as yf

log = logging.getLogger("tradeai.market")

_quote_cache: dict[str, tuple[float, float]] = {}  # symbol -> (price, fetched_at)
QUOTE_TTL = 30  # seconds


def get_ltp(symbol: str) -> float | None:
    """Last traded price with a short cache so the 1-min monitor doesn't hammer Yahoo."""
    cached = _quote_cache.get(symbol)
    if cached and time.time() - cached[1] < QUOTE_TTL:
        return cached[0]
    try:
        t = yf.Ticker(symbol)
        price = t.fast_info.get("last_price") or t.fast_info.get("lastPrice")
        if not price:
            hist = t.history(period="1d", interval="1m")
            if hist.empty:
                hist = t.history(period="5d")
            price = float(hist["Close"].iloc[-1]) if not hist.empty else None
        if price:
            price = float(price)
            _quote_cache[symbol] = (price, time.time())
        return price
    except Exception as e:
        log.warning("quote failed for %s: %s", symbol, e)
        return None


def _rsi(closes, period: int = 14) -> float | None:
    if len(closes) < period + 1:
        return None
    delta = closes.diff()
    gain = delta.clip(lower=0).rolling(period).mean()
    loss = (-delta.clip(upper=0)).rolling(period).mean()
    rs = gain / loss.replace(0, 1e-9)
    return round(float((100 - 100 / (1 + rs)).iloc[-1]), 1)


def get_analysis(symbol: str) -> dict | None:
    """Daily candles + indicators — the packet both council models analyse."""
    try:
        hist = yf.Ticker(symbol).history(period="3mo", interval="1d")
        if hist.empty or len(hist) < 20:
            return None
        closes = hist["Close"]
        vols = hist["Volume"]
        ltp = float(closes.iloc[-1])
        ema20 = float(closes.ewm(span=20).mean().iloc[-1])
        ema50 = float(closes.ewm(span=50).mean().iloc[-1])
        avg_vol = float(vols.tail(20).mean())
        return {
            "symbol": symbol,
            "ltp": round(ltp, 2),
            "change_1d_pct": round((ltp / float(closes.iloc[-2]) - 1) * 100, 2),
            "change_5d_pct": round((ltp / float(closes.iloc[-6]) - 1) * 100, 2) if len(closes) > 6 else None,
            "rsi14": _rsi(closes),
            "ema20": round(ema20, 2),
            "ema50": round(ema50, 2),
            "above_ema20": ltp > ema20,
            "above_ema50": ltp > ema50,
            "volume_ratio": round(float(vols.iloc[-1]) / avg_vol, 2) if avg_vol else None,
            "last_10_closes": [round(float(x), 2) for x in closes.tail(10)],
        }
    except Exception as e:
        log.warning("analysis failed for %s: %s", symbol, e)
        return None
