import { NextRequest } from "next/server";
import { loadEntries } from "@/lib/universe";
import { fetchBenchmarkKlines, fetchKlines, fetchFundamental } from "@/lib/pyserver";
import { runBacktest, type BacktestConfig, type SymbolSeries } from "@/lib/backtest";
import { mapPool } from "@/lib/concurrent";
import { saveBacktestResult } from "@/lib/cache";
import { snapshotBacktest } from "@/lib/snapshot";

const LOAD_CONCURRENCY = Number(process.env.BACKTEST_LOAD_CONCURRENCY ?? 6);
const BACKTEST_PYSERVER_TIMEOUT_MS = Number(process.env.BACKTEST_PYSERVER_TIMEOUT_MS ?? 20_000);

export const runtime = "nodejs";
export const maxDuration = 300;

function configMatchesSnapshot(snapshot: ReturnType<typeof snapshotBacktest>, cfg: BacktestConfig) {
  if (!snapshot) return false;
  const s = snapshot.config;
  return s.startCash === cfg.startCash
    && s.rebalanceEveryNDays === cfg.rebalanceEveryNDays
    && s.startDate === cfg.startDate
    && s.endDate === cfg.endDate
    && s.feeBps === cfg.feeBps
    && s.maxPositions === cfg.maxPositions;
}

// NDJSON streaming protocol. Each line is one JSON object, one of:
//   { type: "progress", phase, done, total }
//   { type: "log", message }
//   { type: "result", result, stored }    // terminal — full BacktestResult
//   { type: "error", message }            // terminal
export async function POST(req: NextRequest) {
  const body = (await req.json()) as Partial<BacktestConfig> & {
    startDate: string;
    endDate: string;
    benchmarkIndex?: string;
  };

  const cfg: BacktestConfig = {
    startCash: body.startCash ?? 1_000_000,
    rebalanceEveryNDays: body.rebalanceEveryNDays ?? 10,
    startDate: body.startDate,
    endDate: body.endDate,
    feeBps: body.feeBps ?? 10,
    maxPositions: body.maxPositions ?? 6,
  };

  const padStart = new Date(cfg.startDate);
  padStart.setDate(padStart.getDate() - 120);
  const aksStart = padStart.toISOString().slice(0, 10).replaceAll("-", "");
  const aksEnd = cfg.endDate.replaceAll("-", "");

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: unknown) => {
        controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
      };
      try {
        const universe = loadEntries();
        send({ type: "progress", phase: "loading", done: 0, total: universe.length });
        let loaded = 0;
        let failed = 0;
        const loadedSeries = await mapPool(universe, LOAD_CONCURRENCY, async (entry): Promise<SymbolSeries | null> => {
          const [klinesRes, fundRes] = await Promise.allSettled([
            fetchKlines(entry.symbol, aksStart, aksEnd, BACKTEST_PYSERVER_TIMEOUT_MS),
            fetchFundamental(entry.symbol, BACKTEST_PYSERVER_TIMEOUT_MS),
          ]);
          loaded++;
          send({ type: "progress", phase: "loading", done: loaded, total: universe.length });
          if (klinesRes.status !== "fulfilled" || klinesRes.value.length < 20) {
            failed++;
            const why = klinesRes.status === "rejected"
              ? (klinesRes.reason instanceof Error ? klinesRes.reason.message : String(klinesRes.reason))
              : `only ${klinesRes.value.length} bars`;
            send({ type: "log", message: `skip ${entry.symbol} ${entry.name}: ${why.slice(0, 120)}` });
            return null;
          }
          const fund = fundRes.status === "fulfilled" ? fundRes.value : undefined;
          return {
            entry,
            klines: klinesRes.value,
            fundamental: fund
              ? {
                  pe_ttm: fund.pe_ttm ?? null,
                  pb: fund.pb ?? null,
                  market_cap: fund.market_cap ?? null,
                  profit_yoy: fund.profit_yoy ?? null,
                }
              : undefined,
          };
        });
        const series: SymbolSeries[] = loadedSeries.filter((x): x is SymbolSeries => x !== null);

        send({ type: "log", message: `${series.length} symbols loaded (${failed} failed/skipped)` });

        if (series.length === 0) {
          const fallback = snapshotBacktest();
          if (configMatchesSnapshot(fallback, cfg)) {
            send({ type: "log", message: "pyserver unavailable; using latest static backtest snapshot" });
            send({ type: "result", result: fallback, stored: null });
          } else {
            send({
              type: "error",
              message: fallback
                ? "no data loaded from pyserver; static backtest snapshot does not match requested config"
                : "no data loaded from pyserver",
            });
          }
          controller.close();
          return;
        }

        const benchmarkIndex = body.benchmarkIndex ?? "csi300";
        let benchmarkOpt: { id: string; name: string; klines: import("@/lib/pyserver").Kline[] } | undefined;
        try {
          const benchKlines = await fetchBenchmarkKlines(benchmarkIndex, aksStart, aksEnd, BACKTEST_PYSERVER_TIMEOUT_MS);
          if (benchKlines.length >= 20) {
            benchmarkOpt = {
              id: benchmarkIndex,
              name: benchmarkIndex === "star50" ? "科创50" : benchmarkIndex === "csi500" ? "中证500" : "沪深300",
              klines: benchKlines,
            };
          }
        } catch {
          send({ type: "log", message: `benchmark ${benchmarkIndex} unavailable, skipping` });
        }

        const result = await runBacktest(series, cfg, {
          onProgress: (p) => send({ type: "progress", ...p }),
          onLog: (message) => send({ type: "log", message }),
          benchmark: benchmarkOpt,
        });
        const stored = saveBacktestResult(result);
        send({ type: "log", message: `stored backtest ${stored.id}` });
        send({ type: "result", result, stored });
        controller.close();
      } catch (e) {
        send({ type: "error", message: e instanceof Error ? e.message : String(e) });
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    },
  });
}
