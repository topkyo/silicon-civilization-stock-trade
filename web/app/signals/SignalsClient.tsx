"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { SITE_EYEBROW } from "@/lib/site";
import type { Signal } from "@/lib/deepseek";
import type { UniverseEntry } from "@/lib/universe";

type Phase = "loading" | "scoring";

interface Progress {
  phase: Phase;
  done: number;
  total: number;
}

interface SignalRow {
  entry: UniverseEntry;
  snapshot: {
    symbol: string;
    name?: string | null;
    theme?: string;
    closes: number[];
    dataErrors?: string[];
    fundamentalSource?: string | null;
    fundamentalFieldSources?: Record<string, string> | null;
    fundamental?: {
      pe_ttm?: number | null;
      pb?: number | null;
      market_cap?: number | null;
      profit_yoy?: number | null;
    };
  };
  signal: Signal;
}

const PHASE_LABEL: Record<Phase, string> = {
  loading: "加载 AkShare/Tushare 数据",
  scoring: "LLM 生成信号",
};

const PHASE_WEIGHT: Record<Phase, number> = {
  loading: 0.65,
  scoring: 0.35,
};

function calcPeg(pe?: number | null, profitYoyPct?: number | null) {
  if (pe == null || profitYoyPct == null || pe <= 0 || profitYoyPct <= 0) return null;
  return pe / profitYoyPct;
}

function progressPct(progress: Progress | null): number {
  if (!progress) return 0;
  const current = progress.total > 0 ? progress.done / progress.total : 0;
  if (progress.phase === "loading") return Math.min(65, Math.round(current * PHASE_WEIGHT.loading * 100));
  return Math.min(100, Math.round((PHASE_WEIGHT.loading + current * PHASE_WEIGHT.scoring) * 100));
}

function formatFieldSources(sources?: Record<string, string> | null): string {
  if (!sources || Object.keys(sources).length === 0) return "—";
  return Object.entries(sources)
    .filter(([field]) => ["pe_ttm", "pb", "market_cap", "profit_yoy"].includes(field))
    .map(([field, source]) => `${field}:${source}`)
    .join("; ") || "—";
}

export default function SignalsClient() {
  const [rows, setRows] = useState<SignalRow[]>([]);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  async function run() {
    setLoading(true);
    setError(null);
    setRows([]);
    setProgress(null);
    try {
      const response = await fetch("/api/signals", { method: "POST" });
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (!line) continue;
          const evt = JSON.parse(line) as
            | { type: "progress"; phase: Phase; done: number; total: number }
            | { type: "result"; rows: SignalRow[] }
            | { type: "error"; message: string };
          if (evt.type === "progress") {
            setProgress({ phase: evt.phase, done: evt.done, total: evt.total });
          } else if (evt.type === "result") {
            setRows(evt.rows);
          } else {
            setError(evt.message);
          }
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void run();
  }, []);

  const buyCount = useMemo(() => rows.filter((r) => r.signal.action === "buy").length, [rows]);
  const sellCount = useMemo(() => rows.filter((r) => r.signal.action === "sell").length, [rows]);
  const pct = progressPct(progress);

  return (
    <div className="container">
      <Link href="/" className="back-link">返回股票池</Link>
      <header className="page-header compact">
        <div>
          <div className="eyebrow">{SITE_EYEBROW}</div>
          <h1>实时信号</h1>
          <p>LLM 统一输出 buy / hold / sell；AkShare 优先，Tushare 作为可审计次级源。K 线失败会终止，基本面缺失会作为数据错误进入特征。</p>
        </div>
        <div className="header-actions">
          <button onClick={run} disabled={loading}>{loading ? "运行中…" : "重新生成"}</button>
        </div>
      </header>

      {(loading || progress) && (
        <div className="card" style={{ marginBottom: 14 }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
            <span>
              {progress ? PHASE_LABEL[progress.phase] : "准备中…"}
              {progress && ` ${progress.done}/${progress.total}`}
            </span>
            <span className="muted">{pct}%</span>
          </div>
          <div className="fetch-progress-track" style={{ marginTop: 8 }}>
            <div className="fetch-progress-bar" style={{ width: `${pct}%` }} />
          </div>
        </div>
      )}

      {error && (
        <div className="card" style={{ borderColor: "var(--danger)", marginBottom: 14 }}>
          <strong>加载失败：</strong> {error}
        </div>
      )}

      {rows.length > 0 && (
        <div className="theme-panel">
          <div className="theme-title">
            <strong>信号列表</strong>
            <span>{buyCount} 买入 · {sellCount} 卖出</span>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>代码</th>
                  <th>名称</th>
                  <th>主题</th>
                  <th>动作</th>
                  <th className="num">最近收盘</th>
                  <th className="num">置信度</th>
                  <th className="num">仓位</th>
                  <th className="num">PE(TTM)</th>
                  <th className="num">利润同比</th>
                  <th className="num">PEG</th>
                  <th>LLM来源</th>
                  <th>数据源</th>
                  <th>理由</th>
                  <th>数据错误</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ entry, signal, snapshot }) => (
                  <tr key={entry.symbol}>
                    <td className="mono">{entry.symbol}</td>
                    <td>{entry.name}</td>
                    <td>{entry.theme}</td>
                    <td><span className={`badge ${signal.action}`}>{signal.action}</span></td>
                    <td className="num">{snapshot.closes.at(-1)?.toFixed(2) ?? "—"}</td>
                    <td className="num">{(signal.confidence * 100).toFixed(0)}%</td>
                    <td className="num">{(signal.size * 100).toFixed(0)}%</td>
                    <td className="num">{snapshot.fundamental?.pe_ttm?.toFixed(1) ?? "—"}</td>
                    <td className="num">{snapshot.fundamental?.profit_yoy != null ? `${snapshot.fundamental.profit_yoy.toFixed(1)}%` : "—"}</td>
                    <td className="num">{calcPeg(snapshot.fundamental?.pe_ttm, snapshot.fundamental?.profit_yoy)?.toFixed(2) ?? "—"}</td>
                    <td><span className={`badge ${signal.source ?? ""}`}>{signal.source ?? "—"}</span></td>
                    <td className="muted signal-reason">
                      {[snapshot.fundamentalSource, formatFieldSources(snapshot.fundamentalFieldSources)]
                        .filter((part) => part && part !== "—")
                        .join("; ") || "—"}
                    </td>
                    <td className="muted signal-reason">{signal.rationale}</td>
                    <td className="muted signal-reason">{snapshot.dataErrors?.join("; ") || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
