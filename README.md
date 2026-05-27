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
| LLM 策略信号 | 由 LLM 统一决定 buy / hold / sell；规则代码只提供特征，不做买卖兜底。 |
| 严格回测 | 按调仓周期严格重配，支持基准指数、单边费率、信号缓存和结果存档。 |
| 多层缓存 | 浏览器、Python sidecar、LLM 响应、回测结果分层缓存。 |
| 静态快照 | 可生成 `docs/data/*.json`，用于 GitHub Pages 展示。 |

## 项目结构

```text
web/       Next.js 15 App Router、页面、API routes、LLM 策略、回测和测试
pyserver/  FastAPI sidecar，封装 Tushare Pro + AkShare，并做 SQLite 缓存
docs/      GitHub Pages 静态快照页面和数据
scripts/   本地运维脚本
```

品牌文案集中在 [web/lib/site.ts](web/lib/site.ts)，视觉规范见 [DESIGN.md](DESIGN.md)。

## 架构

```mermaid
flowchart LR
  web["Next.js App<br/>股票池 / 信号 / 回测"]
  py["FastAPI sidecar<br/>Tushare Pro + AkShare"]
  cache["SQLite / localStorage<br/>行情 + LLM + 回测缓存"]
  docs["docs/ 静态快照<br/>GitHub Pages"]

  web -- HTTP --> py
  web --> cache
  py --> cache
  web -- snapshot.ts --> docs
```

## 数据与策略边界

- A 股行情：优先 AkShare 东方财富接口，必要时回退新浪/Tushare。
- 基本面与分析师数据：Tushare/AkShare 组合获取，部分字段可能缺失。
- 隐含目标口径：页面中的“隐含目标/一致预期参考”不是确定预测。
- 策略决策：LLM 是唯一 buy / hold / sell 来源；规则特征只进入提示词。
- 输出校验：未知代码、缺失代码、重复代码、非法 action 会被拒绝。
- 数据质量：K 线不足的标的会标记为 `unscorable`，不伪装成持有建议。

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
# 设置 TUSHARE_TOKEN；也可用 TUSHARE_TOKEN=mock 跑离线示例
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
