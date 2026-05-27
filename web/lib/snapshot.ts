import fs from "node:fs";
import path from "node:path";
import type { Analyst } from "./pyserver";
import type { BacktestResult } from "./backtest";
import type { Signal } from "./deepseek";

const SNAPSHOT_DIR = path.resolve(process.cwd(), "..", "docs", "data");

function readJson<T>(name: string): T | null {
  try {
    const p = path.join(SNAPSHOT_DIR, name);
    return JSON.parse(fs.readFileSync(p, "utf-8")) as T;
  } catch {
    return null;
  }
}

interface AnalystSnapshot {
  generated_at?: string;
  items?: Array<Analyst & { error?: string }>;
}

interface SignalsSnapshot {
  generated_at?: string;
  fundamentals?: Array<{
    symbol: string;
    pe_ttm?: number | null;
    pb?: number | null;
    market_cap?: number | null;
    profit_yoy?: number | null;
  }>;
  signals?: Signal[];
}

export function snapshotAnalysts(symbols: string[]): Analyst[] {
  const snap = readJson<AnalystSnapshot>("analyst.json");
  const bySymbol = new Map((snap?.items ?? []).map((item) => [item.symbol, item]));
  return symbols.map((symbol) => {
    const item = bySymbol.get(symbol);
    return {
      symbol,
      buy_count: item?.buy_count ?? null,
      total_count: item?.total_count ?? null,
      buy_ratio: item?.buy_ratio ?? null,
      consensus_eps_next: item?.consensus_eps_next ?? null,
      implied_target: item?.implied_target ?? null,
      current_price: item?.current_price ?? null,
      upside_pct: item?.upside_pct ?? null,
    };
  });
}

export function snapshotSignals() {
  return readJson<SignalsSnapshot>("signals.json");
}

export function snapshotBacktest(): BacktestResult | null {
  const snap = readJson<Partial<BacktestResult>>("backtest.json");
  if (!snap?.config || !snap?.stats || !snap?.equityCurve || !snap?.trades) {
    return null;
  }
  return {
    config: snap.config,
    stats: snap.stats,
    equityCurve: snap.equityCurve,
    trades: snap.trades,
    signalsByDate: snap.signalsByDate ?? {},
    benchmark: snap.benchmark,
  } as BacktestResult;
}
