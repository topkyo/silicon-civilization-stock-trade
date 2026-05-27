"""FastAPI sidecar wrapping free-first market data providers.

Data-source split:
- A-share (sh/sz/bj): AkShare/Eastmoney for current price/basic metrics;
  BaoStock for historical daily bars and growth fallback; Tushare Pro is an
  explicit secondary source only.
- HK: akshare's stock_hk_hist — Tushare's hk_daily is hard-capped at
  10 calls/day on the free Pro tier (and 2/min within that), making it
  unusable for a HK watchlist beyond the first ~10 requests of the day.

All responses write through a SQLite cache so upstream is hit at most once
per symbol per trading day (klines/fundamentals/analyst) or per 30s (spot).
"""
from __future__ import annotations

import io
import json
import os
import re
import sqlite3
import time
from contextlib import contextmanager, redirect_stdout
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any

import akshare as ak
import baostock as bs
import pandas as pd
import requests
import tushare as ts
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Query
from pydantic import BaseModel

# ---------- bootstrap ------------------------------------------------------

load_dotenv(Path(__file__).parent / ".env")


MARKET_HTTP_PROXY = os.environ.get("MARKET_HTTP_PROXY", "").strip()


def _strip_proxy_env() -> None:
    """Use MARKET_HTTP_PROXY when set (VPN); else drop broken inherited proxies."""
    for key in (
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
    ):
        os.environ.pop(key, None)
    if MARKET_HTTP_PROXY:
        os.environ["HTTP_PROXY"] = MARKET_HTTP_PROXY
        os.environ["HTTPS_PROXY"] = MARKET_HTTP_PROXY
        return
    os.environ.setdefault(
        "NO_PROXY",
        "localhost,127.0.0.1,::1,push2.eastmoney.com,push2his.eastmoney.com,.eastmoney.com",
    )


_strip_proxy_env()
TUSHARE_TOKEN = os.environ.get("TUSHARE_TOKEN", "").strip()
MOCK_MODE = TUSHARE_TOKEN.lower() == "mock"
HAS_TUSHARE_TOKEN = TUSHARE_TOKEN.lower() not in {"", "mock", "your-tushare-pro-token-here"}
STRICT_LIVE_DATA = os.environ.get("STRICT_LIVE_DATA", "0").strip() == "1"
MARKET_ENABLE_TUSHARE_SECONDARY = os.environ.get("MARKET_ENABLE_TUSHARE_SECONDARY", "0").strip() == "1"
if STRICT_LIVE_DATA and MOCK_MODE:
    raise RuntimeError("STRICT_LIVE_DATA=1 requires a real TUSHARE_TOKEN")
if MARKET_ENABLE_TUSHARE_SECONDARY and not HAS_TUSHARE_TOKEN:
    raise RuntimeError("MARKET_ENABLE_TUSHARE_SECONDARY=1 requires a real TUSHARE_TOKEN")
CACHE_NAMESPACE = "mock" if MOCK_MODE else "live"
from mock_data import BENCHMARKS  # noqa: E402
if MOCK_MODE:
    from mock_data import (  # noqa: E402
        mock_analyst,
        mock_fundamental,
        mock_klines,
        mock_spot,
    )

    _pro = None
elif HAS_TUSHARE_TOKEN:
    ts.set_token(TUSHARE_TOKEN)
    _pro = ts.pro_api()
else:
    _pro = None

DB_PATH = Path(os.environ.get("PYSERVER_CACHE_DB", Path(__file__).parent / "cache.db"))
DB_PATH.parent.mkdir(parents=True, exist_ok=True)
NEGATIVE_CACHE = {"__negative_cache__": True}

# Bypass broken shell proxies (e.g. 127.0.0.1:7890) for Eastmoney spot quotes.
_EM_SESSION: requests.Session | None = None


def _requests_get_no_proxy(url: str, *, params: dict[str, Any], timeout: float) -> requests.Response:
    global _EM_SESSION
    if _EM_SESSION is None:
        _EM_SESSION = requests.Session()
        _EM_SESSION.trust_env = False
        if MARKET_HTTP_PROXY:
            _EM_SESSION.proxies = {
                "http": MARKET_HTTP_PROXY,
                "https": MARKET_HTTP_PROXY,
            }
    return _EM_SESSION.get(url, params=params, timeout=timeout)


app = FastAPI(title="silicon-civ pyserver", version="0.2.0")

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
    scoped_key = f"{CACHE_NAMESPACE}:{key}"
    with db() as conn:
        row = conn.execute(
            "SELECT payload, fetched_at, ttl_seconds FROM cache WHERE key = ?",
            (scoped_key,),
        ).fetchone()
    if not row:
        return None
    payload, fetched_at, ttl = row
    if ttl > 0 and time.time() - fetched_at > ttl:
        return None
    return json.loads(payload)


def cache_put(key: str, value: Any, ttl_seconds: int) -> None:
    scoped_key = f"{CACHE_NAMESPACE}:{key}"
    with db() as conn:
        conn.execute(
            "REPLACE INTO cache (key, payload, fetched_at, ttl_seconds) VALUES (?, ?, ?, ?)",
            (scoped_key, json.dumps(value, ensure_ascii=False), int(time.time()), ttl_seconds),
        )


def seconds_until_next_trading_close() -> int:
    """TTL so daily klines refresh after the next 15:30 CN market close."""
    now = datetime.now()
    target = now.replace(hour=15, minute=30, second=0, microsecond=0)
    if now >= target:
        target += timedelta(days=1)
    return int((target - now).total_seconds())


# ---------- retry wrapper + per-endpoint rate limiter ----------------------

import threading
from collections import deque


class _TokenBucket:
    """Simple token bucket — at most `n` calls per `window_s` seconds."""

    def __init__(self, n: int, window_s: float) -> None:
        self.n = n
        self.window = window_s
        self.calls: deque[float] = deque()
        self.lock = threading.Lock()

    def acquire(self) -> None:
        while True:
            with self.lock:
                now = time.monotonic()
                while self.calls and now - self.calls[0] > self.window:
                    self.calls.popleft()
                if len(self.calls) < self.n:
                    self.calls.append(now)
                    return
                wait = self.window - (now - self.calls[0]) + 0.05
            time.sleep(wait)


# Tushare free tier caps hk_daily at 2/minute. Self-throttle to avoid 502s.
_HK_DAILY_LIMITER = _TokenBucket(n=2, window_s=65)
_REPORT_RC_LIMITER = _TokenBucket(n=2, window_s=65)
_DAILY_BASIC_LIMITER = _TokenBucket(n=2, window_s=65)
_FINA_INDICATOR_LIMITER = _TokenBucket(n=2, window_s=65)
_AK_LOCK = threading.Lock()
_BS_LOCK = threading.Lock()


def _ak_call(fn, *args, **kwargs):
    # Some AkShare paths use native JavaScript runtimes that are not safe when
    # entered concurrently from FastAPI's worker threads.
    with _AK_LOCK:
        return fn(*args, **kwargs)


def _with_retries(fn, *args, attempts: int = 3, base_delay: float = 0.5, **kwargs):
    last: Exception | None = None
    for i in range(attempts):
        try:
            return fn(*args, **kwargs)
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(base_delay * (2 ** i))
    assert last is not None
    raise last


def _hk_daily(**kwargs):
    """Rate-limited wrapper around pro.hk_daily."""
    _HK_DAILY_LIMITER.acquire()
    return _pro.hk_daily(**kwargs)


def _report_rc(**kwargs):
    """Rate-limited wrapper around pro.report_rc."""
    if not MARKET_ENABLE_TUSHARE_SECONDARY:
        raise RuntimeError("Tushare report_rc secondary source is disabled")
    _REPORT_RC_LIMITER.acquire()
    return _pro.report_rc(**kwargs)


def _daily_basic(**kwargs):
    """Rate-limited wrapper around pro.daily_basic."""
    if not MARKET_ENABLE_TUSHARE_SECONDARY:
        raise RuntimeError("Tushare daily_basic secondary source is disabled")
    _DAILY_BASIC_LIMITER.acquire()
    return _pro.daily_basic(**kwargs)


def _fina_indicator(**kwargs):
    """Rate-limited wrapper around pro.fina_indicator."""
    if not MARKET_ENABLE_TUSHARE_SECONDARY:
        raise RuntimeError("Tushare fina_indicator secondary source is disabled")
    _FINA_INDICATOR_LIMITER.acquire()
    return _pro.fina_indicator(**kwargs)


def _latest_profit_yoy(ts_code: str) -> float | None:
    """Return the latest available net-profit growth percentage for PEG."""
    if _pro is None or not MARKET_ENABLE_TUSHARE_SECONDARY:
        return None
    start = (date.today() - timedelta(days=540)).strftime("%Y%m%d")
    today = date.today().strftime("%Y%m%d")
    df = _with_retries(
        _fina_indicator,
        ts_code=ts_code,
        start_date=start,
        end_date=today,
        fields="ts_code,ann_date,end_date,netprofit_yoy,q_netprofit_yoy,q_profit_yoy",
    )
    if df is None or df.empty:
        return None
    df = df.sort_values(["end_date", "ann_date"], na_position="first")
    latest = df.iloc[-1]
    for col in ("netprofit_yoy", "q_netprofit_yoy", "q_profit_yoy"):
        value = _num_or_none(latest.get(col))
        if value is not None:
            return value
    return None


def _attach_profit_yoy(out: dict[str, Any], ts_code: str, market: str) -> None:
    if market == "hk":
        return
    profit_yoy = _baostock_growth_yoy(ts_code)
    if profit_yoy is not None:
        out["profit_yoy"] = profit_yoy
        out.setdefault("field_sources", {})["profit_yoy"] = "baostock_growth"
        return
    if not MARKET_ENABLE_TUSHARE_SECONDARY:
        out.setdefault("warnings", []).append("profit_yoy unavailable from free sources; Tushare secondary disabled")
        return
    try:
        profit_yoy = _latest_profit_yoy(ts_code)
    except Exception as e:
        out.setdefault("warnings", []).append(f"tushare fina_indicator unavailable: {e}")
        return
    if profit_yoy is not None:
        out["profit_yoy"] = profit_yoy
        out.setdefault("field_sources", {})["profit_yoy"] = "tushare_fina_indicator"


def _source_summary(field_sources: dict[str, str]) -> str:
    providers = {
        source.split("_", 1)[0]
        for source in field_sources.values()
        if not source.startswith("derived_")
    }
    if not providers:
        return "unknown"
    if providers == {"akshare"}:
        return "akshare_primary"
    if providers == {"tushare"}:
        return "tushare_only"
    if providers == {"baostock"}:
        return "baostock_only"
    if {"akshare", "baostock", "tushare"}.issubset(providers):
        return "akshare+baostock+tushare"
    if "akshare" in providers and "tushare" in providers:
        return "akshare+tushare"
    if "akshare" in providers and "baostock" in providers:
        return "akshare+baostock"
    if "baostock" in providers and "tushare" in providers:
        return "baostock+tushare"
    return "unknown"


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
    latest_close: float | None = None
    latest_date: str | None = None
    change_pct: float | None = None
    revenue_yoy: float | None = None
    profit_yoy: float | None = None
    source: str | None = None
    fetched_at: str | None = None
    error: str | None = None
    warnings: list[str] | None = None
    field_sources: dict[str, str] | None = None


class Analyst(BaseModel):
    symbol: str
    buy_count: int | None = None
    total_count: int | None = None
    buy_ratio: float | None = None
    consensus_eps_next: float | None = None
    implied_target: float | None = None
    current_price: float | None = None
    upside_pct: float | None = None
    source: str | None = None
    fetched_at: str | None = None
    error: str | None = None
    warnings: list[str] | None = None
    field_sources: dict[str, str] | None = None


# ---------- symbol normalization -------------------------------------------


def _to_ts_code(symbol: str) -> tuple[str, str]:
    """Convert internal symbol -> (ts_code, market). market in {sh, sz, bj, hk}."""
    s = symbol.lower().strip()
    if "." in s:
        code, suffix = s.split(".", 1)
        mkt = suffix[:2]
        if mkt in {"sh", "sz", "bj"}:
            return code + {"sh": ".SH", "sz": ".SZ", "bj": ".BJ"}[mkt], mkt
        if mkt == "hk":
            return code.zfill(5) + ".HK", "hk"
    if s.startswith(("sh", "sz", "bj")):
        code, mkt = s[2:], s[:2]
    elif s.startswith("hk"):
        code, mkt = s[2:].zfill(5), "hk"
    elif s.startswith(("60", "68", "9")):
        code, mkt = s, "sh"
    elif s.startswith(("00", "30", "20")):
        code, mkt = s, "sz"
    elif s.startswith(("8", "4")):
        code, mkt = s, "bj"
    else:
        code, mkt = s.zfill(5), "hk"
    suffix = {"sh": ".SH", "sz": ".SZ", "bj": ".BJ", "hk": ".HK"}[mkt]
    return code + suffix, mkt


# Tushare expects YYYYMMDD; the route accepts both forms.
def _date(s: str) -> str:
    s = s.replace("-", "")
    return s


def _num_or_none(value: Any) -> float | None:
    if value is None or pd.isna(value):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    matches = re.findall(r"-?\d+(?:\.\d+)?", str(value))
    if not matches:
        return None
    nums = [float(x) for x in matches]
    return sum(nums) / len(nums)


def _compact_code(ts_code: str) -> str:
    return ts_code.split(".")[0]


def _ak_col(row: pd.Series, *names: str) -> Any:
    for name in names:
        if name in row and pd.notna(row.get(name)):
            return row.get(name)
    return None


def _market_cap_to_yi(value: float | None) -> float | None:
    if value is None:
        return None
    # AkShare's Eastmoney spot endpoint reports market cap in yuan. Keep this
    # defensive in case an alternate backend already returns 亿元.
    if abs(value) > 1_000_000:
        return value / 1e8
    return value


def _eastmoney_market_code(market: str) -> int:
    # Eastmoney uses 1 for Shanghai and 0 for Shenzhen/Beijing in these quote
    # endpoints.
    return 1 if market == "sh" else 0


_AK_HIST_RENAME = {
    "日期": "date",
    "开盘": "open",
    "最高": "high",
    "最低": "low",
    "收盘": "close",
    "成交量": "volume",
    "成交额": "amount",
    "涨跌幅": "pct_chg",
}


def _ak_a_hist_df(code: str, start: str, end: str, adjust: str = "qfq") -> pd.DataFrame | None:
    """A-share daily bars via AkShare.

    Eastmoney's push2his endpoint is fast but can disconnect/IP-throttle.
    Sina's daily endpoint is slower and less feature-rich, but has been more
    reliable for this watchlist, so use it as the second AkShare path before
    falling back to Tushare.
    """
    try:
        df = _with_retries(
            _ak_call,
            ak.stock_zh_a_hist,
            symbol=code,
            period="daily",
            start_date=start,
            end_date=end,
            adjust=adjust or "",
        )
    except Exception:
        df = None
    if df is not None and not df.empty:
        return df
    try:
        df = _with_retries(
            _ak_call,
            ak.stock_zh_a_daily,
            symbol=f"{_infer_market_prefix(code)}{code}",
            start_date=start,
            end_date=end,
            adjust=adjust or "",
            attempts=2,
            base_delay=0.2,
        )
    except Exception:
        return None
    if df is None or df.empty:
        return None
    return df


def _infer_market_prefix(code: str) -> str:
    if code.startswith(("60", "68", "9")):
        return "sh"
    if code.startswith(("8", "4")):
        return "bj"
    return "sz"


def _rows_from_ak_hist(df: pd.DataFrame) -> list[dict[str, Any]]:
    out = df.rename(columns=_AK_HIST_RENAME)
    if "date" in out.columns:
        out["date"] = pd.to_datetime(out["date"]).dt.strftime("%Y-%m-%d")
    cols = [c for c in ("date", "open", "high", "low", "close", "volume") if c in out.columns]
    return out[cols].to_dict(orient="records")


def _baostock_code(ts_code: str) -> str:
    code, suffix = ts_code.split(".")
    return f"{suffix.lower()}.{code}"


def _baostock_login():
    with redirect_stdout(io.StringIO()):
        lg = bs.login()
    if getattr(lg, "error_code", "0") != "0":
        raise RuntimeError(getattr(lg, "error_msg", "BaoStock login failed"))
    return lg


def _baostock_logout() -> None:
    with redirect_stdout(io.StringIO()):
        bs.logout()


def _baostock_hist_df(ts_code: str, start: str, end: str, adjust: str) -> pd.DataFrame | None:
    """A-share daily bars via BaoStock as the free secondary source."""
    if ts_code.endswith(".HK"):
        return None
    start_s = f"{start[:4]}-{start[4:6]}-{start[6:]}"
    end_s = f"{end[:4]}-{end[4:6]}-{end[6:]}"
    adjustflag = {"qfq": "2", "hfq": "1", "": "3"}.get(adjust, "2")
    fields = "date,code,open,high,low,close,volume,amount,pctChg"
    with _BS_LOCK:
        _baostock_login()
        try:
            rs = bs.query_history_k_data_plus(
                _baostock_code(ts_code),
                fields,
                start_date=start_s,
                end_date=end_s,
                frequency="d",
                adjustflag=adjustflag,
            )
            if getattr(rs, "error_code", "0") != "0":
                return None
            data: list[list[str]] = []
            while rs.next():
                data.append(rs.get_row_data())
        finally:
            _baostock_logout()
    if not data:
        return None
    df = pd.DataFrame(data, columns=rs.fields)
    for col in ("open", "high", "low", "close", "volume"):
        df[col] = pd.to_numeric(df[col], errors="coerce")
    df = df.dropna(subset=["date", "open", "high", "low", "close"])
    if df.empty:
        return None
    return df


def _rows_from_baostock_hist(df: pd.DataFrame) -> list[dict[str, Any]]:
    out = df.sort_values("date").copy()
    out["date"] = pd.to_datetime(out["date"]).dt.strftime("%Y-%m-%d")
    return out[["date", "open", "high", "low", "close", "volume"]].to_dict(orient="records")


def _baostock_growth_yoy(ts_code: str) -> float | None:
    """Latest annual/quarterly YOY net-profit growth from BaoStock."""
    if ts_code.endswith(".HK"):
        return None
    cache_key = f"baostock:growth:v2:{ts_code}"
    cached = cache_get(cache_key)
    if cached is not None:
        if isinstance(cached, dict) and cached.get("__negative_cache__"):
            return None
        return _num_or_none(cached.get("profit_yoy"))

    current_year = date.today().year
    with _BS_LOCK:
        _baostock_login()
        try:
            for year in range(current_year, current_year - 4, -1):
                for quarter in (4, 3, 2, 1):
                    rs = bs.query_growth_data(code=_baostock_code(ts_code), year=year, quarter=quarter)
                    if getattr(rs, "error_code", "0") != "0":
                        continue
                    rows: list[list[str]] = []
                    while rs.next():
                        rows.append(rs.get_row_data())
                    if not rows:
                        continue
                    df = pd.DataFrame(rows, columns=rs.fields)
                    if df.empty or "YOYNI" not in df.columns:
                        continue
                    value = _num_or_none(df.iloc[-1].get("YOYNI"))
                    if value is not None:
                        profit_yoy = value * 100
                        cache_put(cache_key, {"profit_yoy": profit_yoy}, 24 * 3600)
                        return profit_yoy
        finally:
            _baostock_logout()
    cache_put(cache_key, NEGATIVE_CACHE, 3600)
    return None


def _ak_stock_value_row(ts_code: str) -> dict[str, Any] | None:
    """Latest valuation row from AkShare stock_value_em."""
    if ts_code.endswith(".HK"):
        return None
    code = _compact_code(ts_code)
    key = f"ak:stock_value_em:v1:{code}"
    cached = cache_get(key)
    if cached is not None:
        if isinstance(cached, dict) and cached.get("__negative_cache__"):
            return None
        return cached
    try:
        df = _with_retries(
            _ak_call,
            ak.stock_value_em,
            symbol=code,
            attempts=2,
            base_delay=0.2,
        )
    except Exception:
        cache_put(key, NEGATIVE_CACHE, 300)
        return None
    if df is None or df.empty:
        cache_put(key, NEGATIVE_CACHE, 300)
        return None
    df = df.sort_values("数据日期") if "数据日期" in df.columns else df
    row = df.iloc[-1]
    out = {
        "latest_date": str(row.get("数据日期") or ""),
        "latest_close": _num_or_none(_ak_col(row, "当日收盘价", "收盘价", "close")),
        "change_pct": _num_or_none(_ak_col(row, "当日涨跌幅", "涨跌幅", "pct_chg")),
        "pe_ttm": _num_or_none(_ak_col(row, "PE(TTM)", "市盈率TTM", "市盈率-动态")),
        "pb": _num_or_none(_ak_col(row, "市净率", "PB")),
        "market_cap": _market_cap_to_yi(_num_or_none(_ak_col(row, "总市值"))),
    }
    cache_put(key, out, seconds_until_next_trading_close())
    return out


def _ak_a_spot_from_hist(ts_code: str, market: str, symbol: str) -> dict[str, Any] | None:
    """Last daily bar as a spot quote when Eastmoney realtime is unreachable."""
    if market not in {"sh", "sz", "bj"}:
        return None
    code = _compact_code(ts_code)
    end = date.today().strftime("%Y%m%d")
    start = (date.today() - timedelta(days=15)).strftime("%Y%m%d")
    df = _ak_a_hist_df(code, start, end, "qfq")
    if df is None:
        return None
    row = df.iloc[-1]
    price = _num_or_none(_ak_col(row, "收盘", "close"))
    if price is None:
        return None
    return {
        "symbol": symbol,
        "name": str(row.get("名称") or ""),
        "price": price,
        "change_pct": _num_or_none(_ak_col(row, "涨跌幅", "pct_chg")) or 0,
        "volume": _num_or_none(_ak_col(row, "成交量", "volume")) or 0,
        "turnover": _num_or_none(_ak_col(row, "成交额", "amount")) or 0,
    }


def _ak_a_spot_rows(ts_code: str, market: str) -> dict[str, Any] | None:
    """Fetch/cached A-share spot quote with a hard timeout.

    AkShare's whole-market spot helpers paginate thousands of rows and can take
    tens of seconds. This mirrors the single-symbol Eastmoney endpoint used by
    AkShare so a slow upstream can fall back to Tushare quickly.
    """
    code = _compact_code(ts_code)
    key = f"ak:a:spot:em:{code}"
    cached = cache_get(key)
    if cached is not None:
        if isinstance(cached, dict) and cached.get("__negative_cache__"):
            return None
        return cached
    url = "https://push2.eastmoney.com/api/qt/stock/get"
    params = {
        "fltt": "2",
        "invt": "2",
        "fields": "f43,f57,f58,f116,f117,f162,f167,f168,f47,f48,f170",
        "secid": f"{_eastmoney_market_code(market)}.{code}",
    }
    try:
        response = _requests_get_no_proxy(url, params=params, timeout=3)
        response.raise_for_status()
        data = response.json().get("data")
    except Exception:
        cache_put(key, NEGATIVE_CACHE, 10)
        return None
    if not data:
        cache_put(key, NEGATIVE_CACHE, 10)
        return None
    row = {
        "代码": data.get("f57") or code,
        "名称": data.get("f58"),
        "最新价": data.get("f43"),
        "涨跌幅": data.get("f170"),
        "成交量": data.get("f47"),
        "成交额": data.get("f48"),
        "总市值": data.get("f116"),
        "流通市值": data.get("f117"),
        "市盈率-动态": data.get("f162"),
        "市净率": data.get("f167"),
        "换手率": data.get("f168"),
    }
    cache_put(key, row, 30)
    return row


def _ak_a_spot(ts_code: str, market: str) -> dict[str, Any] | None:
    if market not in {"sh", "sz", "bj"}:
        return None
    try:
        return _ak_a_spot_rows(ts_code, market)
    except Exception:
        return None


def _spot_price_from_ak(row: dict[str, Any]) -> float | None:
    return _num_or_none(row.get("最新价"))


def _spot_change_pct_from_ak(row: dict[str, Any]) -> float | None:
    return _num_or_none(row.get("涨跌幅"))


def _ak_consensus_eps(symbol: str) -> tuple[float | None, int | None]:
    """Fetch nearest annual EPS forecast from 同花顺 via akshare."""
    try:
        df = _with_retries(
            _ak_call,
            ak.stock_profit_forecast_ths,
            symbol=symbol,
            indicator="预测年报每股收益",
            attempts=2,
            base_delay=0.2,
        )
    except Exception:
        return None, None
    if df is None or df.empty or "年度" not in df.columns or "均值" not in df.columns:
        return None, None

    current_year = date.today().year
    work = df.copy()
    work["年度"] = pd.to_numeric(work["年度"], errors="coerce")
    work["均值"] = pd.to_numeric(work["均值"], errors="coerce")
    work = work.dropna(subset=["年度", "均值"])
    work = work[work["年度"].astype(int) >= current_year]
    if work.empty:
        return None, None

    row = work.sort_values("年度").iloc[0]
    count = None
    if "预测机构数" in row and pd.notna(row.get("预测机构数")):
        count = int(row["预测机构数"])
    return round(float(row["均值"]), 4), count


def _ak_research_consensus(symbol: str) -> dict[str, Any]:
    """Fetch per-stock research reports from Eastmoney via akshare."""
    try:
        df = _with_retries(
            _ak_call,
            ak.stock_research_report_em,
            symbol=symbol,
            attempts=2,
            base_delay=0.2,
        )
    except Exception:
        return {}
    if df is None or df.empty:
        return {}

    out: dict[str, Any] = {"total_count": int(len(df))}

    if "东财评级" in df.columns:
        ratings = df["东财评级"].fillna("").astype(str)
        bullish = ratings.isin(["买入", "推荐", "强烈推荐", "增持"]).sum()
        out["buy_count"] = int(bullish)
        out["buy_ratio"] = round(out["buy_count"] / out["total_count"], 3)

    current_year = date.today().year
    eps_cols: list[tuple[int, str]] = []
    for col in df.columns:
        m = re.match(r"^(\d{4})-盈利预测-收益$", str(col))
        if m and int(m.group(1)) >= current_year:
            eps_cols.append((int(m.group(1)), str(col)))

    if eps_cols:
        _, eps_col = sorted(eps_cols)[0]
        eps_series = pd.to_numeric(df[eps_col], errors="coerce").dropna()
        if not eps_series.empty:
            out["consensus_eps_next"] = round(float(eps_series.median()), 4)

    return out


# Cache the stock_basic / hk_basic name lookups once per process startup.
_NAME_CACHE: dict[str, str] = {}


def _resolve_name(ts_code: str, market: str) -> str | None:
    if _pro is None:
        return None
    if ts_code in _NAME_CACHE:
        return _NAME_CACHE[ts_code]
    try:
        if market == "hk":
            df = _pro.hk_basic(fields="ts_code,name")
        else:
            df = _pro.stock_basic(list_status="L", fields="ts_code,name")
    except Exception:
        return None
    if df is None or df.empty:
        return None
    for r in df.itertuples():
        _NAME_CACHE[r.ts_code] = r.name
    return _NAME_CACHE.get(ts_code)


# ---------- endpoints ------------------------------------------------------


@app.get("/health")
def health():
    return {
        "ok": True,
        "time": datetime.now().isoformat(),
        "source": "mock" if MOCK_MODE else ("akshare+baostock+tushare" if MARKET_ENABLE_TUSHARE_SECONDARY else "akshare+baostock"),
        "mock": MOCK_MODE,
        "a_share_quotes": "akshare_primary",
        "tushare_secondary_enabled": MARKET_ENABLE_TUSHARE_SECONDARY,
    }


@app.get("/klines", response_model=list[Kline])
def klines(
    symbol: str = Query(..., description="e.g. sh600519, 000858, hk00700"),
    start: str = Query("20230101"),
    end: str | None = Query(None),
    adjust: str = Query("qfq", pattern="^(|qfq|hfq)$"),
):
    end = end or date.today().strftime("%Y%m%d")
    start, end = _date(start), _date(end)
    key = f"kline:{symbol}:{start}:{end}:{adjust}"
    cached = cache_get(key)
    if cached is not None:
        return cached

    if MOCK_MODE:
        rows = mock_klines(symbol, start, end)
        cache_put(key, rows, 3600)
        return rows

    ts_code, market = _to_ts_code(symbol)
    source = ""
    try:
        if market == "hk":
            # akshare for HK — Tushare's hk_daily is capped at 10/day.
            ak_code = ts_code.split(".")[0]  # "00700"
            df = _with_retries(
                _ak_call,
                ak.stock_hk_hist,
                symbol=ak_code, period="daily",
                start_date=start, end_date=end, adjust=(adjust or ""),
            )
            source = "akshare_hk_hist"
        else:
            code = _compact_code(ts_code)
            df = _ak_a_hist_df(code, start, end, adjust or "qfq")
            if df is not None:
                source = "akshare_a_hist"
            if df is None:
                df = _baostock_hist_df(ts_code, start, end, adjust or "qfq")
                if df is not None:
                    source = "baostock_history_k"
            if df is None and _pro is not None and MARKET_ENABLE_TUSHARE_SECONDARY:
                df = _with_retries(
                    ts.pro_bar,
                    ts_code=ts_code,
                    adj=(adjust or None),
                    start_date=start,
                    end_date=end,
                )
                source = "tushare_pro_bar"
    except Exception as e:
        raise HTTPException(502, f"upstream error: {e}") from e

    if df is None or df.empty:
        cache_put(key, [], 3600)
        return []

    if market == "hk":
        # akshare HK schema: 日期 / 开盘 / 最高 / 最低 / 收盘 / 成交量 ...
        df = df.rename(columns={
            "日期": "date", "开盘": "open", "最高": "high",
            "最低": "low", "收盘": "close", "成交量": "volume",
        })
        df["date"] = pd.to_datetime(df["date"]).dt.strftime("%Y-%m-%d")
        rows = df[["date", "open", "high", "low", "close", "volume"]].to_dict(orient="records")
    elif source == "baostock_history_k":
        rows = _rows_from_baostock_hist(df)
    elif "trade_date" in df.columns:
        df = df.sort_values("trade_date")
        rows = [
            {
                "date": f"{d[:4]}-{d[4:6]}-{d[6:]}",
                "open": float(r.open),
                "high": float(r.high),
                "low": float(r.low),
                "close": float(r.close),
                "volume": float(r.vol),
            }
            for r in df.itertuples()
            for d in [str(r.trade_date)]
        ]
    else:
        rows = _rows_from_ak_hist(df)
    cache_put(key, rows, seconds_until_next_trading_close())
    return rows


@app.get("/fundamental", response_model=Fundamental)
def fundamental(symbol: str):
    key = f"fund:v4:{symbol}"
    cached = cache_get(key)
    if cached is not None:
        return cached

    if MOCK_MODE:
        out = mock_fundamental(symbol)
        out["source"] = "mock"
        out["fetched_at"] = datetime.now().isoformat()
        out["warnings"] = []
        out["field_sources"] = {k: "mock" for k in ("pe_ttm", "pb", "market_cap", "profit_yoy") if out.get(k) is not None}
        cache_put(key, out, 3600)
        return out

    ts_code, market = _to_ts_code(symbol)
    out: dict[str, Any] = {
        "symbol": symbol,
        "name": None if market in {"sh", "sz", "bj"} else _resolve_name(ts_code, market),
        "source": "unknown",
        "fetched_at": datetime.now().isoformat(),
        "warnings": [],
        "field_sources": {},
    }

    stock_value = _ak_stock_value_row(ts_code)
    if stock_value is not None:
        for field in ("pe_ttm", "pb", "market_cap"):
            if stock_value.get(field) is not None:
                out[field] = stock_value[field]
                out["field_sources"][field] = "akshare_stock_value_em"
        for field in ("latest_close", "latest_date", "change_pct"):
            if stock_value.get(field) is not None:
                out[field] = stock_value[field]
                out["field_sources"][field] = "akshare_stock_value_em"
    elif market in {"sh", "sz", "bj"}:
        out["warnings"].append("akshare stock_value_em unavailable")

    ak_spot = _ak_a_spot(ts_code, market)
    if ak_spot is not None:
        out["name"] = str(ak_spot.get("名称") or out.get("name") or "")
        pe_ttm = _num_or_none(_ak_col(pd.Series(ak_spot), "市盈率-动态", "市盈率", "PE"))
        pb = _num_or_none(_ak_col(pd.Series(ak_spot), "市净率", "PB"))
        market_cap = _market_cap_to_yi(_num_or_none(_ak_col(pd.Series(ak_spot), "总市值")))
        if out.get("pe_ttm") is None and pe_ttm is not None:
            out["pe_ttm"] = pe_ttm
            out["field_sources"]["pe_ttm"] = "akshare_eastmoney"
        if out.get("pb") is None and pb is not None:
            out["pb"] = pb
            out["field_sources"]["pb"] = "akshare_eastmoney"
        if out.get("market_cap") is None and market_cap is not None:
            out["market_cap"] = market_cap
            out["field_sources"]["market_cap"] = "akshare_eastmoney"

    _attach_profit_yoy(out, ts_code, market)

    if (
        market in {"sh", "sz", "bj"}
        and MARKET_ENABLE_TUSHARE_SECONDARY
        and _pro is not None
        and any(out.get(field) is None for field in ("pe_ttm", "pb", "market_cap"))
    ):
        try:
            today = date.today().strftime("%Y%m%d")
            start = (date.today() - timedelta(days=10)).strftime("%Y%m%d")
            df = _with_retries(
                _daily_basic,
                ts_code=ts_code, start_date=start, end_date=today,
                fields="ts_code,trade_date,close,pe_ttm,pb,total_mv",
            )
            if df is not None and not df.empty:
                latest = df.sort_values("trade_date").iloc[-1]
                if out.get("pe_ttm") is None and pd.notna(latest.get("pe_ttm")):
                    out["pe_ttm"] = float(latest["pe_ttm"])
                    out["field_sources"]["pe_ttm"] = "tushare_daily_basic"
                if out.get("pb") is None and pd.notna(latest.get("pb")):
                    out["pb"] = float(latest["pb"])
                    out["field_sources"]["pb"] = "tushare_daily_basic"
                if out.get("market_cap") is None and pd.notna(latest.get("total_mv")):
                    out["market_cap"] = float(latest["total_mv"]) / 1e4
                    out["field_sources"]["market_cap"] = "tushare_daily_basic"
        except Exception as e:
            out["warnings"].append(f"tushare daily_basic unavailable: {e}")
    elif market in {"sh", "sz", "bj"} and not MARKET_ENABLE_TUSHARE_SECONDARY:
        missing_for_tushare = [field for field in ("pe_ttm", "pb", "market_cap") if out.get(field) is None]
        if missing_for_tushare:
            out["warnings"].append(f"Tushare secondary disabled; missing fields: {','.join(missing_for_tushare)}")

    missing = [field for field in ("pe_ttm", "pb", "market_cap") if out.get(field) is None]
    if missing:
        out["source"] = _source_summary(out["field_sources"])
        raise HTTPException(502, f"fundamental fields missing for {symbol}: {','.join(missing)}")

    out["source"] = _source_summary(out["field_sources"])
    cache_put(key, out, 24 * 3600 if out.get("profit_yoy") is not None else 3600)
    return out


@app.get("/analyst", response_model=Analyst)
def analyst(symbol: str):
    """Sell-side consensus from free AkShare paths with optional Tushare.

    Aggregates EPS forecasts for next fiscal year across recent analyst
    reports; implied target = consensus EPS * current PE(TTM).
    """
    key = f"analyst:v4:{symbol}"
    cached = cache_get(key)
    if cached is not None:
        return cached

    if MOCK_MODE:
        out = mock_analyst(symbol)
        out["source"] = "mock"
        out["fetched_at"] = datetime.now().isoformat()
        out["warnings"] = []
        out["field_sources"] = {k: "mock" for k in (
            "buy_count", "total_count", "buy_ratio", "consensus_eps_next",
            "implied_target", "current_price", "upside_pct",
        ) if out.get(k) is not None}
        cache_put(key, out, 3600)
        return out

    ts_code, market = _to_ts_code(symbol)
    out: dict[str, Any] = {
        "symbol": symbol,
        "source": "akshare_primary",
        "fetched_at": datetime.now().isoformat(),
        "warnings": [],
        "field_sources": {},
    }
    if market == "hk":
        raise HTTPException(502, "analyst data unavailable for HK symbols")

    # Always fetch most-recent close first so the UI can show current price even
    # when sell-side reports are absent or Tushare report_rc is rate-limited.
    pe_ttm: float | None = None
    ak_spot = _ak_a_spot(ts_code, market)
    if ak_spot is not None:
        price = _spot_price_from_ak(ak_spot)
        if price is not None:
            out["current_price"] = round(price, 3)
            out["field_sources"]["current_price"] = "akshare_eastmoney"
        pe_ttm = _num_or_none(_ak_col(pd.Series(ak_spot), "市盈率-动态", "市盈率", "PE"))
    stock_value = _ak_stock_value_row(ts_code)
    if stock_value is not None:
        if out.get("current_price") is None and stock_value.get("latest_close") is not None:
            out["current_price"] = round(float(stock_value["latest_close"]), 3)
            out["field_sources"]["current_price"] = "akshare_stock_value_em_close"
            out["warnings"].append("current_price is latest daily close from AkShare stock_value_em, not realtime")
        if pe_ttm is None and stock_value.get("pe_ttm") is not None:
            pe_ttm = float(stock_value["pe_ttm"])
            out["field_sources"]["pe_ttm"] = "akshare_stock_value_em"
    if out.get("current_price") is None and market in {"sh", "sz", "bj"}:
        hist_spot = _ak_a_spot_from_hist(ts_code, market, symbol)
        if hist_spot is not None:
            out["current_price"] = round(float(hist_spot["price"]), 3)
            out["field_sources"]["current_price"] = "akshare_daily_close"
            out["warnings"].append("current_price is latest daily close from AkShare daily history, not realtime")
    if MARKET_ENABLE_TUSHARE_SECONDARY and _pro is not None and (out.get("current_price") is None or pe_ttm is None):
        try:
            today = date.today().strftime("%Y%m%d")
            start_d = (date.today() - timedelta(days=10)).strftime("%Y%m%d")
            db = _with_retries(
                _daily_basic,
                ts_code=ts_code, start_date=start_d, end_date=today,
                fields="ts_code,trade_date,close,pe_ttm",
            )
            if db is not None and not db.empty:
                latest = db.sort_values("trade_date").iloc[-1]
                if out.get("current_price") is None and pd.notna(latest.get("close")):
                    out["current_price"] = round(float(latest["close"]), 3)
                    out["field_sources"]["current_price"] = "tushare_daily_basic"
                if pe_ttm is None and pd.notna(latest.get("pe_ttm")):
                    pe_ttm = float(latest["pe_ttm"])
        except Exception as e:
            out["warnings"].append(f"tushare daily_basic unavailable: {e}")
    elif out.get("current_price") is None or pe_ttm is None:
        out["warnings"].append("Tushare daily_basic secondary disabled")

    compact_symbol = ts_code.split(".")[0]
    research = _ak_research_consensus(compact_symbol)
    out.update(research)
    for key in ("buy_count", "total_count", "buy_ratio", "consensus_eps_next"):
        if key in research and research.get(key) is not None:
            out["field_sources"][key] = "akshare_research_report"

    if out.get("consensus_eps_next") is None:
        eps, forecast_count = _ak_consensus_eps(compact_symbol)
        if eps is not None:
            out["consensus_eps_next"] = eps
            out["field_sources"]["consensus_eps_next"] = "akshare_profit_forecast"
            if forecast_count is not None and out.get("total_count") is None:
                out["total_count"] = forecast_count
                out["field_sources"]["total_count"] = "akshare_profit_forecast"

    if out.get("consensus_eps_next") is not None and pe_ttm is not None:
        out["implied_target"] = round(out["consensus_eps_next"] * pe_ttm, 3)
        out["field_sources"]["implied_target"] = "derived_eps_pe"
        if out.get("current_price"):
            out["upside_pct"] = round(
                (out["implied_target"] / out["current_price"] - 1) * 100, 2
            )
            out["field_sources"]["upside_pct"] = "derived_target_price"

    if out.get("implied_target") is not None and out.get("buy_count") is not None:
        out["source"] = _source_summary(out["field_sources"])
        cache_put(key, out, 24 * 3600)
        return out

    if any(out.get(k) is not None for k in ("buy_count", "total_count", "consensus_eps_next")):
        if pe_ttm is None:
            out["warnings"].append("pe_ttm unavailable; implied target not calculated")
        out["source"] = _source_summary(out["field_sources"])
        cache_put(key, out, 24 * 3600)
        return out

    if not MARKET_ENABLE_TUSHARE_SECONDARY:
        out["warnings"].append("implied target unavailable from free sources; Tushare report_rc secondary disabled")
        out["source"] = _source_summary(out["field_sources"])
        cache_put(key, out, 24 * 3600 if any(out.get(k) is not None for k in ("current_price", "consensus_eps_next", "buy_count", "total_count")) else 3600)
        return out

    # Pull last ~180 days of broker reports.
    start = (date.today() - timedelta(days=180)).strftime("%Y%m%d")
    try:
        rc = _with_retries(_report_rc, ts_code=ts_code, start_date=start)
    except Exception as e:
        out["warnings"].append(f"tushare report_rc unavailable: {e}")
        if not any(out.get(k) is not None for k in ("implied_target", "buy_count", "total_count", "consensus_eps_next", "upside_pct")):
            out["error"] = f"report_rc unavailable: {e}"
        cache_put(key, out, 60)
        return out

    if rc is None or rc.empty:
        out["warnings"].append("tushare report_rc returned no analyst reports")
        if not any(out.get(k) is not None for k in ("implied_target", "buy_count", "total_count", "consensus_eps_next", "upside_pct")):
            out["error"] = "report_rc returned no analyst reports"
        cache_put(key, out, 24 * 3600)
        return out

    out["total_count"] = int(len(rc))
    out["field_sources"]["total_count"] = "tushare_report_rc"
    if "rating" in rc.columns:
        # tushare ratings: 买入/推荐/增持/中性/减持/卖出 etc.
        bullish = rc["rating"].isin(["买入", "推荐", "强烈推荐", "增持"]).sum()
        out["buy_count"] = int(bullish)
        out["buy_ratio"] = round(out["buy_count"] / out["total_count"], 3)
        out["field_sources"]["buy_count"] = "tushare_report_rc"
        out["field_sources"]["buy_ratio"] = "tushare_report_rc"

    # Consensus next-year EPS: pick the median forecast for the soonest
    # forward fiscal year present in the data.
    next_year = date.today().year + 1
    yr_str = f"{next_year}Q4"
    pool = rc[rc.get("quarter") == yr_str]
    if pool.empty:
        # fall back to nearest available future year
        future = rc[rc["quarter"].str.match(r"^\d{4}Q4$", na=False)]
        future = future[future["quarter"].str[:4].astype(int) > date.today().year]
        if not future.empty:
            soonest = future["quarter"].min()
            pool = future[future["quarter"] == soonest]
    eps_series = pd.to_numeric(pool.get("eps"), errors="coerce").dropna() if not pool.empty else pd.Series(dtype=float)
    if not eps_series.empty:
        out["consensus_eps_next"] = round(float(eps_series.median()), 4)
        out["field_sources"]["consensus_eps_next"] = "tushare_report_rc"

    # Prefer explicit sell-side target-price fields when Tushare provides them;
    # otherwise fall back to EPS * PE(TTM).
    target_cols = [c for c in rc.columns if str(c).lower() in {"target_price", "target", "tp"}]
    targets: list[float] = []
    for col in target_cols:
        targets.extend(x for x in (_num_or_none(v) for v in rc[col]) if x is not None and x > 0)
    if targets:
        out["implied_target"] = round(float(pd.Series(targets).median()), 3)
        out["field_sources"]["implied_target"] = "tushare_report_rc"
    elif out.get("consensus_eps_next") is not None and pe_ttm is not None:
        out["implied_target"] = round(out["consensus_eps_next"] * pe_ttm, 3)
        out["field_sources"]["implied_target"] = "derived_eps_pe"

    if out.get("implied_target") is not None and out.get("current_price"):
        out["upside_pct"] = round(
            (out["implied_target"] / out["current_price"] - 1) * 100, 2
        )
        out["field_sources"]["upside_pct"] = "derived_target_price"

    out["source"] = _source_summary(out["field_sources"])
    cache_put(key, out, 24 * 3600)
    return out


@app.get("/analysts", response_model=list[Analyst])
def analysts(symbols: str = Query(..., description="comma-separated symbols")):
    uniq = [s.strip() for s in symbols.split(",") if s.strip()]
    seen: set[str] = set()
    out: list[dict[str, Any]] = []
    for symbol in uniq:
        if symbol in seen:
            continue
        seen.add(symbol)
        try:
            out.append(analyst(symbol))
        except Exception as e:
            detail = getattr(e, "detail", None)
            out.append({
                "symbol": symbol,
                "source": "akshare+baostock+tushare" if MARKET_ENABLE_TUSHARE_SECONDARY else "akshare+baostock",
                "fetched_at": datetime.now().isoformat(),
                "error": str(detail if detail is not None else e),
                "warnings": [str(detail if detail is not None else e)],
                "field_sources": {},
            })
    return out


@app.get("/spot")
def spot(symbol: str):
    """Most-recent close (Tushare Pro has no realtime quote). 30s cache."""
    key = f"spot:v3:{symbol}"
    cached = cache_get(key)
    if cached is not None:
        return cached

    if MOCK_MODE:
        out = mock_spot(symbol)
        out["source"] = "mock"
        out["fetched_at"] = datetime.now().isoformat()
        out["warnings"] = []
        cache_put(key, out, 30)
        return out

    ts_code, market = _to_ts_code(symbol)
    start = (date.today() - timedelta(days=10)).strftime("%Y%m%d")
    end = date.today().strftime("%Y%m%d")
    try:
        if market in {"sh", "sz", "bj"}:
            ak_spot = _ak_a_spot(ts_code, market)
            price = _spot_price_from_ak(ak_spot) if ak_spot is not None else None
            if ak_spot is not None and price is not None:
                out = {
                    "symbol": symbol,
                    "name": str(ak_spot.get("名称") or _resolve_name(ts_code, market) or ""),
                    "price": price,
                    "change_pct": _spot_change_pct_from_ak(ak_spot) or 0,
                    "volume": _num_or_none(ak_spot.get("成交量")) or 0,
                    "turnover": _num_or_none(ak_spot.get("成交额")) or 0,
                    "source": "eastmoney",
                    "fetched_at": datetime.now().isoformat(),
                    "warnings": [],
                }
                cache_put(key, out, 30)
                return out
            stock_value = _ak_stock_value_row(ts_code)
            if stock_value is not None and stock_value.get("latest_close") is not None:
                out = {
                    "symbol": symbol,
                    "name": "",
                    "price": float(stock_value["latest_close"]),
                    "change_pct": float(stock_value.get("change_pct") or 0),
                    "volume": 0,
                    "turnover": 0,
                    "source": "akshare_stock_value_em_close",
                    "fetched_at": datetime.now().isoformat(),
                    "warnings": ["Eastmoney realtime unavailable; returned AkShare stock_value_em latest daily close, not realtime"],
                }
                cache_put(key, out, 30)
                return out
            hist_spot = _ak_a_spot_from_hist(ts_code, market, symbol)
            if hist_spot is not None:
                out = {
                    "symbol": symbol,
                    "name": hist_spot.get("name") or "",
                    "price": float(hist_spot["price"]),
                    "change_pct": float(hist_spot.get("change_pct") or 0),
                    "volume": float(hist_spot.get("volume") or 0),
                    "turnover": float(hist_spot.get("turnover") or 0),
                    "source": "akshare_daily_close",
                    "fetched_at": datetime.now().isoformat(),
                    "warnings": ["Eastmoney realtime unavailable; returned AkShare latest daily close, not realtime"],
                }
                cache_put(key, out, 30)
                return out
        if market == "hk":
            ak_code = ts_code.split(".")[0]
            df = _with_retries(
                _ak_call,
                ak.stock_hk_hist,
                symbol=ak_code, period="daily", start_date=start, end_date=end, adjust="",
            )
            if df is None or df.empty:
                raise HTTPException(404, f"symbol {symbol} not found")
            df = df.rename(columns={
                "日期": "trade_date", "开盘": "open", "最高": "high",
                "最低": "low", "收盘": "close", "成交量": "vol",
                "成交额": "amount", "涨跌幅": "pct_chg",
            })
        else:
            if _pro is None or not MARKET_ENABLE_TUSHARE_SECONDARY:
                raise HTTPException(502, f"spot quote unavailable for {symbol}")
            df = _with_retries(_pro.daily, ts_code=ts_code, start_date=start, end_date=end)
            if df is None or df.empty:
                raise HTTPException(502, f"spot quote unavailable for {symbol}")
            df = df.sort_values("trade_date")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(502, f"upstream error: {e}") from e
    r = df.iloc[-1]
    out = {
        "symbol": symbol,
        "name": _resolve_name(ts_code, market) or "",
        "price": float(r.get("close", 0) or 0),
        "change_pct": float(r.get("pct_chg", 0) or 0),
        "volume": float(r.get("vol", 0) or 0),
        "turnover": float(r.get("amount", 0) or 0),
        "source": "akshare-hk-hist" if market == "hk" else "tushare-daily-close",
        "fetched_at": datetime.now().isoformat(),
        "warnings": [] if market == "hk" else ["Eastmoney realtime unavailable; returned Tushare latest daily close, not realtime"],
    }
    cache_put(key, out, 30)
    return out

@app.get("/benchmark/klines", response_model=list[Kline])
def benchmark_klines(
    index: str = Query("csi300", description="csi300 | star50 | csi500"),
    start: str = Query("20230101"),
    end: str | None = Query(None),
):
    """Index benchmark klines for backtest comparison."""
    end = end or date.today().strftime("%Y%m%d")
    start, end = _date(start), _date(end)
    if index not in BENCHMARKS:
        raise HTTPException(400, f"unknown index {index}")
    ts_code, _name = BENCHMARKS[index]
    key = f"bench:{index}:{start}:{end}"
    cached = cache_get(key)
    if cached is not None:
        return cached

    if MOCK_MODE:
        rows = mock_klines(ts_code, start, end)
        cache_put(key, rows, 3600)
        return rows

    ak_symbol = ts_code.split(".")[0]
    if ts_code.endswith(".SH"):
        ak_symbol = f"sh{ak_symbol}"
    elif ts_code.endswith(".SZ"):
        ak_symbol = f"sz{ak_symbol}"
    try:
        df = _with_retries(
            _ak_call,
            ak.stock_zh_index_daily,
            symbol=ak_symbol,
            attempts=2,
            base_delay=0.2,
        )
        if df is not None and not df.empty:
            df = df[(pd.to_datetime(df["date"]) >= pd.to_datetime(start)) & (pd.to_datetime(df["date"]) <= pd.to_datetime(end))]
    except Exception:
        df = None

    if (df is None or df.empty) and _pro is not None and MARKET_ENABLE_TUSHARE_SECONDARY:
        try:
            df = _with_retries(
                _pro.index_daily,
                ts_code=ts_code,
                start_date=start,
                end_date=end,
            )
        except Exception as e:
            raise HTTPException(502, f"index upstream error: {e}") from e

    if df is None or df.empty:
        cache_put(key, [], 3600)
        return []

    if "trade_date" in df.columns:
        df = df.sort_values("trade_date")
        rows = [
            {
                "date": f"{d[:4]}-{d[4:6]}-{d[6:]}",
                "open": float(r.open),
                "high": float(r.high),
                "low": float(r.low),
                "close": float(r.close),
                "volume": float(r.vol),
            }
            for r in df.itertuples()
            for d in [str(r.trade_date)]
        ]
    else:
        out = df.sort_values("date").copy()
        out["date"] = pd.to_datetime(out["date"]).dt.strftime("%Y-%m-%d")
        rows = out[["date", "open", "high", "low", "close", "volume"]].to_dict(orient="records")
    cache_put(key, rows, seconds_until_next_trading_close())
    return rows


@app.get("/benchmarks")
def list_benchmarks():
    return [{"id": k, "ts_code": v[0], "name": v[1]} for k, v in BENCHMARKS.items()]
