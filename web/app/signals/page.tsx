import Link from "next/link";
import { scoreSymbols, type SymbolSnapshot } from "@/lib/deepseek";
import { mapPool } from "@/lib/concurrent";
import { fetchKlines, fetchFundamental, fetchSpot } from "@/lib/pyserver";
import { SITE_EYEBROW } from "@/lib/site";
import { loadEntries } from "@/lib/universe";
import { snapshotSignals } from "@/lib/snapshot";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const LOAD_CONCURRENCY = Number(process.env.SIGNALS_LOAD_CONCURRENCY ?? 6);
const SIGNALS_PYSERVER_TIMEOUT_MS = Number(process.env.SIGNALS_PYSERVER_TIMEOUT_MS ?? 12_000);
const SIGNALS_LIVE_TIMEOUT_MS = Number(process.env.SIGNALS_LIVE_TIMEOUT_MS ?? 25_000);

type LiveSnapshot = SymbolSnapshot & { spotPrice?: number };

function calcPeg(pe?: number | null, profitYoyPct?: number | null) {
  if (pe == null || profitYoyPct == null || pe <= 0 || profitYoyPct <= 0) {
    return null;
  }
  return pe / profitYoyPct;
}

function snapshotRows(universe: ReturnType<typeof loadEntries>) {
  const snap = snapshotSignals();
  if (!snap?.signals && !snap?.fundamentals) return null;
  const fundamentals = new Map((snap.fundamentals ?? []).map((f) => [f.symbol, f]));
  const signals = new Map((snap.signals ?? []).map((s) => [s.symbol, s]));
  return universe.map((e) => ({
    entry: e,
    snapshot: {
      symbol: e.symbol,
      name: e.name,
      theme: e.theme,
      spotPrice: undefined,
      closes: [] as number[],
      fundamental: (() => {
        const f = fundamentals.get(e.symbol);
        return f
          ? {
              pe_ttm: f.pe_ttm,
              pb: f.pb,
              market_cap: f.market_cap,
              profit_yoy: f.profit_yoy,
            }
          : undefined;
      })(),
    },
    signal: (() => {
      const signal = signals.get(e.symbol);
      return signal ? { ...signal, source: "snapshot" as const } : undefined;
    })(),
  }));
}

function timeout<T>(ms: number): Promise<T> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`signals live timeout after ${ms}ms`)), ms);
  });
}

async function loadLiveSignals(universe: ReturnType<typeof loadEntries>) {
  if (process.env.SIGNALS_SNAPSHOT_ONLY === "1") {
    throw new Error("signals snapshot-only mode enabled");
  }
  const start = (() => {
    const d = new Date();
    d.setDate(d.getDate() - 90);
    return d.toISOString().slice(0, 10).replaceAll("-", "");
  })();

  const snapshots: LiveSnapshot[] = await mapPool(universe, LOAD_CONCURRENCY, async (e) => {
    const [klines, fund, spot] = await Promise.all([
      fetchKlines(e.symbol, start, undefined, SIGNALS_PYSERVER_TIMEOUT_MS).catch(() => []),
      fetchFundamental(e.symbol, SIGNALS_PYSERVER_TIMEOUT_MS).catch(() => undefined),
      fetchSpot(e.symbol, SIGNALS_PYSERVER_TIMEOUT_MS).catch(() => undefined),
    ]);
    return {
      symbol: e.symbol,
      name: e.name,
      theme: e.theme,
      spotPrice: spot?.price,
      closes: klines.map((k) => k.close),
      fundamental: fund
        ? {
            pe_ttm: fund.pe_ttm,
            pb: fund.pb,
            market_cap: fund.market_cap,
            profit_yoy: fund.profit_yoy,
          }
        : undefined,
    };
  });

  if (snapshots.every((s) => s.closes.length < 10)) throw new Error("no live signal data loaded");
  const signals = await scoreSymbols(snapshots);
  const byId = new Map(signals.map((s) => [s.symbol, s]));

  return universe.map((e) => ({
    entry: e,
    snapshot: snapshots.find((s) => s.symbol === e.symbol),
    signal: byId.get(e.symbol),
  }));
}

async function loadSignals() {
  const universe = loadEntries();
  try {
    return await Promise.race([
      loadLiveSignals(universe),
      timeout<Awaited<ReturnType<typeof loadLiveSignals>>>(SIGNALS_LIVE_TIMEOUT_MS),
    ]);
  } catch {
    const rows = snapshotRows(universe);
    if (rows) return rows;
    throw new Error("no live or snapshot signal data available");
  }
}

export default async function SignalsPage() {
  let rows: Awaited<ReturnType<typeof loadSignals>> = [];
  let error: string | null = null;
  try {
    rows = await loadSignals();
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  return (
    <div className="container">
      <Link href="/" className="back-link">返回股票池</Link>
      <header className="page-header compact">
        <div>
          <div className="eyebrow">{SITE_EYEBROW}</div>
          <h1>实时信号</h1>
          <p>LLM 统一输出 buy / hold / sell，规则层只提供价格、估值、增速、PEG 与数据质量特征；来源列标记 live、cache 或 snapshot。</p>
        </div>
      </header>
      {error && (
        <div className="card" style={{ borderColor: "var(--danger)" }}>
          <strong>加载失败：</strong> {error}
          <p style={{ color: "var(--muted)" }}>
            请确认 pyserver 运行在 <code>{process.env.PYSERVER_URL ?? "http://localhost:8001"}</code>，
            且 <code>DEEPSEEK_API_KEY</code> 已配置。
          </p>
        </div>
      )}
      {!error && (
        <div className="theme-panel">
          <div className="theme-title">
            <strong>信号列表</strong>
            <span>{rows.filter((r) => r.signal?.action === "buy").length} 买入 · {rows.filter((r) => r.signal?.action === "sell").length} 卖出</span>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>代码</th>
                  <th>名称</th>
                  <th>主题</th>
                  <th>动作</th>
                  <th className="num">现价</th>
                  <th className="num">置信度</th>
                  <th className="num">仓位</th>
                  <th className="num">PE(TTM)</th>
                  <th className="num">利润同比</th>
                  <th className="num">PEG</th>
                  <th>来源</th>
                  <th>理由</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ entry, signal, snapshot }) => (
                  <tr key={entry.symbol}>
                    <td className="mono">{entry.symbol}</td>
                    <td>{entry.name}</td>
                    <td>{entry.theme}</td>
                    <td>
                      {signal ? (
                        <span className={`badge ${signal.action}`}>{signal.action}</span>
                      ) : (
                        <span className="badge">n/a</span>
                      )}
                    </td>
                    <td className="num">{snapshot?.spotPrice?.toFixed(2) ?? snapshot?.closes.at(-1)?.toFixed(2) ?? "—"}</td>
                    <td className="num">{signal ? (signal.confidence * 100).toFixed(0) + "%" : "—"}</td>
                    <td className="num">{signal ? (signal.size * 100).toFixed(0) + "%" : "—"}</td>
                    <td className="num">{snapshot?.fundamental?.pe_ttm?.toFixed(1) ?? "—"}</td>
                    <td className="num">{snapshot?.fundamental?.profit_yoy != null ? `${snapshot.fundamental.profit_yoy.toFixed(1)}%` : "—"}</td>
                    <td className="num">{calcPeg(snapshot?.fundamental?.pe_ttm, snapshot?.fundamental?.profit_yoy)?.toFixed(2) ?? "—"}</td>
                    <td><span className={`badge ${signal?.source ?? ""}`}>{signal?.source ?? "—"}</span></td>
                    <td className="muted signal-reason">{signal?.rationale ?? "—"}</td>
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
