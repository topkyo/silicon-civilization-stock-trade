# pyserver —— 免费优先市场数据 sidecar

基于 FastAPI 的轻量 sidecar，封装 AkShare、BaoStock 与可选 [Tushare Pro](https://tushare.pro)，只对外暴露 Next.js 网站需要的端点。正式数据源策略是 **免费源优先，Tushare 显式次级源**；次级源命中必须通过 `source`、`warnings`、`field_sources` 可审计。

所有响应都写入 `cache.db`（SQLite），按端点设置分层 TTL：

| 端点 | TTL | 数据源 |
|---|---|---|
| `GET /klines` | 直到下一个 15:30 A 股收盘 | A 股 AkShare `stock_zh_a_hist`/新浪日线优先，BaoStock 日线次级，Tushare `pro_bar` 仅显式开启；港股 `ak.stock_hk_hist` |
| `GET /fundamental` | 30 秒到 24 小时 | AkShare `stock_value_em` 提供 PE/PB/市值/最近收盘，BaoStock `query_growth_data` 补净利同比；Tushare `daily_basic`/`fina_indicator` 仅显式开启 |
| `GET /analyst` | 24 小时 | AkShare 研报/盈利预测与 `stock_value_em` 估值优先，Tushare `report_rc` 仅显式开启 |
| `GET /analysts` | 24 小时 | 批量包装 `GET /analyst`，避免前端逐行请求 |
| `GET /spot` | 30 秒 | A 股 Eastmoney 单股 quote 优先；不可用时返回 AkShare `stock_value_em` 最近日收盘并带非实时 warning；港股 `ak.stock_hk_hist` |

默认缓存文件为 `pyserver/cache.db`；部署时可用 `PYSERVER_CACHE_DB=/path/to/cache.db` 指定持久化路径。
缓存 key 带 `mock/live` namespace，避免离线 mock 与真实数据污染。

## 响应元数据

`/fundamental`、`/analyst`、`/spot` 会返回数据源元信息：

- `source`: 汇总来源，例如 `akshare_primary`、`akshare+baostock`、`akshare+baostock+tushare`。
- `field_sources`: 字段级来源，例如 `pe_ttm: akshare_stock_value_em`、`profit_yoy: baostock_growth`。
- `warnings`: 非硬失败说明，例如免费源缺字段、Tushare 显式次级源关闭、无法计算 implied target、返回的是最近日收盘而不是实时价。

不要把 AkShare `stock_value_em` 或日线 close 当实时价使用；它只说明 Eastmoney 实时 quote 当前不可用时的最近交易日收盘参考，可能有盘后或 T+1 延迟。

## Token

免费源不需要 token。只有开启 Tushare 次级源时，才需要 [Tushare Pro 账号](https://tushare.pro/register) 并把 token 放进 `pyserver/.env`（已 gitignore）：

```
TUSHARE_TOKEN=
STRICT_LIVE_DATA=0
MARKET_ENABLE_TUSHARE_SECONDARY=0
```

启动时通过 `python-dotenv` 自动加载。空 `TUSHARE_TOKEN` 会走免费真实数据源；`TUSHARE_TOKEN=mock` 才进入离线 mock。`STRICT_LIVE_DATA=1` 会禁止 `TUSHARE_TOKEN=mock` 启动，适合真实测试和部署环境。`MARKET_ENABLE_TUSHARE_SECONDARY` 默认关闭；只有确认账号具备 `daily_basic`、`fina_indicator`、`report_rc` 等权限和频次时才设为 `1`，此时必须提供真实 `TUSHARE_TOKEN`。

## 运行

依赖通过 [uv](https://docs.astral.sh/uv/) 管理 —— `pyproject.toml` 为依赖清单，`uv.lock` 锁定精确版本。

```bash
uv sync                                      # 创建 .venv 并安装锁定的依赖
uv run uvicorn main:app --port 8001 --reload
```

新增/升级依赖：

```bash
uv add <pkg>           # 写入 pyproject.toml + uv.lock
uv lock --upgrade      # 整体升级
```

## 为什么用 sidecar？

Tushare 仅有 Python SDK，AkShare 也主要在 Python 生态使用。把它们放进一个独立的 FastAPI 进程，可以让 Next.js 端保持纯 TypeScript，同时通过稳定、强类型、自带缓存的 HTTP 接口消费它。sidecar 还集中处理：

- 符号格式归一化（`688256` ↔ `688256.SH`，`hk00700` ↔ `00700.HK`）。
- 退避重试（3 次指数退避），吸收上游偶发抖动。
- HK 接口的 token-bucket 限速（`pro.hk_daily` 免费档 2 次/分钟）。
- A 股 Eastmoney/AkShare/BaoStock 免费源优先，Tushare 仅在 `MARKET_ENABLE_TUSHARE_SECONDARY=1` 时补缺失字段，并通过来源元数据暴露。
- 名称缓存（`stock_basic` / `hk_basic` 进程内 LRU）。

## 端点速查

```bash
# 健康检查
curl http://localhost:8001/health

# 日 K（前复权）
curl 'http://localhost:8001/klines?symbol=688256&start=20240101'

# 基本面（PE/PB/市值，24h 缓存）
curl 'http://localhost:8001/fundamental?symbol=300476'

# 卖方一致预期（24h 缓存）
curl 'http://localhost:8001/analyst?symbol=300476'

# 批量卖方一致预期，前端股票池表格使用这个接口
curl 'http://localhost:8001/analysts?symbols=300476,601138,688256'

# 最新价/最近收盘（30 秒缓存；source 会说明是否实时）
curl 'http://localhost:8001/spot?symbol=hk00700'
```

## 代码符号规则

所有端点接受同一套符号写法（与 ts_code 自动互转）：

| 市场 | 输入 | 内部 ts_code |
|---|---|---|
| 沪市 A 股 | `sh600519` 或 `600519` | `600519.SH` |
| 深市 A 股 | `sz000858` 或 `000858` | `000858.SZ` |
| 北交所 | `bj430...` 或 `8...` / `4...` | `430xxx.BJ` |
| 港股 | `hk00700` 或 `hk09988` | `00700.HK` |
