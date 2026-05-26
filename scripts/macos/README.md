# macOS 本地系统服务（launchd）

将 **pyserver**（8001）与 **web**（3000）注册为当前用户的 LaunchAgent，在用户登录后自动启动，崩溃后自动重启。

## 安装

```bash
chmod +x scripts/macos/install-launchd.sh scripts/macos/uninstall-launchd.sh
./scripts/macos/install-launchd.sh
```

前提：

- `pyserver/.env` 含 `TUSHARE_TOKEN`
- `web/.env.local` 含 `PYSERVER_URL` 与 LLM 相关变量
- 已执行 `cd pyserver && uv sync`、`cd web && npm install`

Web 以 **生产模式**（`npm run start`）运行；首次安装若缺少 `web/.next` 会自动 `npm run build`。

## 清行情缓存

mock 模式或网络异常后，`cache.db` 可能残留 `Mock-*` 数据：

```bash
./scripts/macos/clear-market-cache.sh
```

pyserver 默认**清除失效代理**；若东财直连失败但 VPN 在 `127.0.0.1:7890` 可用，在 `pyserver/.env` 设置：

```bash
MARKET_HTTP_PROXY=http://127.0.0.1:7890
```

然后 `./scripts/macos/clear-market-cache.sh` 并复测 `./scripts/macos/verify-network.sh`。

Tushare 积分与接口权限见 [`docs/TUSHARE-PERMISSIONS.md`](../../docs/TUSHARE-PERMISSIONS.md)。

## 卸载

```bash
./scripts/macos/uninstall-launchd.sh
```

## 日志与状态

| 路径 | 说明 |
|------|------|
| `~/Library/Logs/topkyo-ai-infra/com.topkyo.ai-infra.pyserver.log` | sidecar 标准输出 |
| `~/Library/Logs/topkyo-ai-infra/com.topkyo.ai-infra.web.log` | Next.js 标准输出 |
| `*.err.log` | 标准错误 |

```bash
launchctl print gui/$(id -u)/com.topkyo.ai-infra.pyserver
launchctl print gui/$(id -u)/com.topkyo.ai-infra.web
curl http://127.0.0.1:8001/health
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3000
```

## 说明

- 使用 **用户级** LaunchAgent（`~/Library/LaunchAgents`），在 macOS 上等同于「当前用户登录后自启」；无需 root。
- 若需未登录也启动，需改用 `/Library/LaunchDaemons` 并以 root 安装（本仓库未默认提供）。
- 更新代码后若改动了前端：在 `web/` 执行 `npm run build`，再 `launchctl kickstart -k gui/$(id -u)/com.topkyo.ai-infra.web`。
