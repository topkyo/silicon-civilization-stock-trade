"use client";
import { useEffect, useMemo, useState } from "react";
import type { UniverseEntry } from "@/lib/universe";

interface Analyst {
  buy_count?: number;
  total_count?: number;
  buy_ratio?: number | null;
  consensus_eps_next?: number | null;
  implied_target?: number | null;
  current_price?: number | null;
  upside_pct?: number | null;
}

type Row = UniverseEntry & { analyst?: Analyst | null; loading?: boolean };

const CONCURRENCY = 4;

async function fetchAnalystFor(symbol: string): Promise<Analyst | null> {
  try {
    const r = await fetch(`/api/analyst?symbol=${encodeURIComponent(symbol)}`);
    if (!r.ok) return null;
    return (await r.json()) as Analyst;
  } catch {
    return null;
  }
}

export default function UniverseTable({ entries }: { entries: UniverseEntry[] }) {
  const [rows, setRows] = useState<Row[]>(() =>
    entries.map((e) => ({ ...e, loading: true })),
  );
  const [onlyGlobal, setOnlyGlobal] = useState(false);
  const [onlyUpside, setOnlyUpside] = useState(false);

  // Re-seed when entries prop changes (after refresh).
  useEffect(() => {
    setRows(entries.map((e) => ({ ...e, loading: true })));
  }, [entries]);

  // Fetch analyst data in a small concurrency pool.
  useEffect(() => {
    let cancelled = false;
    const queue = [...entries];
    let active = 0;
    function pump() {
      while (active < CONCURRENCY && queue.length > 0) {
        const e = queue.shift()!;
        active++;
        fetchAnalystFor(e.symbol).then((a) => {
          if (cancelled) return;
          setRows((prev) =>
            prev.map((r) =>
              r.symbol === e.symbol ? { ...r, analyst: a, loading: false } : r,
            ),
          );
          active--;
          pump();
        });
      }
    }
    pump();
    return () => {
      cancelled = true;
    };
  }, [entries]);

  const filtered = useMemo(() => {
    return rows.filter((r) => {
      if (onlyGlobal && !r.global_supply) return false;
      if (onlyUpside) {
        const u = r.analyst?.upside_pct;
        if (u === undefined || u === null || u <= 0) return false;
      }
      return true;
    });
  }, [rows, onlyGlobal, onlyUpside]);

  const loadedCount = rows.filter((r) => !r.loading).length;
  const grouped = filtered.reduce<Record<string, Row[]>>((acc, r) => {
    (acc[r.theme] ??= []).push(r);
    return acc;
  }, {});

  return (
    <>
      <div className="card" style={{ marginTop: 12, display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
        <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
          <input type="checkbox" checked={onlyGlobal} onChange={(e) => setOnlyGlobal(e.target.checked)} />
          <span>仅全球供应链</span>
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
          <input type="checkbox" checked={onlyUpside} onChange={(e) => setOnlyUpside(e.target.checked)} />
          <span>仅目标价 &gt; 现价（含 EPS 测算）</span>
        </label>
        <span style={{ color: "var(--muted)", fontSize: 12, marginLeft: "auto" }}>
          显示 {filtered.length} / {rows.length} · 卖方数据 {loadedCount}/{rows.length}
        </span>
      </div>

      <div className="row" style={{ marginTop: 12 }}>
        {Object.entries(grouped).map(([theme, items]) => (
          <div key={theme} className="card" style={{ minWidth: 380, flex: "1 1 380px" }}>
            <strong>{theme}</strong>
            <table style={{ marginTop: 8 }}>
              <thead>
                <tr>
                  <th>代码</th>
                  <th>名称</th>
                  <th>全球链</th>
                  <th style={{ textAlign: "right" }}>现价</th>
                  <th style={{ textAlign: "right" }}>目标价</th>
                  <th style={{ textAlign: "right" }}>上行</th>
                  <th style={{ textAlign: "right" }}>买入</th>
                </tr>
              </thead>
              <tbody>
                {items.map((r) => {
                  const u = r.analyst?.upside_pct;
                  return (
                    <tr key={r.symbol}>
                      <td style={{ color: "var(--muted)" }}>{r.symbol}</td>
                      <td>{r.name}</td>
                      <td>{r.global_supply ? "🌐" : ""}</td>
                      <td style={{ textAlign: "right" }}>
                        {r.analyst?.current_price?.toFixed(2) ?? (r.loading ? "…" : "—")}
                      </td>
                      <td style={{ textAlign: "right" }}>
                        {r.analyst?.implied_target?.toFixed(2) ?? (r.loading ? "…" : "—")}
                      </td>
                      <td style={{ textAlign: "right", color: u === undefined || u === null ? "var(--muted)" : u > 0 ? "var(--accent)" : "var(--danger)" }}>
                        {u === undefined || u === null ? (r.loading ? "…" : "—") : `${u > 0 ? "+" : ""}${u.toFixed(0)}%`}
                      </td>
                      <td style={{ textAlign: "right", color: "var(--muted)", fontSize: 12 }}>
                        {r.analyst?.buy_count !== undefined && r.analyst?.total_count
                          ? `${r.analyst.buy_count}/${r.analyst.total_count}`
                          : r.loading ? "…" : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ))}
      </div>
    </>
  );
}
