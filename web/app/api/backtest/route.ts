import { NextRequest } from "next/server";
import { DEFAULT_UNIVERSE } from "@/lib/universe";
import { fetchKlines, fetchFundamental } from "@/lib/pyserver";
import { runBacktest, type BacktestConfig, type SymbolSeries } from "@/lib/backtest";

export const runtime = "nodejs";
export const maxDuration = 300;

// NDJSON streaming protocol. Each line is one JSON object, one of:
//   { type: "progress", phase, done, total }
//   { type: "log", message }
//   { type: "result", result }            // terminal — full BacktestResult
//   { type: "error", message }            // terminal
export async function POST(req: NextRequest) {
  const body = (await req.json()) as Partial<BacktestConfig> & {
    startDate: string;
    endDate: string;
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
        send({ type: "progress", phase: "loading", done: 0, total: DEFAULT_UNIVERSE.length });
        let loaded = 0;
        const series: SymbolSeries[] = (
          await Promise.all(
            DEFAULT_UNIVERSE.map(async (entry): Promise<SymbolSeries | null> => {
              const [klines, fund] = await Promise.all([
                fetchKlines(entry.symbol, aksStart, aksEnd).catch(() => []),
                fetchFundamental(entry.symbol).catch(() => undefined),
              ]);
              loaded++;
              send({
                type: "progress",
                phase: "loading",
                done: loaded,
                total: DEFAULT_UNIVERSE.length,
              });
              if (klines.length < 20) return null;
              return {
                entry,
                klines,
                fundamental: fund
                  ? {
                      pe_ttm: fund.pe_ttm ?? null,
                      pb: fund.pb ?? null,
                      market_cap: fund.market_cap ?? null,
                    }
                  : undefined,
              };
            }),
          )
        ).filter((x): x is SymbolSeries => x !== null);

        send({ type: "log", message: `${series.length} symbols loaded` });

        if (series.length === 0) {
          send({ type: "error", message: "no data loaded from pyserver" });
          controller.close();
          return;
        }

        const result = await runBacktest(series, cfg, (p) => {
          send({ type: "progress", ...p });
        });
        send({ type: "result", result });
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
