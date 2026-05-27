import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import type { Kline } from "../lib/pyserver";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scc-api-"));
process.chdir(tmp);
fs.mkdirSync("data", { recursive: true });

const universe = {
  updated_at: "2026-01-01",
  updated_by: "test",
  entries: [
    { symbol: "000001", name: "平安银行", theme: "云/AI基建" },
  ],
};
fs.writeFileSync("data/universe.json", JSON.stringify(universe, null, 2) + "\n");

function makeKlines(start: string, count: number): Kline[] {
  const d = new Date(start);
  return Array.from({ length: count }, (_, i) => {
    while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1);
    const date = d.toISOString().slice(0, 10);
    d.setUTCDate(d.getUTCDate() + 1);
    const close = 100 + i;
    return { date, open: close, high: close, low: close, close, volume: 1_000_000 };
  });
}

async function readEvents(response: Response): Promise<Array<Record<string, unknown>>> {
  assert.ok(response.body);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const events: Array<Record<string, unknown>> = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line) events.push(JSON.parse(line) as Record<string, unknown>);
    }
  }
  return events;
}

function installStrictFailureFetch() {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("api.deepseek.com")) {
      return new Response("bad gateway", { status: 502 });
    }
    if (url.includes("/klines")) {
      return new Response(JSON.stringify(makeKlines("2025-01-01", 40)), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/benchmark/klines")) {
      return new Response(JSON.stringify(makeKlines("2025-01-01", 40)), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/fundamental")) {
      return new Response(JSON.stringify({
        symbol: "000001",
        pe_ttm: 10,
        pb: 1,
        market_cap: 1000,
        profit_yoy: 20,
        source: "test",
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("unexpected URL", { status: 500 });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

test("/api/signals emits terminal error when LLM scoring fails", async () => {
  const restore = installStrictFailureFetch();
  process.env.LLM_PROVIDER = "deepseek";
  process.env.DEEPSEEK_API_KEY = "sk-test";
  try {
    const { POST } = await import("../app/api/signals/route");
    const events = await readEvents(await POST(new NextRequest("http://test/api/signals", { method: "POST" })));
    const terminal = events.at(-1);
    assert.equal(terminal?.type, "error");
    assert.match(String(terminal?.message), /deepseek 502/);
    assert.equal(events.some((event) => event.type === "result"), false);
  } finally {
    restore();
    delete process.env.LLM_PROVIDER;
    delete process.env.DEEPSEEK_API_KEY;
  }
});

test("/api/backtest emits terminal error and stores no result when LLM scoring fails", async () => {
  const restore = installStrictFailureFetch();
  process.env.LLM_PROVIDER = "deepseek";
  process.env.DEEPSEEK_API_KEY = "sk-test";
  try {
    const { POST } = await import("../app/api/backtest/route");
    const { listBacktestResults } = await import("../lib/cache");
    const response = await POST(new NextRequest("http://test/api/backtest", {
      method: "POST",
      body: JSON.stringify({
        startDate: "2025-01-20",
        endDate: "2025-02-28",
        rebalanceEveryNDays: 100,
        maxPositions: 1,
      }),
    }));
    const events = await readEvents(response);
    const terminal = events.at(-1);
    assert.equal(terminal?.type, "error");
    assert.match(String(terminal?.message), /deepseek 502/);
    assert.equal(events.some((event) => event.type === "result"), false);
    assert.equal(listBacktestResults().length, 0);
  } finally {
    restore();
    delete process.env.LLM_PROVIDER;
    delete process.env.DEEPSEEK_API_KEY;
  }
});

test("/api/universe/refresh emits terminal error and leaves file unchanged when LLM fails", async () => {
  const before = fs.readFileSync("data/universe.json", "utf-8");
  const restore = installStrictFailureFetch();
  process.env.LLM_PROVIDER = "deepseek";
  process.env.DEEPSEEK_API_KEY = "sk-test";
  try {
    const { POST } = await import("../app/api/universe/refresh/route");
    const events = await readEvents(await POST(new NextRequest("http://test/api/universe/refresh", { method: "POST" })));
    const terminal = events.at(-1);
    assert.equal(terminal?.type, "error");
    assert.match(String(terminal?.message), /deepseek 502/);
    assert.equal(fs.readFileSync("data/universe.json", "utf-8"), before);
  } finally {
    restore();
    delete process.env.LLM_PROVIDER;
    delete process.env.DEEPSEEK_API_KEY;
  }
});
