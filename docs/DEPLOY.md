# 完整应用部署

完整交互应用包括 Next.js Web、Python pyserver、LLM key 和市场数据缓存。部署后可使用实时行情、在线信号、回测和股票池刷新。公开展示快照不需要部署服务，见 [docs/README.md](README.md)。

建议部署在 VPS / 云主机，并通过 HTTPS、IP 白名单或 Basic Auth 限制访问。

## 前置条件

- Linux 主机，建议 2 vCPU / 2 GB RAM 以上。
- Docker 和 Docker Compose。
- LLM API key：`OPENCODE_GO_API_KEY` 或 `DEEPSEEK_API_KEY`。
- 市场数据默认可走免费源；Tushare 仅在需要次级补缺时启用。

## 1. 克隆仓库

```bash
git clone https://github.com/topkyo/topkyo-ai-infra-dashboard.git
cd topkyo-ai-infra-dashboard
```

## 2. 配置 `.env`

从根目录示例复制：

```bash
cp .env.example .env
```

最小生产配置：

```bash
LLM_PROVIDER=opencode-go
OPENCODE_GO_API_KEY=your-opencode-go-key
OPENCODE_GO_BASE_URL=https://opencode.ai/zen/go/v1
LLM_MODEL=deepseek-v4-pro
LLM_MODEL_BACKTEST=deepseek-v4-flash

# Docker Compose 默认镜像内 TUSHARE_TOKEN=mock。
# 使用免费真实源时，用这个占位值覆盖 mock；不启用 Tushare 次级源。
TUSHARE_TOKEN=your-tushare-pro-token-here

SIGNALS_LLM_TIMEOUT_MS=900000
SIGNALS_LLM_SCORE_BATCH_SIZE=10
BACKTEST_SIGNAL_CONCURRENCY=8
BACKTEST_LLM_SCORE_BATCH_SIZE=10
BACKTEST_LLM_TIMEOUT_MS=300000
UNIVERSE_REFRESH_LLM_TIMEOUT_MS=900000
```

当前 `docker-compose.yml` 只把 `TUSHARE_TOKEN` 和 `PYSERVER_CACHE_DB` 传给 pyserver。若要在 Docker 中启用 Tushare 次级源，先在 `docker-compose.yml` 的 `pyserver.environment` 增加 `MARKET_ENABLE_TUSHARE_SECONDARY` 和 `STRICT_LIVE_DATA`，再配置：

```bash
TUSHARE_TOKEN=your-real-tushare-token
MARKET_ENABLE_TUSHARE_SECONDARY=1
STRICT_LIVE_DATA=1
```

Tushare 接口权限见 [TUSHARE-PERMISSIONS.md](TUSHARE-PERMISSIONS.md)。

## 3. 启动服务

```bash
docker compose up -d --build
```

访问：

- Web UI：`http://服务器IP:3000`
- pyserver OpenAPI：`http://服务器IP:8001/docs`
- pyserver health：`http://服务器IP:8001/health`

常用命令：

```bash
docker compose ps
docker compose logs -f web pyserver
docker compose down
```

## 4. 反向代理

生产环境建议只暴露 Web，并用 Caddy 或 Nginx 反向代理到 `127.0.0.1:3000`。pyserver 只供 Web 内部访问，除排障外不建议公网暴露。

API key 只放在容器环境变量中，不会写入前端 bundle。

## 5. 静态展示页

完整应用跑通后，可生成静态快照：

```bash
cd web
npx tsx scripts/snapshot.ts
```

提交 `docs/data/` 后由 GitHub Pages 展示。静态页不会实时请求行情或 LLM。

## 6. 排障

| 现象 | 检查 |
|---|---|
| 首页无行情 | `docker compose ps`；`curl http://127.0.0.1:8001/health`；确认 Web 的 `PYSERVER_URL` 指向 `http://pyserver:8001`。 |
| pyserver 返回 mock 数据 | 检查根 `.env` 的 `TUSHARE_TOKEN` 是否仍为 `mock`；免费真实源可使用示例占位值覆盖镜像默认 mock。 |
| 信号不可用 / 超时 | 检查 LLM key、`LLM_MODEL`、`SIGNALS_LLM_SCORE_BATCH_SIZE`、`SIGNALS_LLM_TIMEOUT_MS` 和 `docker compose logs web`。 |
| 回测失败 / 超时 | 缩短日期范围；检查 `LLM_MODEL_BACKTEST`、`BACKTEST_LLM_TIMEOUT_MS`、`BACKTEST_LLM_SCORE_BATCH_SIZE`、`BACKTEST_SIGNAL_CONCURRENCY`。 |
| 股票池刷新超时 | 增大 `UNIVERSE_REFRESH_LLM_TIMEOUT_MS`，确认模型支持长上下文和长时间 JSON 输出。 |
| Tushare 权限错误 | 关闭 `MARKET_ENABLE_TUSHARE_SECONDARY` 或确认 token 权限、积分、频次。 |
| 静态页数据旧 | 重新运行 `web/scripts/snapshot.ts` 并提交 `docs/data/`。 |
