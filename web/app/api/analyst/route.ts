import { NextRequest, NextResponse } from "next/server";
import { fetchAnalyst } from "@/lib/pyserver";

export const runtime = "nodejs";

const ANALYST_TIMEOUT_MS = 25_000;

function timeout(ms: number): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`analyst timeout after ${ms}ms`)), ms);
  });
}

export async function GET(req: NextRequest) {
  const symbol = req.nextUrl.searchParams.get("symbol");
  if (!symbol) return NextResponse.json({ error: "symbol required" }, { status: 400 });
  try {
    const data = await Promise.race([fetchAnalyst(symbol, ANALYST_TIMEOUT_MS), timeout(ANALYST_TIMEOUT_MS)]);
    if (data.error) {
      return NextResponse.json({ error: data.error, symbol }, { status: 502 });
    }
    return NextResponse.json(data);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 502 },
    );
  }
}
