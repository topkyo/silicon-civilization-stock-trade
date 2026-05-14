"""FastAPI sidecar exposing cached akshare data to the Next.js app.

All endpoints write through a SQLite cache so akshare is hit at most once
per symbol per trading day (klines/fundamentals) or per 30s (realtime).
"""
from __future__ import annotations

import json
import sqlite3
import time
from contextlib import contextmanager
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any

import akshare as ak
import pandas as pd
from fastapi import FastAPI, HTTPException, Query
from pydantic import BaseModel

DB_PATH = Path(__file__).parent / "cache.db"

app = FastAPI(title="silicon-civ pyserver", version="0.1.0")

# ---------- cache ----------------------------------------------------------

SCHEMA = """
CREATE TABLE IF NOT EXISTS cache (
  key TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  ttl_seconds INTEGER NOT NULL
);
"""


@contextmanager
def db():
    conn = sqlite3.connect(DB_PATH)
    conn.execute(SCHEMA)
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def cache_get(key: str) -> Any | None:
    with db() as conn:
        row = conn.execute(
            "SELECT payload, fetched_at, ttl_seconds FROM cache WHERE key = ?",
            (key,),
        ).fetchone()
    if not row:
        return None
    payload, fetched_at, ttl = row
    if ttl > 0 and time.time() - fetched_at > ttl:
        return None
    return json.loads(payload)


def cache_put(key: str, value: Any, ttl_seconds: int) -> None:
    with db() as conn:
        conn.execute(
            "REPLACE INTO cache (key, payload, fetched_at, ttl_seconds) VALUES (?, ?, ?, ?)",
            (key, json.dumps(value, ensure_ascii=False), int(time.time()), ttl_seconds),
        )


def seconds_until_next_trading_close() -> int:
    """TTL so daily klines refresh after the next 15:30 CN market close."""
    now = datetime.now()
    target = now.replace(hour=15, minute=30, second=0, microsecond=0)
    if now >= target:
        target += timedelta(days=1)
    return int((target - now).total_seconds())


# ---------- models ---------------------------------------------------------


class Kline(BaseModel):
    date: str
    open: float
    high: float
    low: float
    close: float
    volume: float


class Fundamental(BaseModel):
    symbol: str
    name: str | None = None
    pe_ttm: float | None = None
    pb: float | None = None
    market_cap: float | None = None  # 亿元
    revenue_yoy: float | None = None
    profit_yoy: float | None = None


class Analyst(BaseModel):
    """Consensus sell-side view aggregated from eastmoney research reports.

    Note: A-share brokers rarely publish a structured 目标价 field — eastmoney
    only exposes forecast EPS. We compute an *implied* target as
    `consensus_eps_next_year × current PE(TTM)`, which is mathematically
    equivalent to "if PE stays flat, what would the price be at next-year EPS".
    """
    symbol: str
    buy_count: int = 0
    total_count: int = 0
    buy_ratio: float | None = None
    consensus_eps_next: float | None = None     # 元
    implied_target: float | None = None          # 元
    current_price: float | None = None           # 元
    upside_pct: float | None = None              # %


# ---------- helpers --------------------------------------------------------


def _normalize_symbol(symbol: str) -> tuple[str, str]:
    """Return (akshare-symbol-no-prefix, market). market in {sh, sz, bj, hk}."""
    s = symbol.lower().strip()
    if s.startswith(("sh", "sz", "bj")):
        return s[2:], s[:2]
    if s.startswith("hk"):
        return s[2:], "hk"
    # A-share heuristic
    if s.startswith(("60", "68", "9")):
        return s, "sh"
    if s.startswith(("00", "30", "20")):
        return s, "sz"
    if s.startswith(("8", "4")):
        return s, "bj"
    return s, "hk"


# ---------- endpoints ------------------------------------------------------


@app.get("/health")
def health():
    return {"ok": True, "time": datetime.now().isoformat()}


@app.get("/klines", response_model=list[Kline])
def klines(
    symbol: str = Query(..., description="e.g. sh600519, 000858, hk00700"),
    start: str = Query("20230101"),
    end: str | None = Query(None),
    adjust: str = Query("qfq", regex="^(|qfq|hfq)$"),
):
    end = end or date.today().strftime("%Y%m%d")
    key = f"kline:{symbol}:{start}:{end}:{adjust}"
    cached = cache_get(key)
    if cached is not None:
        return cached

    code, market = _normalize_symbol(symbol)
    try:
        if market == "hk":
            df = ak.stock_hk_hist(symbol=code, period="daily", start_date=start, end_date=end, adjust=adjust)
        else:
            df = ak.stock_zh_a_hist(symbol=code, period="daily", start_date=start, end_date=end, adjust=adjust)
    except Exception as e:
        raise HTTPException(502, f"akshare error: {e}") from e

    if df is None or df.empty:
        cache_put(key, [], 3600)
        return []

    df = df.rename(columns={"日期": "date", "开盘": "open", "最高": "high", "最低": "low", "收盘": "close", "成交量": "volume"})
    df["date"] = pd.to_datetime(df["date"]).dt.strftime("%Y-%m-%d")
    rows = df[["date", "open", "high", "low", "close", "volume"]].to_dict(orient="records")
    cache_put(key, rows, seconds_until_next_trading_close())
    return rows


@app.get("/fundamental", response_model=Fundamental)
def fundamental(symbol: str):
    key = f"fund:{symbol}"
    cached = cache_get(key)
    if cached is not None:
        return cached

    code, market = _normalize_symbol(symbol)
    out: dict[str, Any] = {"symbol": symbol}
    try:
        if market != "hk":
            # PE(TTM) / PB / 总市值 from eastmoney —— stock_a_indicator_lg was
            # removed in akshare 1.18.x; stock_value_em is the supported successor.
            ind = ak.stock_value_em(symbol=code)
            if ind is not None and not ind.empty:
                latest = ind.iloc[-1]
                pe = latest.get("PE(TTM)")
                pb = latest.get("市净率")
                mc = latest.get("总市值")  # 元
                out["pe_ttm"] = float(pe) if pd.notna(pe) else None
                out["pb"] = float(pb) if pd.notna(pb) else None
                out["market_cap"] = float(mc) / 1e8 if pd.notna(mc) else None  # 元 -> 亿元
            try:
                info = ak.stock_individual_info_em(symbol=code)
                if info is not None and not info.empty:
                    kv = dict(zip(info["item"], info["value"]))
                    out["name"] = kv.get("股票简称")
            except Exception:
                pass
    except Exception as e:
        raise HTTPException(502, f"akshare error: {e}") from e

    cache_put(key, out, 24 * 3600)
    return out


@app.get("/analyst", response_model=Analyst)
def analyst(symbol: str):
    """Sell-side consensus. 24h cache (slow upstream)."""
    key = f"analyst:{symbol}"
    cached = cache_get(key)
    if cached is not None:
        return cached

    code, market = _normalize_symbol(symbol)
    out: dict[str, Any] = {"symbol": symbol}
    if market == "hk":
        # eastmoney research-report API is A-share only. Leave fields null.
        cache_put(key, out, 24 * 3600)
        return out

    try:
        df = ak.stock_research_report_em(symbol=code)
    except Exception as e:
        raise HTTPException(502, f"akshare error: {e}") from e

    if df is None or df.empty:
        cache_put(key, out, 24 * 3600)
        return out

    out["total_count"] = int(len(df))
    if "东财评级" in df.columns:
        out["buy_count"] = int((df["东财评级"] == "买入").sum())
        out["buy_ratio"] = round(out["buy_count"] / out["total_count"], 3) if out["total_count"] else None

    # consensus EPS for next fiscal year — pick the smallest year column we have
    year_cols = sorted(
        c for c in df.columns if c.endswith("-盈利预测-收益") and c[:4].isdigit()
    )
    if year_cols:
        # Skip the first column if it is the current year; prefer the next one.
        import datetime as _dt
        this_year = _dt.date.today().year
        next_col = next((c for c in year_cols if int(c[:4]) >= this_year + 1), year_cols[0])
        series = pd.to_numeric(df[next_col], errors="coerce").dropna()
        if not series.empty:
            out["consensus_eps_next"] = round(float(series.median()), 4)

    # current price + PE(TTM) from stock_value_em to compute implied target.
    try:
        val = ak.stock_value_em(symbol=code)
        if val is not None and not val.empty:
            latest = val.iloc[-1]
            price = latest.get("当日收盘价")
            pe = latest.get("PE(TTM)")
            if pd.notna(price):
                out["current_price"] = round(float(price), 3)
            if out.get("consensus_eps_next") is not None and pd.notna(pe):
                out["implied_target"] = round(out["consensus_eps_next"] * float(pe), 3)
                if out.get("current_price"):
                    out["upside_pct"] = round(
                        (out["implied_target"] / out["current_price"] - 1) * 100, 2
                    )
    except Exception:
        pass

    cache_put(key, out, 24 * 3600)
    return out


@app.get("/spot")
def spot(symbol: str):
    """30-second TTL realtime quote."""
    key = f"spot:{symbol}"
    cached = cache_get(key)
    if cached is not None:
        return cached
    code, market = _normalize_symbol(symbol)
    try:
        if market == "hk":
            df = ak.stock_hk_spot_em()
            row = df[df["代码"] == code]
        else:
            df = ak.stock_zh_a_spot_em()
            row = df[df["代码"] == code]
    except Exception as e:
        raise HTTPException(502, f"akshare error: {e}") from e
    if row.empty:
        raise HTTPException(404, f"symbol {symbol} not found")
    r = row.iloc[0]
    out = {
        "symbol": symbol,
        "name": str(r.get("名称", "")),
        "price": float(r.get("最新价", 0) or 0),
        "change_pct": float(r.get("涨跌幅", 0) or 0),
        "volume": float(r.get("成交量", 0) or 0),
        "turnover": float(r.get("成交额", 0) or 0),
    }
    cache_put(key, out, 30)
    return out
