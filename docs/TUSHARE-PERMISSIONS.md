# Tushare 权限参考

看盘、信号和回测默认走 Eastmoney / AkShare / BaoStock 免费源。Tushare 默认关闭，只有设置 `MARKET_ENABLE_TUSHARE_SECONDARY=1` 且提供真实 `TUSHARE_TOKEN` 时才作为补缺源调用。

若启用后出现「没有接口(xxx)访问权限」，需要在 [Tushare 积分说明](https://tushare.pro/document/1?doc_id=108) 中确认对应接口权限和频次。

| 接口 | 用途 |
|---|---|
| `daily` | A 股最近日收盘次级源，不是实时价。 |
| `daily_basic` | PE、PB、市值等估值字段补缺。 |
| `pro_bar` / 通用行情 | K 线次级源和回测补缺。 |
| `fina_indicator` | 利润同比，用于 PEG 等特征。 |
| `report_rc` | 卖方一致预期和评级补缺。 |

默认免费路径不需要 Tushare token。批量信号和回测会放大接口调用量，启用次级源前先确认账号权限、积分和限频。
