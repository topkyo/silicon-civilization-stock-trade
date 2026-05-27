import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SymbolSnapshot } from "../lib/deepseek";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scc-deepseek-"));
process.chdir(tmp);

function snapshot(symbol: string, closes = 30): SymbolSnapshot {
  return {
    symbol,
    name: symbol,
    theme: "光模块",
    closes: Array.from({ length: closes }, (_, i) => 100 + i),
    fundamental: { pe_ttm: 20, profit_yoy: 40, pb: 3, market_cap: 1000 },
  };
}

async function withMockedLlm<T>(
  handler: (symbols: string[], call: number) => unknown,
  fn: () => Promise<T>,
): Promise<{ result: T; calls: string[][] }> {
  process.env.LLM_PROVIDER = "deepseek";
  process.env.DEEPSEEK_API_KEY = "sk-test";
  const originalFetch = globalThis.fetch;
  const calls: string[][] = [];
  let call = 0;
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      messages?: Array<{ role: string; content: string }>;
    };
    const user = body.messages?.find((m) => m.role === "user");
    const payload = JSON.parse(user?.content ?? "{}") as { symbols?: Array<{ symbol: string }> };
    const symbols = (payload.symbols ?? []).map((s) => s.symbol);
    calls.push(symbols);
    const content = JSON.stringify(handler(symbols, call++));
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const result = await fn();
    return { result, calls };
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.LLM_PROVIDER;
    delete process.env.DEEPSEEK_API_KEY;
  }
}

test("scoreSymbols sends every scorable symbol through the LLM pipeline in deterministic batches", async () => {
  const { scoreSymbols } = await import("../lib/deepseek");
  const input = [snapshot("A"), snapshot("B"), snapshot("C")];
  const { result, calls } = await withMockedLlm(
    (symbols) => ({
      signals: symbols.map((symbol) => ({
        symbol,
        action: "hold",
        confidence: 0.5,
        size: 0,
        rationale: "ok",
      })),
    }),
    () => scoreSymbols(input, { bypassCache: true, batchSize: 2 }),
  );
  assert.deepEqual(calls, [["A", "B"], ["C"]]);
  assert.deepEqual(result.map((s) => s.symbol), ["A", "B", "C"]);
  assert.ok(result.every((s) => s.source === "llm-live"));
});

test("scoreSymbols rejects insufficient kline snapshots before calling the LLM", async () => {
  const { scoreSymbols } = await import("../lib/deepseek");
  const input = [snapshot("A"), snapshot("SHORT", 3)];
  const { calls } = await withMockedLlm(
    (symbols) => ({
      signals: symbols.map((symbol) => ({
        symbol,
        action: "buy",
        confidence: 0.8,
        size: 0.5,
        rationale: "ok",
      })),
    }),
    async () => {
      await assert.rejects(
        () => scoreSymbols(input, { bypassCache: true, batchSize: 40 }),
        /insufficient live kline data.*SHORT/,
      );
    },
  );
  assert.deepEqual(calls, []);
});

test("scoreSymbols rejects missing duplicate unknown and invalid LLM outputs", async () => {
  const { scoreSymbols } = await import("../lib/deepseek");
  await assert.rejects(
    () => withMockedLlm(() => ({ signals: [] }), () => scoreSymbols([snapshot("A")], { bypassCache: true })),
    /missing symbols: A/,
  );
  await assert.rejects(
    () => withMockedLlm(() => ({ signals: [
      { symbol: "A", action: "hold", confidence: 0.5, size: 0, rationale: "ok" },
      { symbol: "A", action: "hold", confidence: 0.5, size: 0, rationale: "ok" },
    ] }), () => scoreSymbols([snapshot("A")], { bypassCache: true })),
    /duplicate symbol A/,
  );
  await assert.rejects(
    () => withMockedLlm(() => ({ signals: [
      { symbol: "B", action: "hold", confidence: 0.5, size: 0, rationale: "ok" },
    ] }), () => scoreSymbols([snapshot("A")], { bypassCache: true })),
    /unknown symbol B/,
  );
  await assert.rejects(
    () => withMockedLlm(() => ({ signals: [
      { symbol: "A", action: "watch", confidence: 0.5, size: 0, rationale: "ok" },
    ] }), () => scoreSymbols([snapshot("A")], { bypassCache: true })),
    /invalid action/,
  );
});

test("scoreSymbols clamps numeric fields and truncates rationale", async () => {
  const { scoreSymbols } = await import("../lib/deepseek");
  const long = "x".repeat(100);
  const { result } = await withMockedLlm(
    () => ({ signals: [{ symbol: "A", action: "buy", confidence: 2, size: -1, rationale: long }] }),
    () => scoreSymbols([snapshot("A")], { bypassCache: true }),
  );
  assert.equal(result[0].confidence, 1);
  assert.equal(result[0].size, 0);
  assert.equal(result[0].rationale.length, 60);
});

test("scoreSymbols prefilters large universes before calling the LLM", async () => {
  const { scoreSymbols } = await import("../lib/deepseek");
  const input = [
    snapshot("A"),
    snapshot("B"),
    { ...snapshot("C"), closes: Array.from({ length: 30 }, (_, i) => 100 - i) },
  ];
  const { result, calls } = await withMockedLlm(
    (symbols) => ({
      signals: symbols.map((symbol) => ({
        symbol,
        action: "buy",
        confidence: 0.8,
        size: 0.3,
        rationale: "candidate",
      })),
    }),
    () => scoreSymbols(input, { bypassCache: true, batchSize: 2, candidateLimit: 2 }),
  );
  assert.deepEqual(calls, [["A", "B"]]);
  assert.equal(result.find((s) => s.symbol === "C")?.source, "rule-prefilter");
  assert.equal(result.find((s) => s.symbol === "C")?.action, "hold");
});

test("scoreSymbols can explicitly fail soft when LLM scoring fails", async () => {
  const { scoreSymbols } = await import("../lib/deepseek");
  const originalFetch = globalThis.fetch;
  process.env.LLM_PROVIDER = "deepseek";
  process.env.DEEPSEEK_API_KEY = "sk-test";
  globalThis.fetch = (async () => new Response("bad gateway", { status: 502 })) as typeof fetch;
  try {
    const result = await scoreSymbols([snapshot("A")], {
      bypassCache: true,
      allowLlmFallback: true,
    });
    assert.equal(result[0].source, "llm-fallback");
    assert.equal(result[0].action, "hold");
    assert.match(result[0].dataQuality?.join(";") ?? "", /llm_error:deepseek 502/);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.LLM_PROVIDER;
    delete process.env.DEEPSEEK_API_KEY;
  }
});

test("scoreSymbols does not fall back to rule-driven trading when the LLM is unavailable", async () => {
  const { scoreSymbols } = await import("../lib/deepseek");
  const originalFetch = globalThis.fetch;
  process.env.LLM_PROVIDER = "deepseek";
  process.env.DEEPSEEK_API_KEY = "sk-test";
  globalThis.fetch = (async () => new Response("bad gateway", { status: 502 })) as typeof fetch;
  try {
    await assert.rejects(
      () => scoreSymbols([snapshot("A")], { bypassCache: true }),
      /deepseek 502/,
    );
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.LLM_PROVIDER;
    delete process.env.DEEPSEEK_API_KEY;
  }
});

test("scoreSymbols uses a shorter timeout for backtest mode", async () => {
  const { scoreSymbols } = await import("../lib/deepseek");
  const originalFetch = globalThis.fetch;
  process.env.LLM_PROVIDER = "deepseek";
  process.env.DEEPSEEK_API_KEY = "sk-test";
  process.env.BACKTEST_LLM_TIMEOUT_MS = "5";
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    return await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      });
    });
  }) as typeof fetch;
  try {
    await assert.rejects(
      () => scoreSymbols([snapshot("A")], { bypassCache: true, mode: "backtest" }),
      /deepseek timed out after 5ms/,
    );
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.LLM_PROVIDER;
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.BACKTEST_LLM_TIMEOUT_MS;
  }
});
