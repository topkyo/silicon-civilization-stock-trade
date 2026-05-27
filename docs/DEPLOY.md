# 完整应用部署

私有 Dashboard 的完整交互功能包括实时行情、在线回测、LLM 信号生成和股票池刷新，需要同时运行 Next.js Web 应用与 Python pyserver。建议部署在 VPS / 云主机上，并通过 HTTPS、IP 白名单或 Basic Auth 限制访问。

## 前置条件

- VPS 或云主机（Linux，建议 2 vCPU / 2 GB RAM 以上）
- 域名（可选，推荐用于 HTTPS）
- 市场数据默认使用 AkShare/Eastmoney + BaoStock 免费源；[`TUSHARE_TOKEN`](../pyserver/env.example) 仅在启用 Tushare 次级源时需要
- LLM API key：[`OPENCODE_GO_API_KEY`](../web/env.example.txt) 或 `DEEPSEEK_API_KEY`

## 1. 克隆仓库

```bash
git clone https://github.com/topkyo/topkyo-ai-infra-dashboard.git
cd topkyo-ai-infra-dashboard
```

## 2. 配置环境变量

在项目根目录创建 `.env`（供 `docker compose` 读取）：

```bash
OPENCODE_GO_API_KEY=your-opencode-go-key
OPENCODE_GO_BASE_URL=https://opencode.ai/zen/go/v1
LLM_PROVIDER=opencode-go
LLM_MODEL=deepseek-v4-pro
LLM_MODEL_BACKTEST=deepseek-v4-flash
PYSERVER_URL=http://pyserver:8001

# Live signals: one LLM call for the full universe (~15m for pro on OpenCode Go).
SIGNALS_LLM_TIMEOUT_MS=900000
SIGNALS_LOAD_CONCURRENCY=3
SIGNALS_PYSERVER_TIMEOUT_MS=120000

# Backtest: parallel rebalance days + serial LLM batches per day.
BACKTEST_SIGNAL_CONCURRENCY=8
BACKTEST_LLM_SCORE_BATCH_SIZE=10
BACKTEST_LLM_TIMEOUT_MS=300000
BACKTEST_LLM_MAX_ATTEMPTS=2
BACKTEST_LOAD_CONCURRENCY=10
BACKTEST_PYSERVER_TIMEOUT_MS=60000
```

可选项（完整列表见 [web/env.example.txt](../web/env.example.txt)）：

```bash
PYSERVER_CACHE_DB=/app/data/cache.db
TUSHARE_TOKEN=your-tushare-token
MARKET_ENABLE_TUSHARE_SECONDARY=1
SIGNALS_FUNDAMENTAL_TIMEOUT_MS=8000
SIGNALS_LLM_MAX_ATTEMPTS=1
LLM_SCORE_BATCH_SIZE=10
```

`docker-compose.yml` 仅透传部分变量；若在 compose 中跑信号/回测，请将上表变量加入 `web.environment`，或与根目录 `.env` 一并传入。

## 3. 启动服务

```bash
docker compose up -d --build
```

- Web UI：`http://服务器IP:3000`
- pyserver：`http://服务器IP:8001/docs`

```bash
docker compose logs -f web pyserver
docker compose down   # 停止
```

## 4. HTTPS（推荐）

用 Caddy 或 Nginx 反向代理到 `127.0.0.1:3000`，并限制访问来源（IP 白名单或 Basic Auth）。

**不要**将 API key 暴露在前端；仅存在于容器环境变量中。

## 5. 静态展示页

`docs/` 是公开展示快照，不需要部署服务，也不会实时请求行情或 LLM。完整应用跑通后，可运行 `web/scripts/snapshot.ts` 更新 `docs/data/`，再通过 GitHub Pages 发布。

## 6. 故障排查

| 现象 | 检查 |
|---|---|
| 首页无行情 | `docker compose ps`；`curl http://127.0.0.1:8001/health`；确认 `PYSERVER_URL` 指向 pyserver |
| 信号不可用 / 超时 | `LLM_MODEL`、`SIGNALS_LLM_TIMEOUT_MS`（整池单次，pro 建议 ≥900000）；`docker compose logs web` |
| 回测失败 / 超时 | `LLM_MODEL_BACKTEST`、`BACKTEST_LLM_TIMEOUT_MS`、`BACKTEST_LLM_SCORE_BATCH_SIZE`、`BACKTEST_SIGNAL_CONCURRENCY`；日志中 `[backtest] fetched` |
| 其他 LLM 失败 | LLM key、provider、`docker compose logs web` |
| pyserver 无数据 | `curl http://127.0.0.1:8001/health`；AkShare/BaoStock 网络是否可达；如启用 Tushare 次级源，再检查 `TUSHARE_TOKEN` 权限和积分；`docker compose logs pyserver` |
| 静态页数据旧 | 是否重新运行 `web/scripts/snapshot.ts` 并提交 `docs/data/` |
