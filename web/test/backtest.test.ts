// Real backtest exercise with deterministic injected scorer.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Cache backend writes under cwd/.cache; sandbox it.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scc-bt-"));
process.chdir(tmp);

import type { Kline } from "../lib/pyserver";
import { runBacktest, type SymbolSeries, type Progress, type BacktestConfig, type Scorer } from "../lib/backtest";

// Deterministic scorer: always BUY A, SELL B with full size.
const scorer: Scorer = async (snapshots) =>
  snapshots.map((s) => ({
    symbol: s.symbol,
    action: s.symbol === "A" ? "buy" : "sell",
    confidence: 1,
    size: s.symbol === "A" ? 1 : 0,
    rationale: "test",
  }));

function makeKlines(start: string, closes: number[]): Kline[] {
  const d = new Date(start);
  return closes.map((c) => {
    // Skip weekends to mimic trading days.
    while (d.getUTCDay() === 0 || d.getUTCDay() === 6) {
      d.setUTCDate(d.getUTCDate() + 1);
    }
    const date = d.toISOString().slice(0, 10);
    d.setUTCDate(d.getUTCDate() + 1);
    return { date, open: c, high: c, low: c, close: c, volume: 1_000_000 };
  });
}

function makeSeries(): SymbolSeries[] {
  // A trends up (100→150), B trends down (100→70).
  const aCloses = Array.from({ length: 80 }, (_, i) => 100 + i * 0.625);
  const bCloses = Array.from({ length: 80 }, (_, i) => 100 - i * 0.375);
  return [
    { entry: { symbol: "A", name: "Up", theme: "T" }, klines: makeKlines("2025-01-01", aCloses) },
    { entry: { symbol: "B", name: "Down", theme: "T" }, klines: makeKlines("2025-01-01", bCloses) },
  ];
}

const cfg: BacktestConfig = {
  startCash: 1_000_000,
  rebalanceEveryNDays: 5,
  // dates from makeSeries start at 2025-01-01 (UTC); first business day is 01-01.
  startDate: "2025-01-01",
  endDate: "2025-12-31",
  feeBps: 0,
  maxPositions: 5,
};

test("runBacktest produces a result with expected shape", async () => {
  const r = await runBacktest(makeSeries(), cfg, { scorer });
  assert.ok(r.equityCurve.length > 30);
  assert.ok(r.trades.length > 0);
  assert.ok(typeof r.stats.totalReturnPct === "number");
  assert.ok(typeof r.stats.maxDrawdownPct === "number");
});

test("backtest buys the up-trending symbol", async () => {
  const r = await runBacktest(makeSeries(), cfg, { scorer });
  const buys = r.trades.filter((t) => t.side === "buy");
  assert.ok(buys.length > 0, "expected at least one buy");
  assert.ok(buys.every((t) => t.symbol === "A"), "should only buy A (up trender)");
});

test("equity is monotonically tracking the chosen asset (no losses on uptrend)", async () => {
  const r = await runBacktest(makeSeries(), cfg, { scorer });
  const start = r.equityCurve[0].equity;
  const end = r.equityCurve.at(-1)!.equity;
  assert.ok(end > start, `expected end (${end}) > start (${start}) when buying uptrend`);
  // Total return should be positive and substantial — A goes 100→150 = +50%, we
  // capture most of it after the first rebalance lag.
  assert.ok(r.stats.totalReturnPct > 20, `got ${r.stats.totalReturnPct}%`);
});

test("progress callback fires for signals + simulating phases", async () => {
  const events: Progress[] = [];
  await runBacktest(makeSeries(), cfg, { scorer, onProgress: (p) => events.push(p) });
  const phases = new Set(events.map((e) => e.phase));
  assert.ok(phases.has("signals"), "expected signals events");
  assert.ok(phases.has("simulating"), "expected simulating events");
  // First and last simulating events should bracket [0, N].
  const sim = events.filter((e) => e.phase === "simulating");
  assert.equal(sim[0].done, 0);
  assert.equal(sim.at(-1)!.done, sim.at(-1)!.total);
});

test("runBacktest falls back to hold signals when scorer fails", async () => {
  const logs: string[] = [];
  const failingScorer: Scorer = async () => {
    throw new Error("opencode-go timed out after 120000ms");
  };
  const r = await runBacktest(makeSeries(), cfg, {
    scorer: failingScorer,
    onLog: (message) => logs.push(message),
  });
  assert.equal(r.trades.length, 0);
  assert.ok(logs.some((message) => message.includes("opencode-go timed out")));
  assert.ok(
    Object.values(r.signalsByDate).every((signals) =>
      signals.every((signal) => signal.action === "hold" && signal.source === "snapshot"),
    ),
  );
});

test("throws when window has too few aligned trading days", async () => {
  const tinyCfg = { ...cfg, startDate: "2025-12-29", endDate: "2025-12-31" };
  await assert.rejects(() => runBacktest(makeSeries(), tinyCfg, { scorer }), /aligned/i);
});


test("runBacktest attaches benchmark curve when provided", async () => {
  const benchCloses = Array.from({ length: 80 }, (_, i) => 3000 + i * 2);
  const benchKlines = makeKlines("2025-01-01", benchCloses);
  const r = await runBacktest(makeSeries(), cfg, {
    scorer,
    benchmark: { id: "csi300", name: "沪深300", klines: benchKlines },
  });
  assert.ok(r.benchmark);
  assert.equal(r.benchmark!.equityCurve.length, r.equityCurve.length);
  assert.ok(typeof r.stats.excessReturnPct === "number");
});

test("strict rebalance sells stale holdings before buying the new top signal", async () => {
  const rotatingScorer: Scorer = async (snapshots, opts) =>
    snapshots.map((s) => ({
      symbol: s.symbol,
      action: s.symbol === (opts.asOf < "2025-01-08" ? "A" : "B") ? "buy" : "hold",
      confidence: 1,
      size: s.symbol === (opts.asOf < "2025-01-08" ? "A" : "B") ? 1 : 0,
      rationale: "rotate",
    }));
  const r = await runBacktest(makeSeries(), cfg, { scorer: rotatingScorer });
  const jan8Trades = r.trades.filter((t) => t.date === "2025-01-08");
  assert.ok(jan8Trades.some((t) => t.side === "sell" && t.symbol === "A"), "expected A to be sold");
  assert.ok(jan8Trades.some((t) => t.side === "buy" && t.symbol === "B"), "expected B to be bought");
});

test("strict rebalance keeps maxPositions as a hard cap", async () => {
  const manySeries: SymbolSeries[] = ["A", "B", "C"].map((symbol, offset) => ({
    entry: { symbol, name: symbol, theme: "T" },
    klines: makeKlines("2025-01-01", Array.from({ length: 80 }, (_, i) => 100 + i + offset)),
  }));
  const allBuyScorer: Scorer = async (snapshots) =>
    snapshots.map((s, i) => ({
      symbol: s.symbol,
      action: "buy",
      confidence: 1 - i * 0.1,
      size: 1,
      rationale: "buy",
    }));
  const r = await runBacktest(
    manySeries,
    { ...cfg, maxPositions: 1 },
    { scorer: allBuyScorer },
  );
  assert.ok(
    r.equityCurve.every((bar) => Object.keys(bar.positions).length <= 1),
    "expected no bar to exceed maxPositions",
  );
});

test("feeBps is applied as a one-way trading fee on buys", async () => {
  const flatSeries: SymbolSeries[] = [
    {
      entry: { symbol: "A", name: "Flat", theme: "T" },
      klines: makeKlines("2025-01-01", Array.from({ length: 10 }, () => 100)),
    },
  ];
  const buyScorer: Scorer = async (snapshots) =>
    snapshots.map((s) => ({
      symbol: s.symbol,
      action: "buy",
      confidence: 1,
      size: 1,
      rationale: "buy",
    }));
  const r = await runBacktest(
    flatSeries,
    { ...cfg, rebalanceEveryNDays: 100, feeBps: 100 },
    { scorer: buyScorer },
  );
  assert.equal(r.equityCurve[0].positions.A.shares, 9900);
  assert.equal(r.equityCurve[0].cash, 100);
});
