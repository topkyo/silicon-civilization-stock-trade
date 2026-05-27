import Link from "next/link";
import { readUniverse } from "@/lib/universe";
import { SITE_EYEBROW, SITE_HERO, SITE_NAME } from "@/lib/site";
import RefreshUniverseButton from "./RefreshUniverseButton";
import UniverseTable from "./UniverseTable";

export const dynamic = "force-dynamic";

export default function Home() {
  const universe = readUniverse();
  const entries = universe.entries;
  const globalCount = entries.filter((e) => e.global_supply).length;
  const themeCount = new Set(entries.map((e) => e.theme)).size;

  return (
    <div className="container">
      <header className="page-header">
        <div>
          <div className="eyebrow">{SITE_EYEBROW}</div>
          <h1>{SITE_NAME}</h1>
          <p>{SITE_HERO}</p>
        </div>
        <div className="header-actions">
          <Link href="/signals" className="button secondary">实时信号</Link>
          <Link href="/backtest" className="button secondary">策略回测</Link>
        </div>
      </header>

      <div className="summary-grid">
        <div className="metric">
          <span className="label">股票池</span>
          <strong>{entries.length}</strong>
          <span>仅 A 股</span>
        </div>
        <div className="metric">
          <span className="label">全球供应链</span>
          <strong>{globalCount}</strong>
          <span>{Math.round((globalCount / Math.max(entries.length, 1)) * 100)}% 覆盖</span>
        </div>
        <div className="metric">
          <span className="label">子主题</span>
          <strong>{themeCount}</strong>
          <span>按产业环节分组</span>
        </div>
        <div className="metric">
          <span className="label">更新时间</span>
          <strong>{universe.updated_at}</strong>
          <span>{universe.updated_by}</span>
        </div>
      </div>

      <div className="section-heading">
        <div>
          <h2>股票池</h2>
          <p>筛选主题标的，查看现价、分析师一致预期与数据加载状态。</p>
        </div>
        <RefreshUniverseButton />
      </div>

      <UniverseTable entries={entries} />
    </div>
  );
}
