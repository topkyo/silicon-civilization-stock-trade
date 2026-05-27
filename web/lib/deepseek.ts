// DeepSeek v4 client with strict strategy-output validation.
//
// Strategy boundary:
//   1. Rule code ranks candidates and annotates data quality.
//   2. LLM is the buy/hold/sell decision source for ranked candidates.
//   3. Deterministic code validates LLM output and enforces portfolio rules.
import { cachedWithMeta } from "./cache";
import { llmApiKeyConfigured, resolveLlmConfig } from "./llm/config";
import { buildRuleFeatures } from "./scoring/rules";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOptions {
  model?: string;
  temperature?: number;
  responseFormat?: "json_object" | "text";
  ttlSeconds?: number;
  bypassCache?: boolean;
  timeoutMs?: number;
}

export interface ChatResult {
  content: string;
  cacheHit: boolean;
}

function extractMessageContent(message: Record<string, unknown> | undefined): string {
  if (!message) return "";
  const content = message.content;
  if (typeof content === "string" && content.trim()) return content;
  if (Array.isArray(content)) {
    const text = content
      .map((part) => (typeof part === "object" && part && "text" in part ? String((part as { text?: string }).text ?? "") : ""))
      .join("")
      .trim();
    if (text) return text;
  }
  const reasoning = message.reasoning_content;
  if (typeof reasoning === "string" && reasoning.trim()) return reasoning;
  return "";
}

export async function chatDetailed(
  messages: ChatMessage[],
  opts: ChatOptions = {},
): Promise<ChatResult> {
  const cfg = resolveLlmConfig();
  if (!llmApiKeyConfigured(cfg)) {
    throw new Error(
      cfg.provider === "opencode-go"
        ? "OPENCODE_GO_API_KEY is not set"
        : "DEEPSEEK_API_KEY is not set",
    );
  }
  const model = opts.model ?? cfg.model;
  const temperature = opts.temperature ?? 0.2;
  const responseFormat = opts.responseFormat ?? "text";
  const ttl = opts.ttlSeconds ?? 12 * 3600;

  const cacheParts = {
    provider: cfg.provider,
    model,
    temperature,
    responseFormat,
    messages,
  };
  const llmTimeoutMs = opts.timeoutMs ?? Number(process.env.LLM_TIMEOUT_MS ?? 120_000);

  const doFetch = async () => {
    const body: Record<string, unknown> = {
      model,
      messages,
      temperature,
      stream: false,
    };
    if (responseFormat === "json_object") {
      body.response_format = { type: "json_object" };
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), llmTimeoutMs);
    let r: Response;
    try {
      r = await fetch(cfg.chatCompletionsUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") {
        throw new Error(`${cfg.provider} timed out after ${llmTimeoutMs}ms`);
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
    if (!r.ok) {
      throw new Error(`${cfg.provider} ${r.status}: ${await r.text()}`);
    }
    const j = (await r.json()) as {
      choices?: { message?: Record<string, unknown> }[];
    };
    const content = extractMessageContent(j.choices?.[0]?.message);
    if (!content.trim()) {
      throw new Error(`${cfg.provider} returned empty content`);
    }
    return content;
  };

  if (opts.bypassCache) {
    return { content: await doFetch(), cacheHit: false };
  }
  const result = await cachedWithMeta(cacheParts, ttl, doFetch);
  return { content: result.value, cacheHit: result.cacheHit };
}

export async function chat(
  messages: ChatMessage[],
  opts: ChatOptions = {},
): Promise<string> {
  return (await chatDetailed(messages, opts)).content;
}

// ----- Strategy-specific helpers ------------------------------------------

export interface SymbolSnapshot {
  symbol: string;
  name?: string | null;
  theme?: string;
  closes: number[];      // last ~60 daily closes, oldest first
  fundamental?: {
    pe_ttm?: number | null;
    pb?: number | null;
    market_cap?: number | null;
    profit_yoy?: number | null;
  };
}

export type SignalSource = "llm-live" | "llm-cache";

export interface Signal {
  symbol: string;
  action: "buy" | "hold" | "sell";
  confidence: number;    // 0..1
  size: number;          // 0..1 fraction of available capital
  rationale: string;
  source?: SignalSource;
  dataQuality?: string[];
}

const STRATEGY_SYSTEM = `你是一名专注于"硅基文明消费"主题的中国市场量化策略师。

主题定义：将 AI / 硅基文明视为一个新兴文明，其自身需要"消费"的不是人类消费品，
而是支撑算力存在与扩张的基础投入——算力芯片、光模块/高速互连、AI 服务器、
液冷散热、电力(尤其绿电与核电)、IDC 数据中心、HBM/存储、半导体设备与材料、
高速 PCB、晶圆代工、云计算。我们做多这些"喂养"硅基文明的卖铲人。

任务：给定一组上述主题股票的近期价格序列与基本面快照，输出 5-20 个交易日的
交易动作。三大维度平衡评估：基本面估值（PEG/利润增速/估值匹配）、主题景气度
（算力需求边际变化、订单/出货传导、市值位置）、价格动量（趋势、均线、动量与
拥挤度）。

决策权重：基本面估值约 40%，主题景气度约 30%，价格动量与择时约 30%。三者中
任意一项强势均可成为买入理由；高 PE 但利润增速与主题景气度同时强、且价格处于
有效突破的标的可以买入；PEG 偏低但主题/动量同时走弱的标的不必强买。卖出条件：
PEG 显著恶化、或主题景气度反转、或价格跌破关键均线且伴随成交萎缩。

严格输出 JSON：{"signals":[{"symbol":"...","action":"buy|hold|sell","confidence":0..1,"size":0..1,"rationale":"中文,<=60字"}]}
必须覆盖输入中的每一个 symbol，且每个 symbol 只能出现一次。
不要输出任何其他文本。`;

const MIN_SCORABLE_KLINES = 10;
const DEFAULT_SCORE_BATCH_SIZE = 40;
const VALID_ACTIONS = new Set(["buy", "hold", "sell"]);

function envPositiveNumber(name: string, fallback?: number): number | undefined {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function clamp01(value: unknown): number {
  const n = typeof value === "number" && Number.isFinite(value) ? value : 0;
  return Number(Math.min(1, Math.max(0, n)).toFixed(3));
}

function normalizeRationale(value: unknown): string {
  const text = typeof value === "string" && value.trim() ? value.trim() : "LLM未提供理由";
  return text.slice(0, 60);
}

function chunks<T>(items: T[], size: number): T[][] {
  const safeSize = Math.max(1, Math.floor(size));
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += safeSize) out.push(items.slice(i, i + safeSize));
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function signalSource(cacheHit: boolean): SignalSource {
  return cacheHit ? "llm-cache" : "llm-live";
}

function normalizeLlmSignals(
  raw: string,
  batch: SymbolSnapshot[],
  source: SignalSource,
): Signal[] {
  let parsed: { signals?: unknown };
  try {
    parsed = JSON.parse(raw) as { signals?: unknown };
  } catch (e) {
    throw new Error(`LLM returned invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!Array.isArray(parsed.signals)) {
    throw new Error("LLM response missing signals array");
  }

  const expected = new Set(batch.map((s) => s.symbol));
  const featuresBySymbol = new Map(batch.map((s) => [s.symbol, buildRuleFeatures(s)]));
  const seen = new Set<string>();
  const out: Signal[] = [];

  for (const item of parsed.signals) {
    if (!item || typeof item !== "object") {
      throw new Error("LLM signal item must be an object");
    }
    const candidate = item as Record<string, unknown>;
    const symbol = typeof candidate.symbol === "string" ? candidate.symbol.trim() : "";
    if (!expected.has(symbol)) {
      throw new Error(`LLM returned unknown symbol ${symbol || "<empty>"}`);
    }
    if (seen.has(symbol)) {
      throw new Error(`LLM returned duplicate symbol ${symbol}`);
    }
    seen.add(symbol);

    const action = typeof candidate.action === "string" ? candidate.action : "";
    if (!VALID_ACTIONS.has(action)) {
      throw new Error(`LLM returned invalid action for ${symbol}: ${action || "<empty>"}`);
    }

    out.push({
      symbol,
      action: action as Signal["action"],
      confidence: clamp01(candidate.confidence),
      size: clamp01(candidate.size),
      rationale: normalizeRationale(candidate.rationale),
      source,
      dataQuality: featuresBySymbol.get(symbol)?.dataMissingFlags ?? [],
    });
  }

  const missing = [...expected].filter((symbol) => !seen.has(symbol));
  if (missing.length > 0) {
    throw new Error(`LLM response missing symbols: ${missing.join(",")}`);
  }

  const bySymbol = new Map(out.map((signal) => [signal.symbol, signal]));
  return batch.map((snapshot) => bySymbol.get(snapshot.symbol)!);
}

async function scoreSymbolsBatchLlm(
  snapshots: SymbolSnapshot[],
  opts: {
    asOf?: string;
    bypassCache?: boolean;
    mode?: "live" | "backtest";
  } = {},
): Promise<Signal[]> {
  if (snapshots.length === 0) return [];
  const userPayload = {
    as_of: opts.asOf ?? new Date().toISOString().slice(0, 10),
    scoring_rule: "40/30/30 三维平衡：基本面(PEG=pe_ttm/profit_yoy_pct,越低越优)40%、主题景气30%、价格动量30%。任一维度强势可作买入触发。",
    symbols: snapshots.map((s) => ({
      symbol: s.symbol,
      name: s.name ?? undefined,
      theme: s.theme,
      // truncate to last 30 closes to keep prompt small while preserving trend
      closes_tail30: s.closes.slice(-30).map((x) => Number(x.toFixed(3))),
      pe_ttm: s.fundamental?.pe_ttm ?? null,
      pb: s.fundamental?.pb ?? null,
      market_cap_yi: s.fundamental?.market_cap ?? null,
      profit_yoy_pct: s.fundamental?.profit_yoy ?? null,
      features: (() => {
        const f = buildRuleFeatures(s);
        return {
          peg: f.peg,
          peg_score: Number(f.pegScore.toFixed(3)),
          momentum_20d_pct: f.momentum20dPct,
          momentum_score: Number(f.momentumScore.toFixed(3)),
          theme_score: Number(f.themeScore.toFixed(3)),
          data_missing_flags: f.dataMissingFlags,
        };
      })(),
    })),
  };

  const messages = [
    { role: "system" as const, content: STRATEGY_SYSTEM },
    { role: "user" as const, content: JSON.stringify(userPayload) },
  ];
  const model = opts.mode === "backtest" ? resolveLlmConfig().backtestModel : resolveLlmConfig().model;
  const timeoutMs = opts.mode === "backtest"
    ? envPositiveNumber("BACKTEST_LLM_TIMEOUT_MS", 90_000)
    : envPositiveNumber("SIGNALS_LLM_TIMEOUT_MS", 90_000);
  let lastError: unknown;
  const attempts = opts.bypassCache ? 1 : 3;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const result = await chatDetailed(messages, {
        model,
        responseFormat: "json_object",
        temperature: attempt === 0 ? 0.2 : 0,
        bypassCache: opts.bypassCache || attempt > 0,
        timeoutMs,
      });
      if (!result.content.trim()) {
        throw new Error("LLM returned empty content");
      }
      return normalizeLlmSignals(result.content, snapshots, signalSource(result.cacheHit));
    } catch (e) {
      lastError = e;
      if (attempt < attempts - 1) {
        await sleep(500 * (attempt + 1));
      }
    }
  }
  throw lastError;
}

export const scoreSymbolsLlm = scoreSymbolsBatchLlm;

export async function scoreSymbols(
  snapshots: SymbolSnapshot[],
  opts: {
    asOf?: string;
    bypassCache?: boolean;
    mode?: "live" | "backtest";
    batchSize?: number;
  } = {},
): Promise<Signal[]> {
  if (snapshots.length === 0) return [];

  const unscorable = snapshots.filter((s) => s.closes.length < MIN_SCORABLE_KLINES);
  if (unscorable.length > 0) {
    throw new Error(
      `insufficient live kline data for LLM scoring: ${unscorable.map((s) => s.symbol).join(",")}`,
    );
  }

  const seen = new Set<string>();
  const duplicateInput = snapshots
    .map((s) => s.symbol)
    .filter((symbol) => {
      if (seen.has(symbol)) return true;
      seen.add(symbol);
      return false;
    });
  if (duplicateInput.length > 0) {
    throw new Error(`duplicate input symbols for LLM scoring: ${duplicateInput.join(",")}`);
  }

  const batchSize = opts.batchSize ?? Number(process.env.LLM_SCORE_BATCH_SIZE ?? DEFAULT_SCORE_BATCH_SIZE);
  const scored = (
    await Promise.all(chunks(snapshots, batchSize).map((batch) => scoreSymbolsBatchLlm(batch, opts)))
  ).flat();

  const bySymbol = new Map(scored.map((signal) => [signal.symbol, signal] as const));
  return snapshots.map((snapshot) => bySymbol.get(snapshot.symbol)!);
}
