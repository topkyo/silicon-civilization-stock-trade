import { NextRequest } from "next/server";
import { loadEntries } from "@/lib/universe";
import { fetchBenchmarkKlines, fetchKlines, fetchFundamental } from "@/lib/pyserver";
import { runBacktest, type BacktestConfig, type SymbolSeries } from "@/lib/backtest";
import { mapPool } from "@/lib/concurrent";
import { saveBacktestResult } from "@/lib/cache";

const LOAD_CONCURRENCY = Number(process.env.BACKTEST_LOAD_CONCURRENCY ?? 6);
const BACKTEST_PYSERVER_TIMEOUT_MS = Number(process.env.BACKTEST_PYSERVER_TIMEOUT_MS ?? 20_000);

export const runtime = "nodejs";
export const maxDuration = 300;

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
        const loadErrors: string[] = [];
        const loadWarnings: string[] = [];
        const loadedSeries = await mapPool(universe, LOAD_CONCURRENCY, async (entry): Promise<SymbolSeries | null> => {
          const [klinesRes, fundRes] = await Promise.allSettled([
            fetchKlines(entry.symbol, aksStart, aksEnd, BACKTEST_PYSERVER_TIMEOUT_MS),
            fetchFundamental(entry.symbol, BACKTEST_PYSERVER_TIMEOUT_MS),
          ]);
          loaded++;
          send({ type: "progress", phase: "loading", done: loaded, total: universe.length });
          if (klinesRes.status !== "fulfilled" || klinesRes.value.length < 20) {
            const why = klinesRes.status === "rejected"
              ? (klinesRes.reason instanceof Error ? klinesRes.reason.message : String(klinesRes.reason))
              : `only ${klinesRes.value.length} bars`;
            loadErrors.push(`${entry.symbol} ${entry.name}: ${why.slice(0, 160)}`);
            return null;
          }
          const fund = fundRes.status === "fulfilled" ? fundRes.value : undefined;
          if (fundRes.status !== "fulfilled") {
            const why = fundRes.reason instanceof Error ? fundRes.reason.message : String(fundRes.reason);
            loadWarnings.push(`${entry.symbol} ${entry.name} fundamental: ${why.slice(0, 160)}`);
          }
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

        send({ type: "log", message: `${series.length} symbols loaded (${loadErrors.length} failed)` });
        if (loadWarnings.length > 0) {
          send({ type: "log", message: `${loadWarnings.length} fundamentals unavailable: ${loadWarnings.slice(0, 8).join("; ")}` });
        }
        if (loadErrors.length > 0) {
          send({
            type: "error",
            message: `backtest data load failed for ${loadErrors.length} symbols: ${loadErrors.slice(0, 8).join("; ")}`,
          });
          controller.close();
          return;
        }

        const benchmarkIndex = body.benchmarkIndex ?? "csi300";
        let benchmarkOpt: { id: string; name: string; klines: import("@/lib/pyserver").Kline[] } | undefined;
        const benchKlines = await fetchBenchmarkKlines(benchmarkIndex, aksStart, aksEnd, BACKTEST_PYSERVER_TIMEOUT_MS);
        if (benchKlines.length < 20) {
          send({ type: "error", message: `benchmark ${benchmarkIndex} has only ${benchKlines.length} bars` });
          controller.close();
          return;
        }
        benchmarkOpt = {
          id: benchmarkIndex,
          name: benchmarkIndex === "star50" ? "科创50" : benchmarkIndex === "csi500" ? "中证500" : "沪深300",
          klines: benchKlines,
        };

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
