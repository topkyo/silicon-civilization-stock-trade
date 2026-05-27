import { NextRequest, NextResponse } from "next/server";
import { fetchAnalyst, fetchSpot } from "@/lib/pyserver";
import { snapshotAnalysts } from "@/lib/snapshot";

export const runtime = "nodejs";

const ANALYST_TIMEOUT_MS = 25_000;

function timeout(ms: number): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`analyst timeout after ${ms}ms`)), ms);
  });
}

function mergeAnalyst(
  live: Awaited<ReturnType<typeof fetchAnalyst>> | undefined,
  fallback: ReturnType<typeof snapshotAnalysts>[number],
) {
  return {
    symbol: fallback.symbol,
    buy_count: live?.buy_count ?? fallback.buy_count ?? null,
    total_count: live?.total_count ?? fallback.total_count ?? null,
    buy_ratio: live?.buy_ratio ?? fallback.buy_ratio ?? null,
    consensus_eps_next: live?.consensus_eps_next ?? fallback.consensus_eps_next ?? null,
    implied_target: live?.implied_target ?? fallback.implied_target ?? null,
    current_price: live?.current_price ?? null,
    upside_pct: live?.upside_pct ?? fallback.upside_pct ?? null,
  };
}

export async function GET(req: NextRequest) {
  const symbol = req.nextUrl.searchParams.get("symbol");
  if (!symbol) return NextResponse.json({ error: "symbol required" }, { status: 400 });
  const [fallback] = snapshotAnalysts([symbol]);
  try {
    const data = await Promise.race([fetchAnalyst(symbol, ANALYST_TIMEOUT_MS), timeout(ANALYST_TIMEOUT_MS)]);
    return NextResponse.json(mergeAnalyst(data, fallback));
  } catch (e) {
    try {
      const spot = await fetchSpot(symbol, 8_000);
      return NextResponse.json({
        symbol,
        current_price: spot.price,
        buy_count: null,
        total_count: null,
        buy_ratio: null,
        consensus_eps_next: null,
        implied_target: null,
        upside_pct: null,
      });
    } catch {
      // Preserve the original analyst error; it is more useful for debugging.
    }
    if (fallback.implied_target != null || fallback.buy_count != null) {
      return NextResponse.json({
        ...fallback,
        current_price: null,
      });
    }
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 502 },
    );
  }
}
