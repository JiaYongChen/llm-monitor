# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

LLM Monitor — 本地 LLM API 调用监控工具。通过代理拦截 CLI 工具（Claude Code、Codex 等）的 API 请求，实时记录调用详情、自动计费，并提供 Web 面板可视化。

## 构建与开发

```bash
npm install
npm run dev              # 开发模式：代理 :9400 + 面板 :9401（Vite HMR 挂载在 :9401）
npm run dev -- --port 8400 --webui-port 8401  # 自定义端口（CLI 参数）
npm run build            # 生产构建（前端 vite build → dist/web）
npm test                 # 运行全部测试（vitest run）
npx vitest --watch       # 交互式测试
npx tsx proxy/main.ts    # 生产模式启动（需先 build，可加 --port --webui-port）
```

- 始终使用 **Debug 构建**概念验证（本项目构建即 `vite build`，无 Debug/Release 区分）
- 数据存储在 `~/.llm-monitor/calls.db`（sql.js，原子写入防 crash 时文件损坏，损坏时从备份恢复）

## CLI 快捷启动

```bash
npm link                    # 一次性注册全局命令
llm-monitor ClaudeCode      # 启动 ClaudeCode（当前目录）
llm-monitor codex ./project # 启动 Codex（指定目录）
```

- Windows：`scripts/start-tool.cmd` → `start-tool.ps1`
- macOS/Linux：`scripts/start-tool`（bash）
- 预创建会话后将 ID 嵌入 URL（`/s/<id>/ClaudeCode` 或 `/s/<id>/codex`），同终端所有请求归入同一会话
- Codex 通过写入 `~/.codex/config.toml` 配置代理（不支持环境变量 `OPENAI_BASE_URL`）；Claude Code 通过 `ANTHROPIC_BASE_URL` 环境变量

## 技术架构

```
CLI 工具 ─→ :9400/proxy 路由 ─→ 格式转换（按需） ─→ 上游 API
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
| `proxy/main.ts` | Fastify 入口：初始化数据库、注册路由、启动时校验供应商 base_url、挂载 Vite（dev）或静态文件（prod） |
| `proxy/router.ts` | 核心路由：URL 首段按工具名识别（`/ClaudeCode`/`/codex`）映射到供应商后剥离转发 + `/api/*` 查询/写入 API |
| `proxy/forwarder.ts` | HTTP 转发：非流式（forwardRequest）+ SSE 流式透传（forwardStream），从 SSE 中提取 usage JSON + 思考内容分离，支持三种 SSE 格式（Anthropic / OpenAI Responses API / OpenAI Chat Completions） |
| `proxy/converter.ts` | 格式转换：Anthropic ↔ OpenAI 请求/响应双向转换（请求体 + 非流式 + SSE 流式），仅源格式 ≠ 目标格式时启用 |
| `proxy/session.ts` | 会话识别：provider + 会话种子 → SHA256 指纹 → 自动创建/复用会话，自动生成标签（首条用户消息） |
| `proxy/normalizer.ts` | Token 归一化：三种 usage 格式 → 统一的 NormalizedTokens。OpenAI Chat Completions（prompt_tokens/completion_tokens）优先，OpenAI Responses API（input_tokens/output_tokens）作 fallback；格式由上游响应 URL 决定 |
| `proxy/pricing.ts` | 定价匹配（最长模型前缀匹配）+ 费用计算（非 CNY 币种自动汇率换算为 CNY 存储） |
| `proxy/rates.ts` | 汇率：Frankfurter API 拉取 → metadata 表缓存，每日 09:30 CST 定时刷新，兜底内置汇率 |
| `proxy/recorder.ts` | 后台消费者：定时轮询队列 → normalize → pricing → insertCall + upsertDailyStat + updateSessionStats |
| `proxy/db.ts` | sql.js 数据库全部操作：建表（schema v3）、CRUD、daily_stats 累加、统计聚合、Settings、Provider Config、Tool Config |
| `proxy/thinking-preview.ts` | 终端思考输出格式化：分隔线包围 + `[think]` 独立前缀标签 |
| `proxy/config.ts` | CLI 参数解析（--port / --webui-port）+ 目录常量（DATA_DIR=~/.llm-monitor） |
| `shared/extractThinking.ts` | 思考提取函数：兼容流式干净结构 / Anthropic 原始 / OpenAI 原始三种响应形态，前后端共用 |

## 数据流

1. **代理阶段**：请求到达 `router.ts` → 根据 URL 首段识别工具（如 `/codex/v1/responses` → codex）→ 映射到供应商 → 剥离首段 → 检测格式差异 → 如需转换调用 `converter.ts` → `forwardRequest`/`forwardStream` 转发至上游 → 收集响应
2. **入队阶段**：响应返回后立即构造 `CallRecord`（含原始 request/response body + tool）入队 — 此处不阻塞响应，思考内容从流式响应中独立分离存为 `thinking` 字段
3. **后台处理**：`recorder.ts` 每 100ms 轮询队列 → 根据上游 URL 检测响应格式（`detectFormatFromUrl`）→ `normalizer.ts` 解析 Token → `pricing.ts` 匹配定价并计费 → `insertCall` 写入 calls 表 → `upsertDailyStat` 累加统计表 → `updateSessionStats` 更新会话聚合
4. **展示阶段**：Web 面板通过 `/api/*` 端点查询 `daily_stats` 统计表（删除操作不影响）和 `calls` 明细表；思考过程在调用详情页折叠展示、终端以 `[think]` 前缀实时输出

## 路由架构

`proxy/router.ts` 的 `/*` 通配路由按 URL 第一段识别工具名（大小写不敏感），然后映射到上游供应商：

- **ClaudeCode**（ClaudeCode CLI）：`/ClaudeCode/v1/messages` → `api.anthropic.com`
- **codex**（Codex CLI）：`/codex/v1/responses` → `api.openai.com`（Responses API 格式）
- **向后兼容**：`/anthropic` → `ClaudeCode`、`/openai` → `codex` 旧格式继续可用
- 自定义供应商工具通过 `tool_config` 表配置默认上游
- 上游覆盖优先级：会话 > 工具 > URL 默认映射
- 启动时校验所有已启用供应商的 `base_url` 有效，无效则拒绝启动

## 统计持久化

数据库 `daily_stats` 表独立于 `calls`/`sessions` 累积每日调用统计：

- recorder 每次处理后实时 upsert（UTC+8 日期归属，tool 自动归一化）
- `getStats`/`getDailyStats` 查询 `daily_stats` 而非 `calls`
- 删除操作行为：
  - 单条删除 / 清空会话 / 清理旧数据 → **统计不变**
  - 清空全部数据 → 统计同步清空
- 首次升级 v3 时自动从 `calls` 表回填历史统计

## 格式转换

当工具格式与上游供应商格式不匹配时自动转换（`proxy/converter.ts`）：

| 方向 | 请求 | 非流式响应 | SSE 流式 |
|------|:---:|:---:|:---:|
| Anthropic → OpenAI | ✅ | ✅ | ✅ |
| OpenAI → Anthropic | ✅ | ✅ | ✅ |

- 源格式由工具决定：ClaudeCode → anthropic，其余 → openai
- 目标格式由上游供应商 base_url 决定（含 anthropic → anthropic 格式）

## 工具级配置

`tool_config` 表存储每个工具（ClaudeCode / codex）的默认上游供应商和模型。新建会话时自动继承工具级配置，会话详情页可单独覆盖。

## Token 归一化

- 归一化格式由上游实际响应 URL 决定（`detectFormatFromUrl`），兜底用工具类型（`detectFormatFromTool`）
- Anthropic：`input_tokens` / `output_tokens` / `cache_read_input_tokens` / `cache_creation_input_tokens`；`uncached_input = max(0, input - cacheWrite)`
- OpenAI Chat Completions（含 Kimi / GLM 等兼容供应商）：`prompt_tokens` / `completion_tokens` / `prompt_tokens_details.cached_tokens`；`uncached_input = max(0, input - cached)`
- OpenAI Responses API（Codex 等新工具使用 `/responses` 端点）：`input_tokens` / `output_tokens` / `input_tokens_details.cached_tokens`；在 `normalizeOpenAI` 中作为 Chat Completions 字段不存在时的 fallback
- `uncached_input` 使用 `Math.max(0, ...)` 防御下溢为负

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
- `/api/*` 路由注册在 WebUI 端口的独立 Fastify 实例上，通配路由在代理端口，两个端口隔离确保 API 不被代理拦截
- 汇率模块（`rates.ts`）在 `scheduleDailyRefresh()` 中使用 UTC+8 推算下次刷新时间，不依赖系统时区
- 会话表使用 `AUTOINCREMENT`，删除全部会话后 ID 不会重置
