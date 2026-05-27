import { NextRequest, NextResponse } from "next/server";
import { fetchSpot, type Spot } from "@/lib/pyserver";
import { mapPool } from "@/lib/concurrent";

export const runtime = "nodejs";

const SPOT_CONCURRENCY = 8;
const SPOT_TIMEOUT_MS = Number(process.env.SPOT_TIMEOUT_MS ?? 8_000);

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { symbols?: unknown };
  const symbols = Array.isArray(body.symbols)
    ? [...new Set(body.symbols.filter((s): s is string => typeof s === "string" && s.trim().length > 0).map((s) => s.trim()))]
    : [];
  if (symbols.length === 0) return NextResponse.json({ error: "symbols required" }, { status: 400 });

  const data = await mapPool(symbols, SPOT_CONCURRENCY, async (symbol): Promise<Spot | null> => {
    try {
      return await fetchSpot(symbol, SPOT_TIMEOUT_MS);
    } catch {
      return null;
    }
  });

  return NextResponse.json(data.filter((s): s is Spot => s !== null));
}
