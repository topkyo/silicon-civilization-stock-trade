import type { SymbolSnapshot } from "../deepseek";

export interface RuleFeatures {
  symbol: string;
  score: number;
  peg: number | null;
  pegScore: number;
  momentum20dPct: number | null;
  momentumScore: number;
  themeScore: number;
  dataMissingFlags: string[];
}

const GLOBAL_SUPPLY_THEMES = new Set([
  "光模块",
  "AI服务器",
  "存储/HBM",
  "半导体设备",
  "半导体材料",
  "AI-PCB",
  "晶圆代工",
]);

export function calcPeg(pe?: number | null, profitYoyPct?: number | null): number | null {
  if (pe == null || profitYoyPct == null || pe <= 0 || profitYoyPct <= 0) {
    return null;
  }
  return Number((pe / profitYoyPct).toFixed(3));
}

function pegScore(peg: number | null): number {
  if (peg == null) return 0.45;
  if (peg <= 0.8) return 1;
  if (peg <= 1.2) return 0.85;
  if (peg <= 2) return 0.6;
  if (peg <= 3) return 0.35;
  return 0.15;
}

function momentum20dPct(closes: number[]): number | null {
  if (closes.length < 10) return null;
  const tail = closes.slice(-20);
  const start = tail[0];
  const end = tail[tail.length - 1];
  if (start <= 0) return null;
  return Number(((end / start - 1) * 100).toFixed(3));
}

function momentumScore(momentumPct: number | null): number {
  if (momentumPct == null) return 0.4;
  if (momentumPct > 15) return 1;
  if (momentumPct > 5) return 0.75;
  if (momentumPct > -5) return 0.5;
  if (momentumPct > -15) return 0.25;
  return 0.1;
}

function themeScore(theme?: string): number {
  if (!theme) return 0.5;
  if (GLOBAL_SUPPLY_THEMES.has(theme)) return 0.85;
  if (theme.includes("算力") || theme.includes("IDC") || theme.includes("液冷")) {
    return 0.75;
  }
  return 0.55;
}

function dataMissingFlags(snapshot: SymbolSnapshot, peg: number | null, momentumPct: number | null): string[] {
  const flags: string[] = [];
  if (snapshot.closes.length < 10) flags.push("insufficient_klines");
  if (!snapshot.fundamental) flags.push("missing_fundamental");
  if (snapshot.fundamental?.pe_ttm == null) flags.push("missing_pe_ttm");
  if (snapshot.fundamental?.profit_yoy == null) flags.push("missing_profit_yoy");
  if (snapshot.fundamental?.pb == null) flags.push("missing_pb");
  if (snapshot.fundamental?.market_cap == null) flags.push("missing_market_cap");
  if (peg == null) flags.push("missing_peg");
  if (momentumPct == null) flags.push("missing_momentum");
  return flags;
}

export function buildRuleFeatures(snapshot: SymbolSnapshot): RuleFeatures {
  const peg = calcPeg(snapshot.fundamental?.pe_ttm, snapshot.fundamental?.profit_yoy);
  const m20 = momentum20dPct(snapshot.closes);
  const pScore = pegScore(peg);
  const mScore = momentumScore(m20);
  const tScore = themeScore(snapshot.theme);
  const score = pScore * 0.4 + tScore * 0.3 + mScore * 0.3;

  return {
    symbol: snapshot.symbol,
    score,
    peg,
    pegScore: pScore,
    momentum20dPct: m20,
    momentumScore: mScore,
    themeScore: tScore,
    dataMissingFlags: dataMissingFlags(snapshot, peg, m20),
  };
}

export function rankByFeatures(snapshots: SymbolSnapshot[]): RuleFeatures[] {
  return snapshots.map(buildRuleFeatures).sort((a, b) => b.score - a.score);
}

// Backwards-compatible name; this now ranks features only and does not imply
// a rule-driven trading action.
export const rankByRules = rankByFeatures;
