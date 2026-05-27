import { NextRequest, NextResponse } from "next/server";
import { fetchAnalysts, fetchSpot, type Analyst } from "@/lib/pyserver";
import { mapPool } from "@/lib/concurrent";
import { snapshotAnalysts } from "@/lib/snapshot";

export const runtime = "nodejs";

const ANALYST_TIMEOUT_MS = Number(process.env.ANALYST_TIMEOUT_MS ?? 8_000);
const SPOT_TIMEOUT_MS = Number(process.env.SPOT_TIMEOUT_MS ?? 5_000);
const SPOT_FALLBACK_CONCURRENCY = 6;

function timeout(ms: number): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`analyst batch timeout after ${ms}ms`)), ms);
  });
}

async function withLiveSpots(items: Analyst[]): Promise<Analyst[]> {
  const spotBySymbol = new Map(
    (await mapPool(items.map((item) => item.symbol), SPOT_FALLBACK_CONCURRENCY, async (symbol) => {
      try {
        return await fetchSpot(symbol, SPOT_TIMEOUT_MS);
      } catch {
        return null;
      }
    }))
      .filter((spot): spot is NonNullable<typeof spot> => spot !== null)
      .map((spot) => [spot.symbol, spot]),
  );
  return items.map((item) => ({
    ...item,
    current_price: spotBySymbol.get(item.symbol)?.price ?? item.current_price ?? null,
  }));
}

function withoutSnapshotPrice(item: Analyst): Analyst {
  return {
    ...item,
    current_price: null,
  };
}

async function fallback(symbols: string[]): Promise<Analyst[]> {
  return withLiveSpots(snapshotAnalysts(symbols).map(withoutSnapshotPrice));
}

function hasUsefulAnalystData(item: Analyst): boolean {
  return item.current_price != null
    || item.implied_target != null
    || item.buy_count != null
    || item.total_count != null
    || item.consensus_eps_next != null
    || item.upside_pct != null;
}

function mergeAnalyst(live: Analyst | undefined, fallback: Analyst): Analyst {
  if (!live || !hasUsefulAnalystData(live)) return withoutSnapshotPrice(fallback);
  return {
    symbol: live.symbol,
    buy_count: live.buy_count ?? fallback.buy_count ?? null,
    total_count: live.total_count ?? fallback.total_count ?? null,
    buy_ratio: live.buy_ratio ?? fallback.buy_ratio ?? null,
    consensus_eps_next: live.consensus_eps_next ?? fallback.consensus_eps_next ?? null,
    implied_target: live.implied_target ?? fallback.implied_target ?? null,
    current_price: live.current_price ?? null,
    upside_pct: live.upside_pct ?? fallback.upside_pct ?? null,
  };
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { symbols?: unknown };
  const symbols = Array.isArray(body.symbols)
    ? [...new Set(body.symbols.filter((s): s is string => typeof s === "string" && s.trim().length > 0).map((s) => s.trim()))]
    : [];
  if (symbols.length === 0) return NextResponse.json({ error: "symbols required" }, { status: 400 });

  try {
    const data = await Promise.race([fetchAnalysts(symbols, ANALYST_TIMEOUT_MS), timeout(ANALYST_TIMEOUT_MS)]);
    const liveBySymbol = new Map(data.map((item) => [item.symbol, item]));
    const fallbackBySymbol = new Map(snapshotAnalysts(symbols).map((item) => [item.symbol, item]));
    const merged = symbols.map((symbol) =>
      mergeAnalyst(liveBySymbol.get(symbol), fallbackBySymbol.get(symbol) ?? { symbol }),
    );
    return NextResponse.json(await withLiveSpots(merged));
  } catch {
    const data = await fallback(symbols);
    return NextResponse.json(data);
  }
}
