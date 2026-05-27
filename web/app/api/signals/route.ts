import { NextRequest } from "next/server";
import { scoreSymbols, type Signal, type SymbolSnapshot } from "@/lib/deepseek";
import { mapPool } from "@/lib/concurrent";
import { fetchKlines, fetchFundamental } from "@/lib/pyserver";
import { loadEntries, type UniverseEntry } from "@/lib/universe";

export const runtime = "nodejs";
export const maxDuration = 300;

const LOAD_CONCURRENCY = Number(process.env.SIGNALS_LOAD_CONCURRENCY ?? 3);
const SIGNALS_PYSERVER_TIMEOUT_MS = Number(process.env.SIGNALS_PYSERVER_TIMEOUT_MS ?? 120_000);
const SIGNALS_FUNDAMENTAL_TIMEOUT_MS = Number(process.env.SIGNALS_FUNDAMENTAL_TIMEOUT_MS ?? 8_000);

type LiveSnapshot = SymbolSnapshot & { dataErrors?: string[] };

interface SignalRow {
  entry: UniverseEntry;
  snapshot: LiveSnapshot & {
    fundamentalSource?: string | null;
    fundamentalFieldSources?: Record<string, string> | null;
  };
  signal: Signal;
}

function startDate90d(): string {
  const d = new Date();
  d.setDate(d.getDate() - 90);
  return d.toISOString().slice(0, 10).replaceAll("-", "");
}

export async function POST(_req: NextRequest) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: unknown) => {
        controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
      };
      try {
        const universe = loadEntries();
        const start = startDate90d();
        let loaded = 0;
        send({ type: "progress", phase: "loading", done: 0, total: universe.length });
        const snapshots: LiveSnapshot[] = await mapPool(universe, LOAD_CONCURRENCY, async (entry) => {
          const [klinesRes, fundRes] = await Promise.allSettled([
            fetchKlines(entry.symbol, start, undefined, SIGNALS_PYSERVER_TIMEOUT_MS),
            fetchFundamental(entry.symbol, SIGNALS_FUNDAMENTAL_TIMEOUT_MS),
          ]);
          loaded++;
          send({ type: "progress", phase: "loading", done: loaded, total: universe.length });
          if (klinesRes.status !== "fulfilled") {
            throw new Error(`${entry.symbol} kline failed: ${klinesRes.reason instanceof Error ? klinesRes.reason.message : String(klinesRes.reason)}`);
          }
          const klines = klinesRes.value;
          const fund = fundRes.status === "fulfilled" ? fundRes.value : undefined;
          return {
            symbol: entry.symbol,
            name: entry.name,
            theme: entry.theme,
            closes: klines.map((k) => k.close),
            fundamentalSource: fund?.source ?? null,
            fundamentalFieldSources: fund?.field_sources ?? null,
            dataErrors: [
              fundRes.status === "rejected"
                ? `fundamental failed: ${fundRes.reason instanceof Error ? fundRes.reason.message : String(fundRes.reason)}`
                : undefined,
              ...(fund?.warnings ?? []).map((warning) => `fundamental warning: ${warning}`),
            ].filter((message): message is string => Boolean(message)),
            fundamental: fund
              ? {
                  pe_ttm: fund.pe_ttm,
                  pb: fund.pb,
                  market_cap: fund.market_cap,
                  profit_yoy: fund.profit_yoy,
                }
              : undefined,
          };
        });

        const missingKlines = snapshots.filter((s) => s.closes.length < 10);
        if (missingKlines.length > 0) {
          throw new Error(`live kline data insufficient: ${missingKlines.map((s) => s.symbol).join(",")}`);
        }

        send({ type: "progress", phase: "scoring", done: 0, total: snapshots.length });
        const signals = await scoreSymbols(snapshots);
        send({ type: "progress", phase: "scoring", done: snapshots.length, total: snapshots.length });
        const signalBySymbol = new Map(signals.map((signal) => [signal.symbol, signal]));
        const snapshotBySymbol = new Map(snapshots.map((snapshot) => [snapshot.symbol, snapshot]));
        const rows: SignalRow[] = universe.map((entry) => {
          const snapshot = snapshotBySymbol.get(entry.symbol);
          const signal = signalBySymbol.get(entry.symbol);
          if (!snapshot || !signal) throw new Error(`missing signal row for ${entry.symbol}`);
          return { entry, snapshot, signal };
        });
        send({ type: "result", rows });
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
