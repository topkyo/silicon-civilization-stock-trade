# docs/ — 本地静态快照

Next.js 应用最新结果的静态快照，仅供**本地预览**，不对外发布。

## 内容

- `index.html`、`styles.css`、`app.js` — 手写单页 UI
- `data/*.json` — 由 [`web/scripts/snapshot.ts`](../web/scripts/snapshot.ts) 生成：
  - `universe.json` — 股票池
  - `analyst.json` — 分析师汇总
  - `signals.json` — DeepSeek 信号
  - `backtest.json` — 回测曲线与交易
  - `meta.json` — 生成时间戳

## 刷新

```bash
cd pyserver && uv run uvicorn main:app --port 8001 &
cd web && npx tsx scripts/snapshot.ts
```

跳过 LLM 步骤：

```bash
SNAPSHOT_SKIP_SIGNALS=1 SNAPSHOT_SKIP_BACKTEST=1 npx tsx scripts/snapshot.ts
```

## 本地预览

```bash
python3 -m http.server 8765 --directory docs
open http://localhost:8765/
```

GitHub Pages（私有仓库，仅协作者可访问）：

**https://topkyo.github.io/topkyo-ai-infra-dashboard/**

在仓库 Settings → Pages 中确认 source 为 `main` 分支 `/docs` 文件夹。
