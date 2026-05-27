import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { UniverseFile } from "../lib/universe";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scc-refresh-"));
process.chdir(tmp);
fs.mkdirSync("data", { recursive: true });

const baseUniverse: UniverseFile = {
  updated_at: "2026-01-01",
  updated_by: "test",
  entries: [
    { symbol: "000001", name: "平安银行", theme: "云/AI基建" },
  ],
};

function writeBase() {
  fs.writeFileSync("data/universe.json", JSON.stringify(baseUniverse, null, 2) + "\n");
}

function readRaw() {
  return fs.readFileSync("data/universe.json", "utf-8");
}

test("refreshUniverse propagates LLM failures and leaves universe file unchanged", async () => {
  writeBase();
  const before = readRaw();
  const { refreshUniverse } = await import("../lib/universe-refresh");
  const originalFetch = globalThis.fetch;
  process.env.LLM_PROVIDER = "deepseek";
  process.env.DEEPSEEK_API_KEY = "sk-test";
  globalThis.fetch = (async () => new Response("bad gateway", { status: 502 })) as typeof fetch;
  try {
    await assert.rejects(() => refreshUniverse(), /deepseek 502/);
    assert.equal(readRaw(), before);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.LLM_PROVIDER;
    delete process.env.DEEPSEEK_API_KEY;
  }
});

test("applyRefresh accepts an empty proposal without updating updated_at or writing the file", async () => {
  writeBase();
  const before = readRaw();
  const { applyRefresh } = await import("../lib/universe-refresh");
  const result = await applyRefresh(baseUniverse, {
    adds: [],
    removes: [],
    reclassifies: [],
    rationale: "无变更",
  });
  assert.equal(result.finalCount, 1);
  assert.equal(result.applied.added.length, 0);
  assert.equal(readRaw(), before);
});

test("applyRefresh rejects invalid adds without writing a no-change universe", async () => {
  writeBase();
  const before = readRaw();
  const { applyRefresh } = await import("../lib/universe-refresh");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("not found", { status: 404 })) as typeof fetch;
  try {
    const result = await applyRefresh(baseUniverse, {
      adds: [{ symbol: "300002", name: "测试新增", theme: "AI-PCB" }],
      removes: [],
      reclassifies: [],
      rationale: "测试新增",
    });
    assert.deepEqual(result.applied.added, []);
    assert.equal(result.applied.rejected[0].symbol, "300002");
    assert.equal(readRaw(), before);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("applyRefresh writes only when a real add remove or reclassify is applied", async () => {
  writeBase();
  const { applyRefresh } = await import("../lib/universe-refresh");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ symbol: "300003" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  })) as typeof fetch;
  try {
    const result = await applyRefresh(baseUniverse, {
      adds: [{ symbol: "300003", name: "测试新增", theme: "AI-PCB" }],
      removes: [],
      reclassifies: [],
      rationale: "测试新增",
    });
    const next = JSON.parse(readRaw()) as UniverseFile;
    assert.equal(result.applied.added.length, 1);
    assert.equal(next.entries.length, 2);
    assert.notEqual(next.updated_at, baseUniverse.updated_at);
    assert.equal(next.updated_by, "deepseek-refresh");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
