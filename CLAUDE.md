# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

LLM Monitor — 本地 LLM API 调用监控工具。通过代理拦截 CLI 工具（Claude Code、Codex 等）的 API 请求，实时记录调用详情、自动计费，并提供 Web 面板可视化。

## 构建与开发

```bash
npm install
npm run dev              # 开发模式：代理 :9400 + 面板 :9401（Vite HMR 挂载在 :9401）
npm run build            # 生产构建（前端 vite build → dist/web）
npm test                 # 运行全部测试（vitest run）
npx vitest --watch       # 交互式测试
npx tsx proxy/main.ts    # 生产模式启动（需先 build）
```

- 始终使用 **Debug 构建**概念验证（本项目构建即 `vite build`，无 Debug/Release 区分）
- 数据存储在 `~/.llm-monitor/calls.db`（sql.js 自动持久化到磁盘）

## 技术架构

```
CLI 工具 ─→ :9400/proxy 路由 ─→ 上游 API
                │
                ▼
          后台消费者（recorder）
          normalize → pricing → db
                │
                ▼
          Web 面板 (:9401) ← /api/* 查询
```

- **代理层**（Node.js / Fastify + TypeScript）：`proxy/`
- **前端**（React 18 + Vite + Tailwind CSS + shadcn/ui）：`webui/`
- **共享类型**（前后端共用）：`shared/types.ts`
- **运行时**：`tsx` 直接执行 `.ts` 源文件

## 核心模块职责

| 文件 | 职责 |
|------|------|
| `proxy/main.ts` | Fastify 入口：初始化数据库、注册路由、挂载 Vite（dev）或静态文件（prod） |
| `proxy/router.ts` | 核心路由：`/*` 通配代理转发（按 URL 第一段识别 provider）+ `/api/*` 查询/写入 API |
| `proxy/forwarder.ts` | HTTP 转发：非流式（forwardRequest）+ SSE 流式透传（forwardStream），从 SSE 中提取 usage JSON |
| `proxy/session.ts` | 会话识别：provider + 源端口 + API Key 前缀 → SHA256 指纹 → 自动创建/复用会话 |
| `proxy/normalizer.ts` | Token 归一化：四家 provider 各自 usage 格式 → 统一的 NormalizedTokens |
| `proxy/pricing.ts` | 定价匹配（最长模型前缀匹配）+ 费用计算（非 CNY 币种自动汇率换算为 CNY 存储） |
| `proxy/rates.ts` | 汇率：Frankfurter API 拉取 → metadata 表缓存，每日 09:30 CST 定时刷新，兜底内置汇率 |
| `proxy/recorder.ts` | 后台消费者：定时轮询队列 → normalize → pricing → insertCall + updateSessionStats |
| `proxy/db.ts` | sql.js 数据库全部操作：建表、CRUD、统计聚合、Settings、Provider Config |
| `proxy/config.ts` | 端口/目录常量（PORT=9400, DATA_DIR=~/.llm-monitor） |

## 数据流

1. **代理阶段**：请求到达 `router.ts` → 根据 URL 首段识别 provider（如 `/anthropic/v1/messages`）→ `forwardRequest`/`forwardStream` 转发至上游 → 收集响应
2. **入队阶段**：响应返回后立即构造 `CallRecord`（含原始 request/response body）入队 — 此处不阻塞响应
3. **后台处理**：`recorder.ts` 每 100ms 轮询队列 → `normalizer.ts` 解析 Token → `pricing.ts` 匹配定价并计费 → `insertCall` 写入 calls 表 → `updateSessionStats` 更新会话聚合
4. **展示阶段**：Web 面板通过 `/api/*` 端点查询统计数据和明细

## Provider 支持

通过 `proxy/router.ts` 的 `/*` 通配路由按 URL 第一段识别，配置存储在 `provider_config` 表：

- **Anthropic**：`/anthropic/v1/messages` → `api.anthropic.com`
- **OpenAI**：`/openai/v1/chat/completions` → `api.openai.com`
- 支持自定义 provider（含 `base_url_anthropic` 独立 URL）
- 支持会话级上游供应商覆盖（`upstream_provider`）

## 测试

- 测试文件：`tests/*.test.ts`，使用 Vitest，环境为 Node.js
- `tests/setup.ts` 提供 `createTempDb()` — 创建临时数据库用于隔离测试
- `tests/mock-llm-server.ts` 提供 `createMockServer()` — 模拟四家 provider 的 API 响应（非流式 + 多 provider 格式）
- 数据库测试需在 `beforeAll` 调用 `initDb(tmp.dbPath)`，`afterAll` 调用 `closeDb()` + `tmp.cleanup()`

## TypeScript 配置

- `tsconfig.json` 为全项目共享：ES2022 target + bundler 模块解析 + strict 模式
- 路径别名 `@/*` 映射到项目根目录（前端 Vite 使用）
- `tests/smoke-test.ts`、`tests/start-and-test.ts`、`tests/verify.ts` 排除在 tsconfig 之外（手动运行的集成脚本）

## 注意事项

- sql.js 是纯 WASM 实现，数据库运行在内存中，每次写入后需手动调用 `saveDb()` 持久化到磁盘
- 生产模式下前端需先 `npm run build` 输出到 `dist/web/`，`dist/` 已加入 `.gitignore`
- 开发模式使用 Vite 中间件模式（`middlewareMode: true`），HMR 复用 Fastify 的 HTTP server
- `router.ts` 中 API 路由先于通配路由注册，确保 `/api/*` 不被代理拦截
- 汇率模块（`rates.ts`）在 `scheduleDailyRefresh()` 中使用 UTC+8 推算下次刷新时间，不依赖系统时区
