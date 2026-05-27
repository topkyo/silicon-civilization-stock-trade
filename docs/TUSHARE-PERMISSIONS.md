# Tushare 权限（优先级 2）

看盘已优先走 **AkShare**（K 线、现价兜底）。Tushare 仅在 AkShare 失败或需要研报/利润同比等字段时调用。

若接口返回「没有接口(xxx)访问权限」，需在 [Tushare 积分说明](https://tushare.pro/document/1?doc_id=108) 攒积分后开通：

| 接口 | 用途 |
|------|------|
| `daily` | A 股现价兜底（AkShare 都失败时） |
| `daily_basic` | PE/PB/市值兜底 |
| `pro_bar` / 通用行情 | K 线兜底、回测 |
| `fina_indicator` | 利润同比（PEG） |
| `report_rc` | 卖方一致预期兜底 |

**只看盘、且 AkShare 正常时**：可不充值，保持免费 token 即可。

**跑完整回测 / 分析师一致预期**：建议开通上表相关权限。
