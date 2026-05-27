// Typed client for the Python Tushare sidecar. Adds a thin in-process dedupe
// on top of pyserver's own SQLite cache to coalesce burst calls within a render.
const BASE = process.env.PYSERVER_URL ?? "http://localhost:8001";
// Default 180s — Tushare HK endpoints are rate-limited at 2/min, so a few
// HK symbols may need to wait in pyserver's token bucket before being served.
const TIMEOUT_MS = Number(process.env.PYSERVER_TIMEOUT_MS ?? 180_000);

export interface Kline {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Fundamental {
  symbol: string;
  name?: string | null;
  pe_ttm?: number | null;
  pb?: number | null;
  market_cap?: number | null;
  revenue_yoy?: number | null;
  profit_yoy?: number | null;
  source?: string | null;
  fetched_at?: string | null;
  error?: string | null;
  warnings?: string[] | null;
  field_sources?: Record<string, string> | null;
}

const inflight = new Map<string, Promise<unknown>>();

async function get<T>(path: string, params: Record<string, string>, timeoutMs = TIMEOUT_MS): Promise<T> {
  const qs = new URLSearchParams(params).toString();
  const key = `${path}?${qs}:timeout=${timeoutMs}`;
  const existing = inflight.get(key);
  if (existing) return existing as Promise<T>;
  const p = (async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(`${BASE}${path}?${qs}`, { cache: "no-store", signal: ctrl.signal });
      if (!r.ok) throw new Error(`pyserver ${path} ${r.status}: ${await r.text()}`);
      return (await r.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  })();
  inflight.set(key, p);
  try {
    return await p;
  } finally {
    // brief dedupe only — release after settle so cache layer below handles repeats
    setTimeout(() => inflight.delete(key), 100);
  }
}

export function fetchKlines(symbol: string, start = "20230101", end?: string, timeoutMs?: number) {
  const params: Record<string, string> = { symbol, start, adjust: "qfq" };
  if (end) params.end = end;
  return get<Kline[]>("/klines", params, timeoutMs);
}

export function fetchFundamental(symbol: string, timeoutMs?: number) {
  return get<Fundamental>("/fundamental", { symbol }, timeoutMs);
}

export interface Analyst {
  symbol: string;
  buy_count?: number | null;
  total_count?: number | null;
  buy_ratio?: number | null;
  consensus_eps_next?: number | null;
  implied_target?: number | null;
  current_price?: number | null;
  upside_pct?: number | null;
  source?: string | null;
  fetched_at?: string | null;
  error?: string | null;
  warnings?: string[] | null;
  field_sources?: Record<string, string> | null;
}

export function fetchAnalyst(symbol: string, timeoutMs?: number) {
  return get<Analyst>("/analyst", { symbol }, timeoutMs);
}

export function fetchAnalysts(symbols: string[], timeoutMs?: number) {
  const uniq = [...new Set(symbols.map((s) => s.trim()).filter(Boolean))];
  if (uniq.length === 0) return Promise.resolve([] as Analyst[]);
  return get<Analyst[]>("/analysts", { symbols: uniq.join(",") }, timeoutMs);
}

export function fetchSpot(symbol: string, timeoutMs?: number) {
  return get<Spot>(
    "/spot",
    { symbol },
    timeoutMs,
  );
}

export interface Spot {
  symbol: string;
  name: string;
  price: number;
  change_pct: number;
  volume?: number;
  turnover?: number;
  source?: string;
  fetched_at?: string;
  error?: string;
  warnings?: string[];
}


export function fetchBenchmarkKlines(
  index = "csi300",
  start = "20230101",
  end?: string,
  timeoutMs?: number,
) {
  const params: Record<string, string> = { index, start };
  if (end) params.end = end;
  return get<Kline[]>("/benchmark/klines", params, timeoutMs);
}

export function fetchBenchmarks() {
  return get<Array<{ id: string; ts_code: string; name: string }>>("/benchmarks", {});
}
