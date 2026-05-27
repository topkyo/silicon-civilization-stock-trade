# DESIGN.md

## Visual Theme

topkyo AI 基建研究台采用浅色、克制、数据优先的研究工具风格。整体接近 Apple 式的清爽界面：大量留白、低饱和中性色、细边框、明确层级、少量绿色/蓝色用于状态和行动点。

界面应像一张可反复阅读的研究工作台，而不是交易终端或营销落地页。

## Color Palette

| Token | Hex | Role |
|---|---:|---|
| `--bg` | `#f5f7fa` | 页面背景 |
| `--fg` | `#172033` | 主文字 |
| `--muted` | `#667085` | 次级文字 |
| `--subtle` | `#eef2f7` | 分隔/弱背景 |
| `--card` | `#ffffff` | 卡片和面板 |
| `--card-2` | `#f8fafc` | 表头/工具条 |
| `--border` | `#d9e2ec` | 边框 |
| `--field` | `#ffffff` | 输入背景 |
| `--accent` | `#0f8f5f` | 正向/主行动 |
| `--accent-weak` | `#e7f6ef` | 正向弱背景 |
| `--info` | `#2563eb` | 信息/链接 |
| `--warn` | `#b7791f` | 注意 |
| `--danger` | `#d92d20` | 负向/错误 |

避免大面积深色、霓虹、厚重渐变、装饰性光斑。颜色用于信息区分，不用于制造噪音。

## Typography

- 字体：系统无衬线，中文优先 `PingFang SC` / `Microsoft YaHei`。
- 标题：稳重、清晰，避免超大字号。
- 表格和数字：使用 tabular numeric，代码/股票代码使用 monospace。
- 字距保持 0，不使用负字距。

| Element | Size | Weight | Notes |
|---|---:|---:|---|
| H1 | 32px | 700 | 首页和页面标题 |
| H2 | 20px | 650 | 分区标题 |
| Body | 14px | 400 | 主要说明 |
| Table | 13px | 400 | 高密度数据 |
| Label | 12px | 600 | 标签/KPI |

## Components

- Buttons: 6px radius, compact height, primary 用绿色，secondary 用白底细边框。
- Cards: 8px radius, 白底、细边框、轻阴影，只用于独立信息块。
- Tables: 表头 sticky，行高紧凑，数字右对齐。
- Badges: 小尺寸 pill，仅承载状态，如 `buy`、`sell`、`llm-live`、`snapshot`。
- Toolbars: 不嵌套卡片，作为浅色控制条。
- Progress: 细条、低对比背景、绿色填充。

## Layout

- 最大内容宽度 1280px，桌面左右留白 24px，移动端 16px。
- 首页第一屏直接呈现研究台概览和 KPI，不做营销 hero。
- 信息结构优先：总览 KPI → 操作/筛选 → 数据表。
- 表格容器允许横向滚动，移动端不强行压缩列文字。

## Do / Don't

Do:
- 展示数据来源、缓存、snapshot、unscorable 等状态。
- 用短文案解释系统边界。
- 保持面板之间有足够呼吸感。
- 让 GitHub README 和静态 docs 页面看起来像同一个项目。

Don't:
- 不使用暗黑交易终端风格。
- 不使用大面积渐变、光斑、玻璃拟态。
- 不把一致预期包装成确定预测；使用“隐含目标/一致预期参考”。
- 不在 UI 中加入无功能的说明卡片或装饰卡片。

## Responsive Behavior

- 860px 以下：页头和工具条纵向堆叠，KPI 单列，表格横向滚动。
- 按钮和输入保持可点击高度，不让文字溢出。
- 图表区域保持固定高度，避免加载后布局跳动。

## Agent Prompt Guide

When extending UI:
- Use the light research dashboard palette above.
- Prefer compact, readable data surfaces.
- Keep UI controls functional and predictable.
- Preserve current domain language: AI 基建、股票池、LLM 信号、回测、数据来源。
