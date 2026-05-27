# topkyo · AI 基建研究台

个人 AI 基建主题 A 股研究仪表盘。项目聚焦算力、互连、散热、电力、IDC、存储、半导体设备与材料等供给侧方向，用于维护股票池、查看行情和一致预期参考、生成 LLM 策略信号，并做滚动回测。

> 个人研究工具，不构成任何投资建议。
> 基于 [madeye/silicon-civilization-stock-trade](https://github.com/madeye/silicon-civilization-stock-trade) fork 后定制。

静态展示页：<https://topkyo.github.io/topkyo-ai-infra-dashboard/>

## 核心能力

| 能力 | 说明 |
|---|---|
| AI 基建股票池 | 按子主题维护 A 股标的，数据在 [web/data/universe.json](web/data/universe.json)。 |
| 行情与一致预期 | FastAPI sidecar 拉取现价、估值、分析师评级和隐含目标参考。 |
| LLM 策略信号 | 全股票池由 LLM 决定 buy / hold / sell；LLM 或关键数据失败时显式不可用，不生成伪信号。 |
| 严格回测 | 按调仓周期严格重配，支持基准指数、单边费率、信号缓存和结果存档。 |
| 多层缓存 | 浏览器、Python sidecar、LLM 响应、回测结果分层缓存。 |
| 静态快照 | 可生成 `docs/data/*.json`，用于 GitHub Pages 展示。 |

## 项目结构

```text
web/       Next.js 15 App Router、页面、API routes、LLM 策略、回测和测试
pyserver/  FastAPI sidecar，AkShare/Eastmoney + BaoStock 免费源优先，Tushare 可选次级源，并做 SQLite 缓存
docs/      GitHub Pages 静态快照页面和数据
scripts/   本地运维脚本
```

品牌文案集中在 [web/lib/site.ts](web/lib/site.ts)，视觉规范见 [DESIGN.md](DESIGN.md)。

## 架构

```mermaid
flowchart LR
  web["Next.js App<br/>股票池 / 信号 / 回测"]
  py["FastAPI sidecar<br/>AkShare + BaoStock first<br/>optional Tushare secondary"]
  cache["SQLite / localStorage<br/>行情 + LLM + 回测缓存"]
  docs["docs/ 静态快照<br/>GitHub Pages"]

  web -- HTTP --> py
  web --> cache
  py --> cache
  web -- snapshot.ts --> docs
```

## 数据与策略边界

- A 股数据源：AkShare/Eastmoney 与 BaoStock 免费源优先，Tushare 只作为显式次级源；返回值通过 `source`、`warnings`、`field_sources` 标明来源。
- 现价口径：Eastmoney 可用时显示实时/准实时价；不可用时返回 AkShare `stock_value_em` 或日线最近收盘，不伪装成实时价。
- 基本面与分析师数据：AkShare `stock_value_em`、研报/盈利预测和 BaoStock 成长字段优先；Tushare 只在 `MARKET_ENABLE_TUSHARE_SECONDARY=1` 时补充缺字段，部分字段可能缺失。
- 隐含目标口径：页面中的“隐含目标/一致预期参考”不是确定预测。
- 策略决策：规则特征只负责给 LLM 提供可审计特征，buy / hold / sell 必须来自 LLM 输出。
- 输出校验：未知代码、缺失代码、重复代码、非法 action 会被拒绝。
- 数据质量：K 线不足、benchmark 缺失、LLM 超时或异常等硬依赖失败会显式报错，不生成保守 hold。
- 实时信号：`/signals` 页面由客户端触发 `/api/signals` NDJSON 流式任务，先显示进度；LLM 成功时展示 live/cache 结果，失败时显示“信号不可用”。
- 股票池刷新：DeepSeek 提议失败时返回 error 且不写股票池文件；正常返回空变更是合法结果，但只有实际新增、移除或改类时才更新 `updated_at`。真实新增仍会逐只通过 pyserver 基本面接口验证，验证失败只拒绝该新增项并列明原因。

## LLM 同步任务调优

OpenCode Go / DeepSeek 对大股票池的同步 JSON 生成延迟较高。默认信号和回测都要求 LLM 覆盖请求内全部标的；如果任一批次失败、缺失、重复或输出非法 action，任务会失败并在 UI/API 显式暴露原因。

| 变量 | 默认 | 说明 |
|---|---:|---|
| `SIGNALS_LLM_TIMEOUT_MS` | `90000` | 实时信号单次 LLM 请求超时。 |
| `BACKTEST_LLM_TIMEOUT_MS` | `90000` | 回测单次 LLM 请求超时。 |
| `UNIVERSE_REFRESH_VALIDATE_TIMEOUT_MS` | `20000` | 股票池刷新时单个新增标的的 pyserver 校验超时。 |

底层 `scoreSymbols` 保持严格模式：LLM 不可用、空响应、输出不完整或输出非法时抛错；非 bypass 请求会做有限技术重试，但不会合成交易结论。

## 缓存

| 层 | 位置 | 用途 | TTL |
|---|---|---|---|
| 浏览器现价缓存 | `localStorage` | 首页现价与涨跌幅 | 15 分钟 |
| 浏览器分析师缓存 | `localStorage` | 首页隐含目标与评级 | 24 小时 |
| Python 市场数据缓存 | `pyserver/cache.db` | K 线、基本面、分析师 | 分层 TTL |
| LLM 回包缓存 | `web/.cache/web.db` | prompt + model 哈希 | 12 小时 |
| 回测结果存档 | `web/.cache/web.db` | 历史回测结果 | 长期保留 |

## 本地运行

### 1. 启动 Python sidecar

```bash
cd pyserver
cp env.example .env
# 免费源无需 Tushare token；如需 Tushare 补缺，再设置 TUSHARE_TOKEN 和 MARKET_ENABLE_TUSHARE_SECONDARY=1
uv sync
uv run uvicorn main:app --port 8001 --reload
```

### 2. 启动 Web

```bash
cd web
npm install
cp env.example.txt .env.local
# 配置 OPENCODE_GO_API_KEY 或 DEEPSEEK_API_KEY
npm run dev
```

打开 <http://localhost:3000>。

## 常用命令

| 目的 | 命令 |
|---|---|
| 单元测试 | `cd web && npm test` |
| 类型检查 | `cd web && ./node_modules/.bin/tsc --noEmit` |
| 生产构建 | `cd web && npm run build` |
| 刷新股票池 | `cd web && npx tsx scripts/refresh-universe.ts` |
| 生成静态快照 | `cd web && npx tsx scripts/snapshot.ts` |
| 本地预览 docs | `python3 -m http.server 8765 --directory docs` |

不要在同一工作区同时运行 `npm run dev` 和 `npm run build`。

## 部署

完整交互功能需要同时运行 Web 和 pyserver。Docker Compose 部署见 [docs/DEPLOY.md](docs/DEPLOY.md)。

静态展示页由 [web/scripts/snapshot.ts](web/scripts/snapshot.ts) 生成数据后发布到 `docs/`。

## 安全

- 不提交 `.env`、`.env.local`、`cache.db`、API key。
- `TUSHARE_TOKEN` 放在 `pyserver/.env` 或部署环境变量。
- LLM key 放在 `web/.env.local` 或部署环境变量。
- 快照数据包含策略输出，只能作为研究记录。
