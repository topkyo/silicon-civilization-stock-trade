# 完整应用部署（VPS / 云主机）

私有 Dashboard 的**完整交互功能**（实时行情、在线回测、DeepSeek 信号）需在有公网 IP 的服务器上运行 Next.js + Python sidecar。建议配合防火墙与 HTTPS，仅对授权用户开放。

## 前置条件

- VPS 或云主机（Linux，建议 2 vCPU / 2 GB RAM 以上）
- 域名（可选，推荐用于 HTTPS）
- [`TUSHARE_TOKEN`](../pyserver/env.example)（Tushare Pro）
- LLM API key：[`OPENCODE_GO_API_KEY`](../web/env.example.txt) 或 `DEEPSEEK_API_KEY`

## 1. 克隆仓库

```bash
git clone https://github.com/topkyo/topkyo-ai-infra-dashboard.git
cd topkyo-ai-infra-dashboard
```

## 2. 配置环境变量

在项目根目录创建 `.env`（供 `docker compose` 读取）：

```bash
TUSHARE_TOKEN=your-tushare-token
OPENCODE_GO_API_KEY=your-opencode-go-key
OPENCODE_GO_BASE_URL=https://opencode.ai/zen/go/v1
LLM_PROVIDER=opencode-go
LLM_MODEL=deepseek-v4-pro
LLM_MODEL_BACKTEST=deepseek-v4-flash
HYBRID_LLM_TOP_K=20
```

## 3. 启动服务

```bash
docker compose up -d --build
```

- Web UI：<http://服务器IP:3000>
- pyserver：<http://服务器IP:8001/docs>

```bash
docker compose logs -f web pyserver
docker compose down   # 停止
```

## 4. HTTPS（推荐）

用 Caddy 或 Nginx 反向代理到 `127.0.0.1:3000`，并限制访问来源（IP 白名单或 Basic Auth）。

**不要**将 API key 暴露在前端；仅存在于容器环境变量中。

## 5. 本地静态快照

VPS 跑完整版的同时，可在本机运行 `web/scripts/snapshot.ts` 更新 `docs/data/`，用 `python3 -m http.server` 本地预览历史结果。

## 6. 故障排查

| 现象 | 检查 |
|---|---|
| 首页无行情 | `docker compose ps`；`curl http://127.0.0.1:8001/health` |
| 信号/回测失败 | LLM key 是否有效；`docker compose logs web` |
| pyserver 无数据 | `TUSHARE_TOKEN` 是否有效且有积分 |
