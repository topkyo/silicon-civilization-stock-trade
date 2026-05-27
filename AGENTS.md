# Repository Guidelines

## Project Structure & Module Organization

This repository is **topkyo**'s **AI infrastructure research dashboard** for Chinese A-share thematic stock analysis (compute, interconnect, cooling, power, IDC, storage, semiconductors).

- `web/`: Next.js 15 App Router frontend, API routes, TypeScript backtests, DeepSeek integration, SQLite cache, and tests.
- `web/app/`: UI pages and route handlers. Key pages include `page.tsx`, `signals/page.tsx`, and `backtest/page.tsx`.
- `web/lib/`: shared domain logic such as `universe.ts`, `pyserver.ts`, `deepseek.ts`, `backtest.ts`, and `cache.ts`.
- `web/test/`: Node test-runner TypeScript tests named `*.test.ts`.
- `web/data/universe.json`: editable stock universe data.
- `pyserver/`: FastAPI sidecar for Tushare Pro access and SQLite market-data caching.

## Build, Test, and Development Commands

- `cd pyserver && uv sync`: install locked Python dependencies.
- `cd pyserver && uv run uvicorn main:app --port 8001 --reload`: run the Tushare sidecar locally.
- `cd web && npm install`: install frontend dependencies.
- `cd web && npm run dev`: start the Next.js dev server at `http://localhost:3000`.
- `cd web && npm test`: run TypeScript unit tests via `node --test --import tsx`.
- `cd web && ./node_modules/.bin/tsc --noEmit`: type-check the frontend.
- `cd web && npm run build`: create a production Next.js build.

## Coding Style & Naming Conventions

Use TypeScript for frontend and shared web logic. Prefer small helpers in `web/lib/` and keep route handlers thin. Follow existing 2-space indentation in TS/TSX files, `camelCase` for variables/functions, and `PascalCase` for React components. Keep Python sidecar code typed where practical with Pydantic models for HTTP contracts. Do not commit generated caches such as `cache.db`, `.env`, `.env.local`, or dependency directories.

## Testing Guidelines

Frontend tests use Node’s built-in test runner. Place tests in `web/test/` with names like `backtest.test.ts` and cover regression-prone logic in `web/lib/`, especially caching, concurrency, universe refresh, and backtest behavior. Run `npm test` and `tsc --noEmit` before submitting changes that touch the web app.

## Commit & Pull Request Guidelines

Recent history uses concise imperative commit subjects, for example `Replace akshare with Tushare Pro` and `Fix backtest 500 + expand test coverage 1→18`. Keep commits focused and avoid mixing web, sidecar, and data-only changes unless they are part of one feature. Pull requests should include a behavior summary, test commands run, linked issue if available, screenshots for UI changes, and required environment variables.

## Security & Configuration Tips

Copy `pyserver/env.example` to `pyserver/.env` and set `TUSHARE_TOKEN`. Copy `web/env.example.txt` to `web/.env.local` and set `DEEPSEEK_API_KEY`, `DEEPSEEK_BASE_URL`, and `PYSERVER_URL` as needed. Keep API keys local only.

## 严肃看盘数据完整性规则

- 禁止业务兜底：LLM、API 或关键数据失败时，不得生成 `buy` / `hold` / `sell` 交易结论，不得存回测结果，不得写股票池“无变更成功”。
- 禁止静默降级：任何降级都必须在 API/UI 中显式暴露为 `error`、`unavailable` 或 `warning`，并保留可审计原因。
- 允许技术重试、缓存命中、可审计次级数据源；但这些机制不能合成业务结论，也不能把失败伪装成成功。
- 股票池刷新只有在真实新增、移除或改类时才更新 `updated_at`；LLM 正常返回空 proposal 可以成功返回，但不得改写文件。
- 新增 fallback/兜底逻辑前必须先获得明确用户同意，并配套覆盖失败语义的测试。
