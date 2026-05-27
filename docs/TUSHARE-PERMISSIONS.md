# Tushare 权限（优先级 2）

看盘、信号和回测已优先走 **AkShare/Eastmoney + BaoStock**。Tushare 默认关闭，只有设置 `MARKET_ENABLE_TUSHARE_SECONDARY=1` 且提供真实 `TUSHARE_TOKEN` 时才作为补缺源调用。

若启用 Tushare 次级源后接口返回「没有接口(xxx)访问权限」，需在 [Tushare 积分说明](https://tushare.pro/document/1?doc_id=108) 攒积分后开通：

| 接口 | 用途 |
|------|------|
| `daily` | A 股最近日收盘次级源（免费源都失败时，不是实时价） |
| `daily_basic` | PE/PB/市值次级源 |
| `pro_bar` / 通用行情 | K 线次级源、回测 |
| `fina_indicator` | 利润同比（PEG） |
| `report_rc` | 卖方一致预期次级源 |

**默认免费路径**：不需要 Tushare token，也不需要充值。

**启用 Tushare 次级源**：建议先确认上表相关权限和频次，避免信号/回测批量加载时触发限频。
