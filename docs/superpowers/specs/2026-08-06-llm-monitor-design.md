# LLM Monitor 设计文档

> 一个根据大语言模型区分 API 调用详情的本地监控面板

**日期**: 2026-08-06
**状态**: 设计阶段

---

## 1. 概述

### 1.1 定位

面向开发者的**本地 LLM API 调用监控工具**。通过代理中间件拦截 Claude Code、Codex 等 CLI 工具发出的 API 请求，记录调用详情、计算费用、提供可视化面板。

### 1.2 核心目标

- 一条命令启动，浏览器打开面板，用完关掉
- 设置环境变量即可接入，零代码改动
- 支持 Anthropic、OpenAI、DeepSeek、Qwen 四家提供商，架构可扩展
- 输入/输出 Token 和费用分开展示，缓存命中/未命中清晰区分
- 多进程并发时按工具 → 会话自动分组

---

## 2. 使用流程

### 2.1 对接（一次性）

```bash
# Claude Code
export ANTHROPIC_BASE_URL="http://localhost:9400/anthropic"

# Codex / OpenAI CLI
export OPENAI_BASE_URL="http://localhost:9400/openai/v1"

# DeepSeek CLI
export DEEPSEEK_BASE_URL="http://localhost:9400/deepseek/v1"

# Qwen CLI
export DASHSCOPE_BASE_URL="http://localhost:9400/dashscope/compatible-mode/v1"
```

设置后 Claude Code / Codex 等工具照常使用，所有请求自动经过本地代理。

### 2.2 日常使用

```bash
# 启动监控工具（终端 1）
llm-monitor start
# 🚀 代理: http://localhost:9400
# 📊 面板: http://localhost:9400/dashboard

# 终端 2-N：正常使用 Claude Code / Codex
claude
codex

# 浏览器打开面板查看实时调用
# Ctrl+C 关闭代理，数据持久保存在 ~/.llm-monitor/calls.db
```

---

## 3. 架构

### 3.1 整体架构

```
┌──────────────────────────────────────────────────────────┐
│                      用户终端窗口                         │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐               │
│  │Claude #1 │  │Claude #2 │  │  Codex   │               │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘               │
└───────┼──────────────┼──────────────┼────────────────────┘
        │              │              │
        ▼              ▼              ▼
┌──────────────────────────────────────────────────────────┐
│              LLM Monitor（单进程 :9400）                   │
│                                                          │
│  ┌──────────────────────────────────────────────────┐   │
│  │              代理层（Fastify）                     │   │
│  │  /anthropic/*  → 转发 api.anthropic.com           │   │
│  │  /openai/v1/*  → 转发 api.openai.com              │   │
│  │  /deepseek/*   → 转发 api.deepseek.com            │   │
│  │  /dashscope/*  → 转发 dashscope.aliyuncs.com      │   │
│  │                                                   │   │
│  │  请求到达 → 记录请求体 + 时间戳                     │   │
│  │          → 转发到官方 API（流式透传）                │   │
│  │          → 捕获响应体 + Token 用量 + 状态码 + 耗时    │   │
│  │          → 扔入内存队列 → 后台消费者处理              │   │
│  └──────────────────────────────────────────────────┘   │
│                          │                               │
│              ┌───────────▼──────────┐                    │
│              │    内存队列（Worker）  │                    │
│              └───────────┬──────────┘                    │
│                          ▼                               │
│  ┌──────────────────────────────────────────────────┐   │
│  │            后台消费者（单线程）                       │   │
│  │  1. 识别会话归属（指纹匹配）                          │   │
│  │  2. Token 归一化（四家 → 统一字段）                    │   │
│  │  3. 费用计算（三条价格线）                            │   │
│  │  4. 写入 SQLite（WAL 模式）                          │   │
│  └──────────────────────────────────────────────────┘   │
│                          │                               │
│              ┌───────────▼──────────┐                    │
│              │   SQLite（WAL 模式）   │                    │
│              │   ~/.llm-monitor/     │                    │
│              │   calls.db            │                    │
│              └───────────┬──────────┘                    │
│                          │                               │
│  ┌──────────────────────────────────────────────────┐   │
│  │            查询 API + 静态文件服务                    │   │
│  │  /api/calls      → 调用列表（分页、筛选）             │   │
│  │  /api/calls/:id  → 单条详情（含完整请求/响应体）        │   │
│  │  /api/sessions   → 会话列表 + 汇总                    │   │
│  │  /api/stats      → 聚合统计（按工具/模型/时间）         │   │
│  │  /*              → React 面板（静态文件）               │   │
│  └──────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────┘
        │                                            │
        ▼                                            ▼
   ┌─────────┐                              ┌──────────────┐
   │ 官方 API │                              │    官方 API    │
   └─────────┘                              └──────────────┘
```

### 3.2 路由映射

| 本地路径 | 转发目标 | 服务对象 |
|---------|---------|---------|
| `/anthropic/*` | `https://api.anthropic.com/*` | Claude Code |
| `/openai/v1/*` | `https://api.openai.com/v1/*` | Codex |
| `/deepseek/v1/*` | `https://api.deepseek.com/v1/*` | DeepSeek 工具 |
| `/dashscope/compatible-mode/v1/*` | `https://dashscope.aliyuncs.com/compatible-mode/v1/*` | Qwen CLI |

---

## 4. 会话识别

### 4.1 指纹计算

每个请求到达时计算三元组指纹：`(provider, source_port, api_key_prefix)`

- `provider`: 从 URL 路径推导（`/anthropic/*` → `anthropic`）
- `source_port`: 从 TCP 连接获取，同一进程复用同一端口
- `api_key_prefix`: 从 Authorization header 提取前 N 位

### 4.2 归属逻辑

```
1. 请求到达 → 计算指纹
2. 指纹匹配已有活跃会话 → 归入该会话
3. 指纹不匹配 → 创建新会话 → 归入该会话
```

握手请求（如 `GET /v1/models`）和对话请求不做区分——从第一条请求起就建立会话归属。

### 4.3 会话生命周期

- **活跃判定**: 最后请求时间距今 < 3 分钟
- **自动结束**: 超过 3 分钟无新请求 → `status = 'ended'`
- **手动操作**: 面板上支持重命名、合并相邻会话
- **可选环境变量**: `LLM_MONITOR_SESSION="名称"` 手动指定会话名称

---

## 5. 数据模型

### 5.1 表结构

#### calls（调用记录）

```sql
CREATE TABLE calls (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id      INTEGER NOT NULL REFERENCES sessions(id),
    provider        TEXT    NOT NULL,   -- anthropic | openai | deepseek | qwen
    model           TEXT    NOT NULL,   -- 原始模型名
    endpoint        TEXT    NOT NULL,   -- /v1/messages | /v1/chat/completions
    method          TEXT    NOT NULL,   -- GET | POST
    status_code     INTEGER,            -- 200 | 429 | 500 | ...
    error_message   TEXT,
    duration_ms     INTEGER NOT NULL,

    -- Token 归一化字段
    prompt_tokens       INTEGER,        -- 总输入
    output_tokens       INTEGER,        -- 总输出
    cache_read_tokens   INTEGER,        -- 缓存命中
    cache_write_tokens  INTEGER,        -- 缓存写入
    uncached_input      INTEGER,        -- 无缓存输入

    -- 费用（输入/输出分计）
    input_cost    REAL DEFAULT 0.0,     -- 输入费用合计
    output_cost   REAL DEFAULT 0.0,     -- 输出费用合计
    total_cost    REAL DEFAULT 0.0,     -- input_cost + output_cost
    cache_savings REAL DEFAULT 0.0,     -- 缓存节省金额

    -- 原始数据
    request_body   TEXT,
    response_body  TEXT,

    -- 元数据
    fingerprint  TEXT NOT NULL,
    source_port  INTEGER,

    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_calls_session    ON calls(session_id);
CREATE INDEX idx_calls_created    ON calls(created_at);
CREATE INDEX idx_calls_model      ON calls(model);
CREATE INDEX idx_calls_fingerprint ON calls(fingerprint);
```

#### sessions（会话）

```sql
CREATE TABLE sessions (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    tool          TEXT    NOT NULL,   -- claude-code | codex | custom
    label         TEXT,               -- 用户手动命名（可选）
    fingerprint   TEXT    NOT NULL UNIQUE,
    request_count INTEGER NOT NULL DEFAULT 0,
    total_cost    REAL    NOT NULL DEFAULT 0,
    total_tokens  INTEGER NOT NULL DEFAULT 0,
    first_call_at TEXT,
    last_call_at  TEXT,
    first_endpoint TEXT,              -- 首条请求的端点
    status        TEXT    NOT NULL DEFAULT 'active',
    created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_sessions_tool   ON sessions(tool);
CREATE INDEX idx_sessions_status ON sessions(status);
```

#### pricing（定价）

```sql
CREATE TABLE pricing (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    provider          TEXT    NOT NULL,  -- anthropic | openai | deepseek | qwen
    model             TEXT    NOT NULL,  -- 模型名称（前缀匹配）
    input_price       REAL    NOT NULL,  -- 输入价格（无缓存命中）per 1M tokens
    cache_input_price REAL    NOT NULL,  -- 输入价格（命中缓存）per 1M tokens
    output_price      REAL    NOT NULL,  -- 输出价格 per 1M tokens
    unit              TEXT    NOT NULL DEFAULT 'per_1M_tokens',
    currency          TEXT    NOT NULL DEFAULT 'USD',
    effective_from    TEXT,
    UNIQUE(provider, model, effective_from)
);
```

#### metadata（元数据）

```sql
CREATE TABLE metadata (
    key   TEXT PRIMARY KEY,
    value TEXT
);
```

### 5.2 表关系

```
sessions 1 ──── N calls
   │ fingerprint 关联到同一进程发出的所有请求
```

查询路径：面板 → `/api/sessions` → 选会话 → `/api/calls?session_id=X` → 展开某条 → `/api/calls/:id`

### 5.3 数据清理

- 面板提供"清空数据"按钮（保留定价表）
- 可配置自动清理：N 天前记录自动删除（默认不开启）
- 每天 1000 次调用约产生 5MB 数据，本地磁盘无压力

---

## 6. 费用计算

### 6.1 三条价格线

| 价格字段 | 含义 | 存储位置 |
|---------|------|---------|
| `input_price` | 输入 Token（没有命中缓存） | pricing 表 |
| `cache_input_price` | 输入 Token（命中缓存） | pricing 表 |
| `output_price` | 输出 Token | pricing 表 |

### 6.2 各提供商 API 返回的原始字段

| 概念 | Anthropic | OpenAI | DeepSeek | Qwen |
|------|-----------|--------|----------|------|
| 总输入 Token | `input_tokens` | `prompt_tokens` | `prompt_tokens` | `prompt_tokens` |
| 命中缓存 | `cache_read_input_tokens` | `prompt_tokens_details.cached_tokens` | `prompt_cache_hit_tokens` | `prompt_tokens_details.cached_tokens` |
| 写入缓存 | `cache_creation_input_tokens` | — | — | `prompt_tokens_details.cache_creation_input_tokens` |
| 未命中缓存 | `input_tokens - cache_creation` | `prompt_tokens - cached` | `prompt_cache_miss_tokens` | `prompt_tokens - cached - cache_creation` |
| 总输出 Token | `output_tokens` | `completion_tokens` | `completion_tokens` | `completion_tokens` |

### 6.3 归一化公式

代理将四家不同格式归一化为统一字段后写入 calls 表：

| calls 表字段 | Anthropic | OpenAI | DeepSeek | Qwen |
|-------------|-----------|--------|----------|------|
| `prompt_tokens` | `input_tokens` | `prompt_tokens` | `prompt_tokens` | `prompt_tokens` |
| `output_tokens` | `output_tokens` | `completion_tokens` | `completion_tokens` | `completion_tokens` |
| `cache_read_tokens` | `cache_read_input` | `cached_tokens` | `prompt_cache_hit` | `cached_tokens` |
| `cache_write_tokens` | `cache_creation` | 0 | 0 | `cache_creation` |
| `uncached_input` | `prompt_tokens - cache_write` | `prompt_tokens - cache_read` | `prompt_cache_miss` | `prompt_tokens - cache_read - cache_write` |

### 6.4 统一费用公式

归一到 calls 表后，四个提供商使用**同一公式**计算：

```
输入费用（无缓存） = uncached_input      / 1M × input_price
输入费用（写缓存） = cache_write_tokens  / 1M × input_price
输入费用（读缓存） = cache_read_tokens   / 1M × cache_input_price
输出费用           = output_tokens       / 1M × output_price

total_cost = 上面四项之和
input_cost = 前三个输入项之和
output_cost = 输出项
```

输入和输出费用分别在 calls 表中独立存储（`input_cost`、`output_cost`），面板可单独展示。

### 6.5 预置定价示例

| 提供商 | 模型 | input_price | cache_input_price | output_price |
|--------|------|-------------|-------------------|-------------|
| anthropic | claude-opus-5 | $15.00 | $1.50 | $75.00 |
| anthropic | claude-sonnet-5 | $3.00 | $0.30 | $15.00 |
| openai | gpt-4o | $2.50 | $1.25 | $10.00 |
| openai | o4-mini | $1.10 | $0.55 | $4.40 |
| deepseek | deepseek-v4-flash | $0.14 | $0.0028 | $0.28 |
| deepseek | deepseek-v4-pro | $0.435 | $0.003625 | $0.87 |
| qwen | qwen-flash | $0.022 | $0.0043 | $0.22 |
| qwen | qwen-plus | $0.40 | $0.08 | $1.20 |

### 6.6 Qwen 缓存模式说明

Qwen 有两套缓存模式：

| 模式 | 触发方式 | 写缓存价格 | 读缓存价格 |
|------|---------|-----------|-----------|
| 隐式 | 自动，无需配置 | 等于 input_price | 约 20% of input_price |
| 显式 | 请求中加 `cache_control` | 125% of input_price | 约 10% of input_price |

首版只处理隐式模式。显式缓存作为后续增强。

---

## 7. 请求生命周期

```
请求到达 :9400
    │
    ├── 1. 解析路由 → provider
    ├── 2. 提取元数据 → fingerprint = (provider, source_port, api_key_prefix)
    ├── 3. 会话匹配 → fingerprint 找 session，没有则新建
    ├── 4. 转发到官方 API（使用 undici fetch 或 got）
    │      流式响应逐 chunk 透传回客户端
    │      所有 chunk 追加到 buffer 中
    ├── 5. 流结束后
    │      从 buffer 拼完整响应 JSON
    │      提取 usage、model、status_code、duration
    │      组装 CallRecord → 入 Worker 线程队列
    │      立即返回，不阻塞主线程
    └── 6. Worker 线程消费者
           从队列取出 CallRecord
           → Token 归一化（按 provider 分支）
           → 查定价表（model 前缀匹配）
           → 计算费用（三条线分别算）
           → 写入 SQLite（better-sqlite3 同步操作）
           → 更新 sessions 表
```

---

## 8. 面板设计

### 8.1 布局

左侧树形导航 + 右侧内容区：

```
┌────────────────────────────────────────────────────────────┐
│  📊 LLM Monitor                              ⚙️ 设置       │
├────────────┬───────────────────────────────────────────────┤
│  📋 总览   │                                               │
│            │  [KPI 卡片: 总调用 / 费用 / Token / 缓存率]     │
│  ▼ Claude  │                                               │
│    ├ 会话A │  [费用饼图: 按模型]  [24h 调用趋势图]           │
│    ├ 会话B │                                               │
│    └ 会话C │  [实时调用流: 最新 20 条自动刷新]                 │
│            │                                               │
│  ▼ Codex   │                                               │
│    ├ 会话D │                                               │
│    └ 会话E │                                               │
└────────────┴───────────────────────────────────────────────┘
```

### 8.2 四个页面

| 页面 | 路由 | 内容 |
|------|------|------|
| 总览 | `/` | KPI 卡片 + 费用饼图 + 24h 趋势图 + 实时调用流 |
| 会话详情 | `/sessions/:id` | 会话摘要 + 调用时间线（可展开每条） |
| 调用详情 | `/calls/:id` | 请求体/响应体（可折叠）+ 费用明细（输入/输出分列） |
| 设置 | `/settings` | 定价管理 + 数据管理 + 代理配置 |

### 8.3 前端技术栈

| 层 | 选择 |
|---|------|
| 框架 | React 18 + TypeScript |
| 构建 | Vite |
| 样式 | Tailwind CSS |
| 图表 | Recharts |
| 数据获取 | TanStack React Query（3s 轮询实时流） |
| 路由 | React Router |

### 8.4 费用明细展示格式

```
┌─ 费用明细 ──────────────────────────────────────────────┐
│ 输入 Token: 1500                              费用       │
│   ├ 无缓存:     300 token                     $0.0045   │
│   ├ 缓存写入:   200 token                     $0.0030   │
│   └ 缓存命中:  1000 token                     $0.0015   │
│   输入合计:    1500 token                     $0.0090   │
│ ─────────────────────────────────────────────────────── │
│ 输出 Token:     800 token                     $0.0600   │
│ ─────────────────────────────────────────────────────── │
│ 总计:          2300 token                     $0.0690   │
└─────────────────────────────────────────────────────────┘
```

---

## 9. 错误处理

| 场景 | 处理方式 |
|------|---------|
| 官方 API 429（限流） | 透传 429 给客户端，记录状态码，费用记为 0 |
| 官方 API 5xx（服务端错） | 透传给客户端，记录状态码和错误信息 |
| 代理写入 SQLite 失败 | 日志记录错误，不影响客户端响应 |
| 解析 usage 失败（字段缺失） | token 字段留 NULL，费用 0，原始 body 保留供排查 |
| 模型不在定价表中 | total_cost = 0，面板标记 ⚠️"待定价" |
| 流式中途断开 | buffer 内容不完整，标记对应状态码 |

---

## 10. 项目结构

```
llm-monitor/
├── proxy/                         # Node.js 代理层 (Fastify + TypeScript)
│   ├── main.ts                    # 入口，启动 Fastify + 静态文件 + Worker
│   ├── config.ts                  # 配置管理（端口、路径、超时）
│   ├── db.ts                      # SQLite 初始化 + better-sqlite3 CRUD
│   ├── types.ts                   # 共享类型定义（前后端共用）
│   ├── router.ts                  # 代理路由注册 + /api/* 查询路由
│   ├── forwarder.ts               # HTTP 转发（undici，含流式 SSE）
│   ├── session.ts                 # 会话识别（指纹 → session 匹配）
│   ├── normalizer.ts              # Token 归一化（4 家 provider）
│   ├── pricing.ts                 # 定价查询 + 费用计算
│   └── recorder.ts                # Worker 线程消费者（归一化→计费→写库）
│
├── web/                           # React 前端 (Vite + TypeScript)
│   ├── src/
│   │   ├── pages/
│   │   │   ├── Dashboard.tsx
│   │   │   ├── SessionDetail.tsx
│   │   │   ├── CallDetail.tsx
│   │   │   └── Settings.tsx
│   │   ├── components/
│   │   │   ├── Layout.tsx         # 整体布局（侧边栏 + 内容区）
│   │   │   ├── Sidebar.tsx        # 树形导航
│   │   │   ├── KpiCards.tsx        # KPI 统计卡片
│   │   │   ├── CostPieChart.tsx    # 按模型费用饼图
│   │   │   ├── TrendChart.tsx      # 24h 调用趋势折线图
│   │   │   ├── CallStream.tsx      # 实时调用流列表
│   │   │   ├── CallTimeline.tsx    # 会话内调用时间线
│   │   │   ├── CallDetailPanel.tsx # 调用详情面板（可折叠）
│   │   │   └── PricingTable.tsx    # 定价管理表格
│   │   ├── api/
│   │   │   └── client.ts          # API 客户端 + React Query hooks
│   │   ├── App.tsx
│   │   └── main.tsx
│   ├── index.html
│   ├── package.json
│   ├── tsconfig.json
│   ├── tailwind.config.js
│   └── vite.config.ts
│
├── shared/                        # 前后端共享
│   └── types.ts                   # CallRecord, Session, Pricing, Stats 等类型
│
├── tests/                         # 测试 (Vitest)
│   ├── mock-llm-server.ts         # Mock LLM API 服务
│   ├── forwarder.test.ts
│   ├── normalizer.test.ts
│   ├── pricing.test.ts
│   ├── session.test.ts
│   ├── recorder.test.ts
│   ├── api.test.ts
│   └── e2e.test.ts
│
├── data/
│   └── default-pricing.json       # 四家 provider 初始定价
├── package.json
├── tsconfig.json
└── README.md
```

### 10.1 技术栈

| 层 | 选择 | 理由 |
|----|------|------|
| 运行时 | Node.js 18+ | 全栈 TypeScript 统一 |
| 代理框架 | Fastify | 高性能，原生 TS，插件系统 |
| HTTP 客户端 | undici | Node 内置，流式支持好 |
| 数据库 | better-sqlite3 | 同步 API 简单可靠，无需 async |
| 后台处理 | Worker Threads | 单线程消费，与主线程隔离 |
| 测试 | Vitest | 前后端统一测试框架 |
| 前端框架 | React 18 + TypeScript | — |
| 构建 | Vite | 一体两面：dev server + 前端构建 |
| 共享类型 | `shared/types.ts` | 前后端共用一份类型定义 |

---

## 11. 开发与测试

### 11.1 开发顺序

1. 代理核心：转发 + 流式透传 + 会话识别 + SQLite
2. 数据层：Token 归一化 + 定价匹配 + 费用计算
3. 查询 API：calls / sessions / stats
4. 前端面板：总览 → 会话 → 详情 → 设置
5. 打磨：预置定价、自动清理、错误处理

### 11.2 测试策略

| 层级 | 方法 | 覆盖目标 |
|------|------|---------|
| 代理转发 | Mock LLM Server + Vitest + undici | 核心路径 100% |
| Token 归一化 | 四家固定响应 JSON + 参数化测试 | 100% |
| 费用计算 | 边界测试（0 token、缓存=0、缓存=全部） | 100% |
| 查询 API | Fastify inject + 分页/筛选/空数据 | 关键路径 |
| 前端 | React Query + MSW mock | Smoke 级别 |

Mock LLM Server 用 Fastify 搭建，模拟四家提供商的正常响应（含流式 SSE）、429 限流、5xx 错误，不需要真实 API Key。

### 11.3 端到端验证

```
1. 启动 Mock LLM Server（独立端口）
2. 启动代理（Fastify + Vite middleware）
3. undici 发 10 个模拟请求（混合 providers，含流式）
4. undici 调 /api/sessions → 验证 session 数量
5. undici 调 /api/stats → 验证费用汇总
6. 清理，断言全部通过
```

---

## 12. 扩展性

- **新增提供商**: 加一个路由规则 + 一个 normalizer 分支 + 一条定价记录
- **部署形态升级**: 内存队列 → Redis 队列，SQLite → Postgres，前端可独立部署
- **多机汇总**: 后续可在代理后加一个上报服务，多台机器的数据统一汇总到一个面板

---

## 13. 不在此版本范围

- 用户认证 / 多用户
- 远程部署 / 云端面板
- Qwen 显式缓存模式定价
- 自动同步官方最新定价（初始手动维护 JSON）
- Agent 工具调用链路的调用详情展开（后续增强）
- 费用告警 / 预算上限通知
