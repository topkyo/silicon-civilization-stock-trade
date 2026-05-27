# docs/ — 静态展示页

这个目录用于 GitHub Pages 展示，不运行 Next.js，也不访问私有 API key。它读取 `docs/data/*.json`，把完整应用的一次快照渲染成可公开访问的研究看板。

线上地址：<https://topkyo.github.io/topkyo-ai-infra-dashboard/>

## 文件结构

- `index.html`：静态入口，展示股票池、LLM 信号、回测结果。
- `styles.css`：浅色研究台视觉样式，与 Web 应用保持一致。
- `app.js`：无构建依赖的快照渲染逻辑。
- `data/universe.json`：股票池。
- `data/analyst.json`：现价、隐含目标、买入覆盖等一致预期数据。
- `data/signals.json`：LLM 信号与基本面快照。
- `data/backtest.json`：回测曲线与交易记录。
- `data/meta.json`：生成时间。

## 刷新快照

完整刷新需要先启动 pyserver，并配置 LLM key。行情与基本面默认走 AkShare/Eastmoney + BaoStock 免费源；只有需要 Tushare 付费/权限接口补缺时，才设置 `TUSHARE_TOKEN` 和 `MARKET_ENABLE_TUSHARE_SECONDARY=1`。

```bash
cd pyserver && uv run uvicorn main:app --port 8001
cd web && npx tsx scripts/snapshot.ts
```

只刷新股票池/分析师数据，跳过 LLM 信号和回测：

```bash
cd web
SNAPSHOT_SKIP_SIGNALS=1 SNAPSHOT_SKIP_BACKTEST=1 npx tsx scripts/snapshot.ts
```

刷新后提交 `docs/data/` 即可更新 GitHub Pages。

## 本地预览

```bash
python3 -m http.server 8765 --directory docs
```

打开 <http://localhost:8765/>。

## 边界

静态页只展示最近一次快照，不代表实时行情。需要实时数据、在线信号生成、交互式回测时，运行根目录 README 中的完整 Next.js + pyserver 应用。
