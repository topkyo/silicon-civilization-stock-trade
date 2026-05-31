# pyserver 市场数据 sidecar

`pyserver` 是 FastAPI sidecar，封装 Eastmoney、AkShare、BaoStock 与可选 Tushare Pro，只向 Next.js Web 提供项目需要的市场数据端点。

数据策略：免费源优先，Tushare 显式次级源。次级源命中和字段缺失必须通过 `source`、`warnings`、`field_sources` 可审计。

## 端点

| 端点 | TTL | 数据源与语义 |
|---|---:|---|
| `GET /health` | 无 | 健康检查，返回 mock/live 和 Tushare 次级源状态。 |
| `GET /klines` | 至下个 A 股 15:30 收盘 | A 股 AkShare `stock_zh_a_hist` / 新浪日线优先，BaoStock 日线次级，Tushare `pro_bar` 仅显式开启；港股 `ak.stock_hk_hist`。 |
| `GET /fundamental` | 30 秒到 24 小时 | AkShare `stock_value_em` 提供 PE/PB/市值/最近收盘，BaoStock 补利润同比，Tushare 仅补缺。 |
| `GET /analyst` | 24 小时 | AkShare 研报/盈利预测与估值优先，Tushare `report_rc` 仅补缺。 |
| `GET /analysts` | 24 小时 | 批量包装 `/analyst`，供首页表格使用。 |
| `GET /spot` | 30 秒 | A 股 Eastmoney push2 单股 quote 优先，新浪实时次级；仍失败则返回最近日收盘并带非实时 warning。 |
| `GET /benchmark/klines` | 至下个 A 股 15:30 收盘 | 回测基准指数 K 线。 |
| `GET /benchmarks` | 无 | 可用基准指数列表。 |

默认缓存文件为 `pyserver/cache.db`，部署可用 `PYSERVER_CACHE_DB=/path/to/cache.db` 指定持久化路径。缓存 key 带 `mock/live` namespace，避免离线 demo 与真实数据互相污染。

## 响应元数据

`/fundamental`、`/analyst`、`/spot` 会返回来源元信息：

- `source`：汇总来源，例如 `akshare+baostock`、`akshare+baostock+tushare`、`mock`。
- `field_sources`：字段级来源，例如 `current_price: sina_hq_sinajs`、`pe_ttm: akshare_stock_value_em`、`profit_yoy: baostock_growth`。
- `warnings`：非硬失败说明，例如免费源缺字段、Tushare 次级源关闭、无法计算 implied target、返回的是最近日收盘而不是实时价。

不要把 AkShare `stock_value_em` 或日线 close 当实时价使用。它只表示实时 quote 当前不可用时的最近交易日收盘参考，可能有盘后或 T+1 延迟。

## 环境变量

复制示例：

```bash
cp env.example .env
```

| 变量 | 默认 | 说明 |
|---|---|---|
| `TUSHARE_TOKEN` | 空 | 空值走免费真实数据源；`mock` 进入离线 demo；真实 token 仅在需要 Tushare 时填写。 |
| `STRICT_LIVE_DATA` | `0` | 设为 `1` 时禁止 `TUSHARE_TOKEN=mock` 启动，适合真实测试和部署。 |
| `MARKET_ENABLE_TUSHARE_SECONDARY` | `0` | 设为 `1` 后才调用 Tushare 补缺，且必须提供真实 token。 |
| `PYSERVER_CACHE_DB` | `pyserver/cache.db` | SQLite 缓存路径。 |
| `MARKET_HTTP_PROXY` | 空 | 仅在直连 Eastmoney 失败且代理国内节点可用时显式设置。 |

默认免费路径不需要 Tushare token。启用次级源前先确认权限和限频，见 [../docs/TUSHARE-PERMISSIONS.md](../docs/TUSHARE-PERMISSIONS.md)。

## 运行

依赖通过 [uv](https://docs.astral.sh/uv/) 管理：

```bash
uv sync
uv run uvicorn main:app --port 8001 --reload
```

新增或升级依赖：

```bash
uv add <pkg>
uv lock --upgrade
```

## 请求示例

```bash
curl http://localhost:8001/health
curl 'http://localhost:8001/klines?symbol=688256&start=20240101'
curl 'http://localhost:8001/fundamental?symbol=300476'
curl 'http://localhost:8001/analyst?symbol=300476'
curl 'http://localhost:8001/analysts?symbols=300476,601138,688256'
curl 'http://localhost:8001/spot?symbol=hk00700'
```

## 符号规则

所有端点接受同一套输入，并在内部转换为 `ts_code`：

| 市场 | 输入 | 内部格式 |
|---|---|---|
| 沪市 A 股 | `sh600519` 或 `600519` | `600519.SH` |
| 深市 A 股 | `sz000858` 或 `000858` | `000858.SZ` |
| 北交所 | `bj430...` 或 `8...` / `4...` | `430xxx.BJ` |
| 港股 | `hk00700` 或 `hk09988` | `00700.HK` |

## 设计原因

AkShare、BaoStock 和 Tushare 主要在 Python 生态使用。把市场数据能力集中在 FastAPI sidecar 中，可以让 Next.js 保持纯 TypeScript，同时统一处理：

- 股票代码归一化。
- 上游请求退避重试。
- 市场数据 SQLite 缓存。
- Tushare 次级源权限和限频。
- 字段来源、非实时价格和缺字段 warning。
