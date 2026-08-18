# AGENTS.md

This file provides guidance to AI agents (Claude Code, Codex, etc.) when working with code in this repository.

## 项目概述

LLM Monitor — 本地 LLM API 调用监控工具。通过代理拦截 CLI 工具（Claude Code、Codex 等）的 API 请求，实时记录调用详情、自动计费，并提供 Web 面板可视化。

## 构建与开发

```bash
npm install
npm run dev              # 开发模式：代理 :9400 + 面板 :9401（Vite HMR 挂载在 :9401），开发模式自动输出 [proxy] 诊断日志
npm run dev -- --port 8400 --webui-port 8401  # 自定义端口（CLI 参数）
npm run dev -- --debug   # 显式调试模式：输出 [proxy] 请求转发诊断日志（也可用环境变量 LLM_MONITOR_DEBUG=1；生产模式默认静默）
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
llm-monitor chatgpt         # chatGPT 为 Codex 的别名
```

- 工具名大小写不敏感：`claude`/`claudeCode` → 小写存储 `claudecode`，`codex`/`chatGPT` → `codex`

- Windows：`scripts/start-tool.cmd` → `start-tool.ps1`
- macOS/Linux：`scripts/start-tool`（bash）
- 预创建会话后将 ID 嵌入 URL（`/s/<id>/claudecode` 或 `/s/<id>/codex`，大小写不敏感），同终端所有请求归入同一会话
- Codex 通过写入 `~/.codex/config.toml` 配置代理（不支持环境变量 `OPENAI_BASE_URL`）；Claude Code 通过 `ANTHROPIC_BASE_URL` 环境变量

## 技术架构

```
CLI 工具 ─→ :9400/proxy 路由 ─→ 格式转换（按需） ─→ 上游 API
                │
                ▼
          后台消费者（recorder）
          normalize → 计费 → db
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
| `proxy/router.ts` | 核心路由：URL 首段按工具名识别（`/claudecode`/`/codex`，大小写不敏感）映射到供应商后剥离转发 + `/api/*` 查询/写入 API |
| `proxy/forwarder.ts` | HTTP 转发：非流式（forwardRequest）+ SSE 流式透传（forwardStream），从 SSE 中提取 usage JSON + 思考内容分离，支持三种 SSE 格式（Anthropic / OpenAI Responses API / OpenAI Chat Completions） |
| `proxy/converter.ts` | 格式转换：Anthropic ↔ OpenAI 请求/响应双向转换（请求体 + 非流式 + SSE 流式），仅源格式 ≠ 目标格式时启用 |
| `proxy/session.ts` | 会话识别：provider + 会话种子 → SHA256 指纹 → 自动创建/复用会话，自动生成标签（首条用户消息） |
| `proxy/normalizer.ts` | Token 归一化：三种 usage 格式 → 统一的 NormalizedTokens。OpenAI Chat Completions（prompt_tokens/completion_tokens）优先，OpenAI Responses API（input_tokens/output_tokens）作 fallback；格式由上游响应 URL 决定 |
| `proxy/pricing.ts` | 定价匹配（读 provider_models 价格列：provider 大小写不敏感 + 价格 0 行不参与 + 模型名最长前缀，忽略 enabled/available 开关）+ 费用计算（非 CNY 币种自动汇率换算为 CNY 存储） |
| `proxy/model-sync.ts` | 模型探测与定价自动同步：供应商 `/v1/models` 探测（OpenAI/Anthropic 两种格式）→ provider_models 标记式+价格全量覆盖写入（一次事务）+ metadata 同步状态；每日 04:00 CST 定时 + 供应商配置变更自动触发 |
| `proxy/pricing-sources.ts` | 定价源拉取解析：Anthropic 官方定价文档 / liteLLM 价格表（jsdelivr 镜像）/ models.dev 目录（fallback），统一输出 USD/1M tokens 的 ModelPrice，模型名匹配（相等/最长前缀/剥离供应商前缀） |
| `proxy/rates.ts` | 汇率：Frankfurter API 拉取 → metadata 表缓存，每日 09:30 CST 定时刷新，兜底内置汇率 |
| `proxy/recorder.ts` | 后台消费者：定时轮询队列 → normalize → 定价匹配/计费 → insertCall + body 外置写文件 → upsertHourlyStat + updateSessionStats |
| `proxy/db.ts` | 数据库入口：initDb 建表（schema v4）+ 迁移调度 + 迁移后统一建索引、calls/sessions CRUD、统计聚合（getStats/getDailyStats 从 hourly_stats 上卷，删除操作不影响）、数据管理（清理/清空/合并会话，联动维护 body 文件） |
| `proxy/db-core.ts` | sql.js 核心：数据库实例管理（单例）、saveDb 落盘节流（去抖 + 安全网）、查询辅助（queryAll/queryOne/execute/executeInsert/runRaw） |
| `proxy/db-config.ts` | Provider Models CRUD（探测结果 + 价格列 + 用户开关）、Provider Config / Tool Config / Settings + `normalizeToolName` / `normalizeProviderName` 名称归一化（toLowerCase + 内置别名，大小写不敏感 → 小写存储）；可更新状态表带 created_at/updated_at（毫秒，存量行 0 = 未知） |
| `proxy/db-migrations.ts` | 迁移列表机制（v2 时间戳重建 / v3 daily_stats 回填 / v4 hourly_stats 替换 daily_stats）+ `migrateToolCanonicalNames` / `migrateLowercaseNames` 名称归一化迁移（metadata 门控 + 事务，先合并变体再改名）+ calls/sessions 共享建表 DDL 常量 |
| `proxy/db-body.ts` | body 外置文件存储（bodyData/<sessionId>/<createdAtMs>-<callId>.json）+ 渐进迁移（分片幂等 → DROP COLUMN → VACUUM，`bodies_migrated` 门控）+ 孤儿文件对账 |
| `proxy/thinking-preview.ts` | 终端思考输出格式化：分隔线包围 + `[think]` 独立前缀标签 |
| `proxy/config.ts` | CLI 参数解析（--port / --webui-port）+ 目录常量（DATA_DIR=~/.llm-monitor） |
| `shared/extractThinking.ts` | 思考提取函数：兼容流式干净结构 / Anthropic 原始 / OpenAI 原始三种响应形态，前后端共用 |
| `webui/src/pages/Overview.tsx` | 总览页（`/`）：按工具维度汇总；兼容旧查询参数重定向到工具/供应商详情路由 |
| `webui/src/pages/ToolDetail.tsx` | 工具详情页（`/tools/:tool`）：按供应商维度汇总 + 工具级上游配置面板 |
| `webui/src/pages/ProviderDetail.tsx` | 供应商详情页（`/providers/:provider`）：按模型维度汇总 + 缓存命中率 KPI |
| `webui/src/hooks/useDashboardData.ts` | Dashboard 三页共用查询 hook：stats/dailyStats/费用分布查询（含复用去重）+ 时区 + totals 归约 |
| `webui/src/components/UpstreamSelectorPanel.tsx` | 上游选择器面板（工具详情页 + 会话详情页共用）：供应商/模型下拉 + 转发地址提示，持久化留在调用方 |
| `webui/src/components/KpiCards.tsx` | KPI 卡片行（Dashboard 三页 + 会话详情页共用） |
| `webui/src/components/PageHeader.tsx` | 页面标题行（类别色标题 + 实时监控徽标） |
| `webui/src/components/TimeRangeSelector.tsx` | 时间范围分段按钮组（DAILY_RANGES 常量） |
| `webui/src/components/ChartCard.tsx` | 图表卡片外壳 |

## 数据流

1. **代理阶段**：请求到达 `router.ts` → 根据 URL 首段识别工具（如 `/codex/v1/responses` → codex）→ 映射到供应商 → 剥离首段 → 检测格式差异 → 如需转换调用 `converter.ts` → `forwardRequest`/`forwardStream` 转发至上游 → 收集响应
2. **入队阶段**：响应返回后立即构造 `CallRecord`（含原始 request/response body + tool）入队 — 此处不阻塞响应，思考内容从流式响应中独立分离存为 `thinking` 字段
3. **后台处理**：`recorder.ts` 每 100ms 轮询队列 → 根据上游 URL 检测响应格式（`detectFormatFromUrl`）→ `normalizer.ts` 解析 Token → `matchPricing` 读 provider_models 价格列（价格 0 = 无定价不参与；忽略模型开关）→ `calculateCost` 计费 → `insertCall` 写入 calls 表 → body 外置写入文件（writeBody，失败仅降级详情展示）→ `upsertHourlyStat` 累加小时统计表 → `updateSessionStats` 更新会话聚合
4. **展示阶段**：Web 面板通过 `/api/*` 端点查询 `hourly_stats` 统计表（删除操作不影响）和 `calls` 明细表，调用详情接口按需读取 body 文件（缺失/解析失败降级占位）；思考过程在调用详情页始终可见（带滚动条）、终端以 `[think]` 前缀实时输出

供应商配置新增/更新（含 api_key）后异步触发 `syncProvider`：探测 → 标记 → 价格全量覆盖（一次事务）→ 写入同步状态；上游选择器模型下拉完全由 `provider_models` 驱动（不可用置灰、关闭不出现），无启用模型行时模型下拉禁用

## 路由架构

`proxy/router.ts` 的 `/*` 通配路由按 URL 第一段识别工具名（大小写不敏感），然后映射到上游供应商：

- **ClaudeCode**（ClaudeCode CLI）：`/claudecode/v1/messages` → `api.anthropic.com`（大小写不敏感）
- **codex**（Codex CLI）：`/codex/v1/responses` → `api.openai.com`（Responses API 格式）
- **向后兼容**：`/anthropic` → `claudecode`、`/openai` → `codex` 旧格式继续可用
- 自定义供应商工具通过 `tool_config` 表配置默认上游
- 上游覆盖优先级：会话 > 工具 > URL 默认映射
- 启动时校验所有已启用供应商的 `base_url` 有效，无效则拒绝启动

## 统计持久化

数据库 `hourly_stats` 表独立于 `calls`/`sessions` 累积调用统计（主键 `(hour_ms, provider, model, tool)`，纯 UTC 小时毫秒，写入端零时区）：

- recorder 每次处理后实时 upsert（`hour_ms` 由 createdAtMs 整数运算取小时边界，tool/供应商/模型自动归一化）
- `getStats`/`getDailyStats` 查询 `hourly_stats` 而非 `calls`；天级/小时级标签在查询端按 tzOffset 重算（`today`/`yesterday` 小时粒度，`7d`~`60d` 与月/季/年范围按天）
- 删除操作行为：
  - 单条删除 / 清空会话 / 清理旧数据 → **统计不变**
  - 清空全部数据 → 统计同步清空
- 首次升级 v4 时自动从 `calls` 表回填历史统计（小时粒度），随后 DROP `daily_stats`

## Body 外置存储

调用详情 body 不存数据库列，外置为文件（`bodyData/<sessionId>/<createdAtMs>-<callId>.json`，先 DB 后文件）：

- recorder 落库后写 body 文件（失败仅降级详情展示）；删除/合并/清理操作联动维护 body 文件
- 调用详情接口按需读取（`readBody`，文件缺失/解析失败降级占位）；孤儿对账删除 calls 表中已不存在的文件
- 存量 body 列数据渐进迁移（分片幂等 → 完成后 DROP COLUMN + VACUUM，`bodies_migrated` 门控）

## 格式转换

当工具格式与上游供应商格式不匹配时自动转换（`proxy/converter.ts`）：

| 方向 | 请求 | 非流式响应 | SSE 流式 |
|------|:---:|:---:|:---:|
| Anthropic → OpenAI | ✅ | ✅ | ✅ |
| OpenAI → Anthropic | ✅ | ✅ | ✅ |

- 源格式由工具决定：claudecode → anthropic，其余 → openai
- 目标格式由上游供应商 base_url 决定（含 anthropic → anthropic 格式）

## 工具级配置

`tool_config` 表存储每个工具（claudecode / codex）的默认上游供应商和模型。新建会话时自动继承工具级配置，会话详情页可单独覆盖。

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

- sql.js 是纯 WASM 实现，数据库运行在内存中，`saveDb()` 通过去抖（500ms）合并写入减少全量导出开销；另有 2s 安全网定时器兜底防异常退出丢数据
- `closeDb()` 调用 `saveDb(undefined, true)` 立即落盘，信号处理器（SIGINT/SIGTERM）会先 `stopRecorder()` + `closeDb()` 再退出
- 生产模式下前端需先 `npm run build` 输出到 `dist/web/`，`dist/` 已加入 `.gitignore`
- 开发模式使用 Vite 中间件模式（`middlewareMode: true`），HMR 复用 Fastify 的 HTTP server
- `/api/*` 路由注册在 WebUI 端口的独立 Fastify 实例上，通配路由在代理端口，两个端口隔离确保 API 不被代理拦截
- 汇率模块（`rates.ts`）在 `scheduleDailyRefresh()` 中使用 UTC+8 推算下次刷新时间，不依赖系统时区
- 清空全部会话（`deleteAllSessions`）会同时重置 AUTOINCREMENT ID，清空全部数据（`clearAllData`）同步清空统计
- 工具 / 供应商 / 模型名存储统一小写（`normalizeToolName` / `normalizeProviderName`，模型名写入时 toLowerCase），查询匹配大小写不敏感（LOWER() 兜底 + 入参归一化等值）；`migrateLowercaseNames` 单次迁移历史数据（metadata 门控 `lowercase_migrated`，事务包裹：先按唯一约束维度合并变体行再 LOWER 改名）；前端显示统一走 `displayName`（整体映射表 + 特殊词 AI/GPT/API/CLI/LLM/URL/HTTP/HTTPS/JSON/SQL/ID/IP/GLM/KIMI 全大写 + 按分隔符分词首字母大写）；provider_config / tool_config / provider_models 三张可更新状态表带 created_at/updated_at（毫秒，存量行 0 = 未知）
- `migrateToolCanonicalNames` 历史数据迁移单次执行（metadata 门控 `tool_canonical_migrated`），事务包裹：工具维度（内置别名；chatgpt 历史数据不迁移以防劫持同名自定义工具）+ 供应商维度（按 provider_config 规范名归一 calls/sessions/tool_config/provider_models 变体）；旧迁移产出 CamelCase 中间态，随后由 `migrateLowercaseNames` 统一转小写
- 新表时间戳规则：可更新状态表（行会被 UPDATE）→ `created_at` + `updated_at`；仅追加明细表 → 仅 `created_at`；静态/派生表 → 无。`provider_models` 属可更新状态表
- provider_models 行内价格列（input_price/cache_input_price/output_price/currency，0 = 无定价）：设置页价格 0 显示「—」；模型开关（enabled）与置灰（available）只影响 UI 选择，不影响计费匹配；旧库启动时直接 DROP TABLE IF EXISTS pricing，不迁移历史定价（内置供应商靠 default-pricing.json 种子、第三方靠重新探测同步重建）
- 定价自动同步：探测结果只标记（`available`）不删除模型行；定价源匹配到的行价格全量覆盖（同 provider+model 行价格列），未匹配到的行价格保留；`modelsync_<provider>` metadata 存每供应商同步状态；探测 10s 超时
