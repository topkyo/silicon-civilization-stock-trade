import { NextRequest, NextResponse } from "next/server";
import { fetchAnalysts, type Analyst } from "@/lib/pyserver";

export const runtime = "nodejs";

const ANALYST_TIMEOUT_MS = Number(process.env.ANALYST_TIMEOUT_MS ?? 8_000);

function timeout(ms: number): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`analyst batch timeout after ${ms}ms`)), ms);
  });
}

function hasUsefulAnalystData(item: Analyst): boolean {
  return item.implied_target != null
    || item.buy_count != null
    || item.total_count != null
    || item.consensus_eps_next != null
    || item.upside_pct != null;
}

interface BatchError {
  symbol: string;
  message: string;
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
    const items: Analyst[] = [];
    const errors: BatchError[] = [];
    for (const symbol of symbols) {
      const item = liveBySymbol.get(symbol);
      if (!item) {
        errors.push({ symbol, message: "pyserver returned no analyst item" });
        continue;
      }
      if (!hasUsefulAnalystData(item)) {
        errors.push({ symbol, message: item.error ?? "no analyst, price, or forecast data returned" });
        continue;
      }
      if (item.error) {
        errors.push({ symbol, message: item.error });
      }
      items.push(item);
    }
    return NextResponse.json(
      { items, errors, requested: symbols.length, returned: items.length },
      { status: errors.length > 0 ? 207 : 200 },
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      {
        items: [],
        errors: symbols.map((symbol) => ({ symbol, message })),
        requested: symbols.length,
        returned: 0,
      },
      { status: 502 },
    );
  }
}
