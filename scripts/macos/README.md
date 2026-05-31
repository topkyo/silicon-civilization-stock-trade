# macOS 本地系统服务

这些脚本把 pyserver 和 Web 注册为当前用户的 LaunchAgent。用户登录后自动启动，进程退出后由 launchd 拉起。

| 服务 | 端口 | 模式 |
|---|---:|---|
| `com.topkyo.ai-infra.pyserver` | `8001` | `uvicorn main:app` |
| `com.topkyo.ai-infra.web` | `3000` | `npm run start` |

## 安装

```bash
chmod +x scripts/macos/install-launchd.sh scripts/macos/uninstall-launchd.sh
./scripts/macos/install-launchd.sh
```

前置条件：

- 仓库根目录 `nvm use`，Node 版本读取 [../../.nvmrc](../../.nvmrc)。
- `pyserver/.env` 已从 `pyserver/env.example` 创建。
- `web/.env.local` 已从 `web/env.example.txt` 创建，并配置 LLM key 与 `PYSERVER_URL`。
- 已执行 `cd pyserver && uv sync`、`cd web && npm install`。

Web 以生产模式运行。首次安装如果缺少 `web/.next/BUILD_ID`，安装脚本会自动执行 `npm run build`。

## 卸载

```bash
./scripts/macos/uninstall-launchd.sh
```

## 日志与状态

| 路径 | 说明 |
|---|---|
| `~/Library/Logs/topkyo-ai-infra/com.topkyo.ai-infra.pyserver.log` | pyserver 标准输出 |
| `~/Library/Logs/topkyo-ai-infra/com.topkyo.ai-infra.pyserver.err.log` | pyserver 标准错误 |
| `~/Library/Logs/topkyo-ai-infra/com.topkyo.ai-infra.web.log` | Web 标准输出 |
| `~/Library/Logs/topkyo-ai-infra/com.topkyo.ai-infra.web.err.log` | Web 标准错误 |

```bash
launchctl print gui/$(id -u)/com.topkyo.ai-infra.pyserver
launchctl print gui/$(id -u)/com.topkyo.ai-infra.web
curl http://127.0.0.1:8001/health
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3000
```

重启 Web：

```bash
launchctl kickstart -k gui/$(id -u)/com.topkyo.ai-infra.web
```

## 缓存与网络

清行情缓存：

```bash
./scripts/macos/clear-market-cache.sh
```

pyserver 启动时会剥离 shell 中的 `HTTP_PROXY` / `HTTPS_PROXY`，Eastmoney `push2` 默认直连。通常不要在 `pyserver/.env` 设置 `MARKET_HTTP_PROXY`。

只有在直连失败、且经本地代理的国内节点反而可用时，才显式设置：

```bash
MARKET_HTTP_PROXY=http://127.0.0.1:7890
```

诊断网络：

```bash
./scripts/macos/verify-network.sh
```

修复网络或代理规则后，先清缓存再复测。

## Node 原生模块

`better-sqlite3` 必须与 launchd 使用的 Node ABI 一致。升级 Node 或重新安装依赖后，如出现 `ERR_DLOPEN_FAILED`：

```bash
nvm use
./scripts/rebuild-native-modules.sh
launchctl kickstart -k gui/$(id -u)/com.topkyo.ai-infra.web
```

也可以重新运行安装脚本，它会按 `.nvmrc` 解析 Node、重建原生模块并重启服务。

## 说明

- 当前脚本使用用户级 LaunchAgent，写入 `~/Library/LaunchAgents`，不需要 root。
- 若需要未登录也启动，需要改用 `/Library/LaunchDaemons`，本仓库不默认提供。
- LLM、缓存和运行变量详见 [../../docs/OPERATIONS.md](../../docs/OPERATIONS.md)。
