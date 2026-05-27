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
LLM_SCORE_BATCH_SIZE=40
```

可选项：

```bash
PYSERVER_CACHE_DB=/app/data/cache.db
TUSHARE_TOKEN=your-tushare-token
MARKET_ENABLE_TUSHARE_SECONDARY=1
SIGNALS_LOAD_CONCURRENCY=6
SIGNALS_LIVE_TIMEOUT_MS=25000
```

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
| 信号/回测失败 | LLM key、模型名、`docker compose logs web` |
| pyserver 无数据 | `curl http://127.0.0.1:8001/health`；AkShare/BaoStock 网络是否可达；如启用 Tushare 次级源，再检查 `TUSHARE_TOKEN` 权限和积分；`docker compose logs pyserver` |
| 静态页数据旧 | 是否重新运行 `web/scripts/snapshot.ts` 并提交 `docs/data/` |
