# 完整应用部署（VPS / 云主机）

GitHub Pages 只能托管 [`docs/`](./) 下的静态快照。若要对外提供**实时行情、在线回测、DeepSeek 信号**等完整功能，需要在有公网 IP 的服务器上运行 Next.js + Python sidecar。

## 前置条件

- VPS 或云主机（Linux，建议 2 vCPU / 2 GB RAM 以上）
- 已注册的域名（可选，但推荐用于 HTTPS）
- [`TUSHARE_TOKEN`](../pyserver/env.example)（Tushare Pro）
- LLM API key：[`OPENCODE_GO_API_KEY`](../web/env.example.txt) 或 `DEEPSEEK_API_KEY`

## 1. 克隆仓库

```bash
git clone https://github.com/topkyo/silicon-civilization-stock-trade.git
cd silicon-civilization-stock-trade
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
# 或使用 DeepSeek 直连：
# LLM_PROVIDER=deepseek
# DEEPSEEK_API_KEY=sk-...
# DEEPSEEK_BASE_URL=https://api.deepseek.com
HYBRID_LLM_TOP_K=20
```

`docker-compose.yml` 会将 `PYSERVER_URL=http://pyserver:8001` 注入 web 容器，无需手动设置。

## 3. 启动服务

```bash
docker compose up -d --build
```

- Web UI：<http://服务器IP:3000>
- pyserver 健康检查：<http://服务器IP:8001/docs>

查看日志：

```bash
docker compose logs -f web pyserver
```

停止：

```bash
docker compose down
```

## 4. HTTPS 与域名（推荐）

在 VPS 上安装 [Caddy](https://caddyserver.com/) 或 Nginx 作为反向代理，将域名指向 `127.0.0.1:3000`。

Caddy 示例 `Caddyfile`：

```text
your-domain.example.com {
  reverse_proxy 127.0.0.1:3000
}
```

**不要**将 `TUSHARE_TOKEN` 或 LLM key 暴露在前端；它们仅存在于容器环境变量中。

## 5. 与 GitHub Pages 静态站并行

| 站点 | 地址 | 用途 |
|---|---|---|
| GitHub Pages | https://topkyo.github.io/silicon-civilization-stock-trade/ | 公开只读快照 |
| VPS 完整版 | 你的域名或 IP:3000 | 实时交互 |

定期在本地或 CI 运行 `web/scripts/snapshot.ts` 更新 `docs/data/`，push 后 GitHub Pages 自动刷新静态展示。

## 6. 故障排查

| 现象 | 检查 |
|---|---|
| 首页无行情 | `docker compose ps` 确认 pyserver 运行；`curl http://127.0.0.1:8001/health` |
| 信号/回测失败 | 确认 LLM key 有效；查看 `docker compose logs web` |
| pyserver 数据为空 | 确认 `TUSHARE_TOKEN` 有效且有积分 |
| 构建失败 | 确保 Docker 版本支持 Compose V2；磁盘空间充足 |
