import { NextRequest, NextResponse } from "next/server";
import { fetchAnalyst } from "@/lib/pyserver";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const symbol = req.nextUrl.searchParams.get("symbol");
  if (!symbol) return NextResponse.json({ error: "symbol required" }, { status: 400 });
  try {
    const data = await fetchAnalyst(symbol);
    return NextResponse.json(data);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 502 },
    );
  }
}
