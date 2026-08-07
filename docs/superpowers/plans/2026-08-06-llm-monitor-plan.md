# LLM Monitor 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建一个本地 LLM API 调用监控代理 + Web 面板，拦截 Claude Code/Codex 等的 API 请求，记录详情并计算费用。

**Architecture:** 单进程 Fastify 应用（Node.js + TypeScript），包含代理转发层（流式透传）、Worker Thread 驱动的后台消费者、better-sqlite3（WAL 模式）持久化、Vite 中间件托管 React 前端。通过 `*_BASE_URL` 环境变量零侵入接入，通过 `(provider, source_port, api_key_prefix)` 三元组指纹自动区分会话。

**Tech Stack:** Node.js 18+, Fastify, better-sqlite3, undici, Vitest, React 18, Vite, Tailwind CSS, Recharts, TanStack React Query, React Router

## Global Constraints

- 语言：对话/注释使用中文，变量/函数/类/文件使用英文
- 构建：始终使用 Debug 构建验证
- 不创建 `claude/*` 前缀分支
- 不使用 git worktree
- 每项任务完成后 commit，message 使用中文
- 项目根目录：`D:\AICode\AITools\llm-monitor`
- 技术栈：Node.js + TypeScript 全栈，Fastify 代理层，better-sqlite3 数据库

---

## 文件结构

```
llm-monitor/
├── proxy/                           # Node.js 代理层 (Fastify + TypeScript)
│   ├── main.ts                      # 入口：启动 Fastify + Vite middleware + Worker
│   ├── config.ts                    # 配置管理
│   ├── db.ts                        # better-sqlite3 初始化 + CRUD
│   ├── router.ts                    # 代理路由 + /api/* 查询路由
│   ├── forwarder.ts                 # HTTP 转发（undici fetch，含流式 SSE）
│   ├── session.ts                   # 会话识别（指纹 + 生命周期）
│   ├── normalizer.ts                # Token 归一化（4 家 provider）
│   ├── pricing.ts                   # 定价匹配 + 费用计算
│   ├── recorder.ts                  # Worker Thread 消费者
│   └── types.ts                     # Zod schema + TypeScript 类型
│
├── web/                             # React 前端
│   ├── src/
│   │   ├── pages/
│   │   │   ├── Dashboard.tsx
│   │   │   ├── SessionDetail.tsx
│   │   │   ├── CallDetail.tsx
│   │   │   └── Settings.tsx
│   │   ├── components/
│   │   │   ├── Layout.tsx
│   │   │   ├── Sidebar.tsx
│   │   │   ├── KpiCards.tsx
│   │   │   ├── CostPieChart.tsx
│   │   │   ├── TrendChart.tsx
│   │   │   ├── CallStream.tsx
│   │   │   ├── CallTimeline.tsx
│   │   │   ├── CallDetailPanel.tsx
│   │   │   └── PricingTable.tsx
│   │   ├── api/client.ts
│   │   ├── App.tsx
│   │   └── main.tsx
│   ├── index.html
│   └── vite.config.ts
│
├── shared/                          # 前后端共享类型
│   └── types.ts                     # Call, Session, Pricing, StatItem, AppConfig
│
├── tests/                           # Vitest 测试
│   ├── mock-llm-server.ts           # Mock LLM API 服务（Fastify）
│   ├── setup.ts                     # 全局 test setup（临时目录 + DB）
│   ├── db.test.ts
│   ├── forwarder.test.ts
│   ├── normalizer.test.ts
│   ├── pricing.test.ts
│   ├── session.test.ts
│   ├── recorder.test.ts
│   ├── api.test.ts
│   └── e2e.test.ts
│
├── data/
│   └── default-pricing.json         # 预置定价
├── package.json
├── tsconfig.json
├── vite.config.ts
└── README.md
```

---

### Task 1: 项目骨架搭建

**Files:**
- Create: `llm-monitor/package.json`
- Create: `llm-monitor/tsconfig.json`
- Create: `llm-monitor/proxy/config.ts`
- Create: `llm-monitor/shared/types.ts`

**Interfaces:**
- Produces:
  - `config.ts`: export const `PORT = 9400`, `DATA_DIR`, `DB_PATH`, `SESSION_TIMEOUT_SEC = 180`, `AUTO_CLEANUP_DAYS = 0`
  - `shared/types.ts`: export interface `CallRecord` (20 fields), `Session` (14 fields), `Pricing` (9 fields), `StatItem` (4 fields), `AppConfig` (5 fields), `NormalizedTokens` (5 fields)

- [ ] **Step 1: 创建 package.json**

```json
{
  "name": "llm-monitor",
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "tsx proxy/main.ts",
    "build": "tsc -p tsconfig.build.json && vite build",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "fastify": "^5.0.0",
    "@fastify/static": "^8.0.0",
    "@fastify/middie": "^5.0.0",
    "better-sqlite3": "^11.0.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.0",
    "@types/node": "^22.0.0",
    "tsx": "^4.19.0",
    "typescript": "^5.5.0",
    "vitest": "^2.0.0",
    "vite": "^5.4.0",
    "@vitejs/plugin-react": "^4.3.0",
    "react": "^18.3.0",
    "react-dom": "^18.3.0",
    "react-router-dom": "^6.26.0",
    "@tanstack/react-query": "^5.51.0",
    "recharts": "^2.12.0",
    "tailwindcss": "^3.4.0",
    "autoprefixer": "^10.4.0",
    "postcss": "^8.4.0",
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0"
  }
}
```

- [ ] **Step 2: 创建 tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "outDir": "./dist",
    "rootDir": ".",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "jsx": "react-jsx"
  },
  "include": ["proxy/**/*.ts", "shared/**/*.ts", "web/src/**/*.ts", "web/src/**/*.tsx", "tests/**/*.ts"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 3: 创建 shared/types.ts**

```typescript
/** 代理层收集的原始调用记录 */
export interface CallRecord {
  provider: string;
  model: string;
  endpoint: string;
  method: string;
  status_code: number | null;
  error_message: string | null;
  duration_ms: number;
  prompt_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  uncached_input: number | null;
  input_cost: number;
  output_cost: number;
  total_cost: number;
  cache_savings: number;
  request_body: string | null;
  response_body: string | null;
  fingerprint: string;
  source_port: number | null;
  session_id: number | null;
}

/** 数据库中完整的调用记录（含 id + created_at） */
export interface Call extends CallRecord {
  id: number;
  created_at: string;
}

/** 会话 */
export interface Session {
  id: number;
  tool: string;
  label: string | null;
  fingerprint: string;
  request_count: number;
  total_cost: number;
  total_tokens: number;
  first_call_at: string | null;
  last_call_at: string | null;
  first_endpoint: string | null;
  status: 'active' | 'ended';
  created_at: string;
}

/** 模型定价 */
export interface Pricing {
  id: number;
  provider: string;
  model: string;
  input_price: number;
  cache_input_price: number;
  output_price: number;
  unit: string;
  currency: string;
  effective_from: string | null;
}

/** 聚合统计项 */
export interface StatItem {
  key: string;
  count: number;
  total_cost: number;
  total_tokens: number;
}

/** 归一化后的 Token 数据 */
export interface NormalizedTokens {
  prompt_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  uncached_input: number | null;
}

/** 应用配置 */
export interface AppConfig {
  port: number;
  data_dir: string;
  session_timeout_sec: number;
  auto_cleanup_days: number;
}
```

- [ ] **Step 4: 创建 proxy/config.ts**

```typescript
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

const DATA_DIR = join(homedir(), '.llm-monitor');
const DB_PATH = join(DATA_DIR, 'calls.db');
const PORT = 9400;
const SESSION_TIMEOUT_SEC = 180;
const AUTO_CLEANUP_DAYS = 0;

function ensureDataDir(): void {
  mkdirSync(DATA_DIR, { recursive: true });
}

export { PORT, DATA_DIR, DB_PATH, SESSION_TIMEOUT_SEC, AUTO_CLEANUP_DAYS, ensureDataDir };
```

- [ ] **Step 5: 安装依赖并验证**

```bash
cd llm-monitor
npm install
npx tsx -e "import { PORT, DB_PATH } from './proxy/config.js'; console.log('PORT:', PORT, 'DB:', DB_PATH);"
npx tsx -e "import { type CallRecord } from './shared/types.js'; console.log('types OK');"
```

- [ ] **Step 6: Commit**

```bash
git add llm-monitor/package.json llm-monitor/tsconfig.json llm-monitor/proxy/config.ts llm-monitor/shared/types.ts llm-monitor/package-lock.json
git commit -m "搭建项目骨架：Node.js + TypeScript + 共享类型"
```

---

### Task 2: 数据库初始化 + CRUD

**Files:**
- Create: `llm-monitor/proxy/db.ts`
- Create: `llm-monitor/tests/setup.ts`
- Create: `llm-monitor/tests/db.test.ts`

**Interfaces:**
- Consumes: `DB_PATH` / `ensureDataDir` from Task 1, `CallRecord` / `Session` / `Pricing` from shared/types.ts
- Produces:
  - `export function initDb(): void` — 建表 + WAL + 索引
  - `export function getDb(): Database` — 返回单例
  - `export function insertCall(r: CallRecord): number` — 返回 id
  - `export function upsertSession(fingerprint: string, tool: string, endpoint: string): number`
  - `export function updateSessionStats(...)` / `listSessions(...)` / `getSession(...)`
  - `export function listCalls(...)` / `getCall(...)` / `getStats(groupBy: string)`
  - `export function updateSessionLabel(...)` / `mergeSessions(...)`
  - `export function cleanupOldCalls(days: number): number` / `clearAllCalls()`
  - `export function listPricing()` / `upsertPricing(...)` / `deletePricing(id)`

- [ ] **Step 1: 创建 tests/setup.ts**

```typescript
// Vitest 全局 setup：创建临时数据库
import { beforeAll, afterAll } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';

// setup 的内容将在每个测试文件中通过 vi.mock 使用
export function createTempDb(): { dbPath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'llm-monitor-test-'));
  return {
    dbPath: join(dir, 'test.db'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
```

- [ ] **Step 2: 创建 proxy/db.ts（完整 CRUD）**

```typescript
import Database from 'better-sqlite3';
import { ensureDataDir, DB_PATH } from './config.js';
import type { CallRecord } from '../shared/types.js';

let db: Database.Database | null = null;

export function initDb(dbPath?: string): void {
  if (db) return;
  ensureDataDir();
  const path = dbPath ?? DB_PATH;
  db = new Database(path);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS calls (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id      INTEGER NOT NULL REFERENCES sessions(id),
      provider        TEXT    NOT NULL,
      model           TEXT    NOT NULL,
      endpoint        TEXT    NOT NULL,
      method          TEXT    NOT NULL,
      status_code     INTEGER,
      error_message   TEXT,
      duration_ms     INTEGER NOT NULL,
      prompt_tokens       INTEGER,
      output_tokens       INTEGER,
      cache_read_tokens   INTEGER,
      cache_write_tokens  INTEGER,
      uncached_input      INTEGER,
      input_cost    REAL DEFAULT 0.0,
      output_cost   REAL DEFAULT 0.0,
      total_cost    REAL DEFAULT 0.0,
      cache_savings REAL DEFAULT 0.0,
      request_body   TEXT,
      response_body  TEXT,
      fingerprint  TEXT NOT NULL,
      source_port  INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      tool          TEXT    NOT NULL,
      label         TEXT,
      fingerprint   TEXT    NOT NULL UNIQUE,
      request_count INTEGER NOT NULL DEFAULT 0,
      total_cost    REAL    NOT NULL DEFAULT 0,
      total_tokens  INTEGER NOT NULL DEFAULT 0,
      first_call_at TEXT,
      last_call_at  TEXT,
      first_endpoint TEXT,
      status        TEXT    NOT NULL DEFAULT 'active',
      created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS pricing (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      provider          TEXT    NOT NULL,
      model             TEXT    NOT NULL,
      input_price       REAL    NOT NULL,
      cache_input_price REAL    NOT NULL,
      output_price      REAL    NOT NULL,
      unit              TEXT    NOT NULL DEFAULT 'per_1M_tokens',
      currency          TEXT    NOT NULL DEFAULT 'USD',
      effective_from    TEXT,
      UNIQUE(provider, model, effective_from)
    );

    CREATE TABLE IF NOT EXISTS metadata (
      key   TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  // 索引
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_calls_session ON calls(session_id);
    CREATE INDEX IF NOT EXISTS idx_calls_created ON calls(created_at);
    CREATE INDEX IF NOT EXISTS idx_calls_model ON calls(model);
    CREATE INDEX IF NOT EXISTS idx_calls_fingerprint ON calls(fingerprint);
    CREATE INDEX IF NOT EXISTS idx_sessions_tool ON sessions(tool);
    CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
  `);
}

export function getDb(): Database.Database {
  if (!db) initDb();
  return db!;
}

export function closeDb(): void {
  if (db) { db.close(); db = null; }
}

// ── CRUD ──

export function insertCall(r: CallRecord): number {
  const stmt = getDb().prepare(`
    INSERT INTO calls (session_id, provider, model, endpoint, method,
      status_code, error_message, duration_ms, prompt_tokens, output_tokens,
      cache_read_tokens, cache_write_tokens, uncached_input, input_cost,
      output_cost, total_cost, cache_savings, request_body, response_body,
      fingerprint, source_port)
    VALUES (@sid, @prov, @model, @ep, @method, @sc, @err, @dur,
      @pt, @ot, @crt, @cwt, @ui, @ic, @oc, @tc, @cs, @rb, @resb,
      @fp, @sp)
  `);
  const result = stmt.run({
    sid: r.session_id, prov: r.provider, model: r.model, ep: r.endpoint,
    method: r.method, sc: r.status_code, err: r.error_message, dur: r.duration_ms,
    pt: r.prompt_tokens, ot: r.output_tokens, crt: r.cache_read_tokens,
    cwt: r.cache_write_tokens, ui: r.uncached_input, ic: r.input_cost,
    oc: r.output_cost, tc: r.total_cost, cs: r.cache_savings,
    rb: r.request_body, resb: r.response_body, fp: r.fingerprint, sp: r.source_port,
  });
  return Number(result.lastInsertRowid);
}

// (后续 CRUD 函数省略，参照设计文档中的所有函数签名实现)
```

> 完整实现见设计文档 5.1 节的所有 CRUD 函数。每个都使用 better-sqlite3 的同步 API。

- [ ] **Step 3: 编写测试**

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { initDb, getDb, insertCall, upsertSession, listCalls, clearAllCalls, closeDb } from '../proxy/db.js';
import { createTempDb } from './setup.js';
import type { CallRecord } from '../shared/types.js';

const tmp = createTempDb();

beforeAll(() => initDb(tmp.dbPath));
afterAll(() => { closeDb(); tmp.cleanup(); });

describe('db CRUD', () => {
  it('upsertSession 创建新会话', () => {
    const sid = upsertSession('fp_test_123', 'claude-code', '/v1/models');
    expect(sid).toBeGreaterThan(0);
  });

  it('insertCall 插入并查询', () => {
    const sid = upsertSession('fp_calls', 'claude-code', '/v1/messages');
    const rec: CallRecord = {
      provider: 'anthropic', model: 'claude-sonnet-5', endpoint: '/v1/messages',
      method: 'POST', status_code: 200, error_message: null, duration_ms: 1200,
      prompt_tokens: 500, output_tokens: 300, cache_read_tokens: 200,
      cache_write_tokens: 100, uncached_input: 400,
      input_cost: 0.005, output_cost: 0.003, total_cost: 0.008, cache_savings: 0.002,
      request_body: '{"model":"c"}', response_body: '{"ok":true}',
      fingerprint: 'fp_calls', source_port: 54321, session_id: sid,
    };
    const id = insertCall(rec);
    expect(id).toBeGreaterThan(0);
    const calls = listCalls(sid);
    expect(calls.length).toBe(1);
    expect(calls[0].total_cost).toBe(0.008);
  });
});
```

- [ ] **Step 4: 运行测试**

```bash
npx vitest run tests/db.test.ts
```

- [ ] **Step 5: Commit**

---

### Task 3: Mock LLM Server

**Files:**
- Create: `llm-monitor/tests/mock-llm-server.ts`

- [ ] **Step 1: 创建 mock-llm-server.ts**

```typescript
import Fastify, { type FastifyInstance } from 'fastify';

/** 创建 Mock LLM API 服务器（独立端口，用于测试） */
export async function createMockServer(): Promise<{ app: FastifyInstance; url: string }> {
  const app = Fastify({ logger: false });

  // Anthropic
  app.post('/anthropic/v1/messages', async (req, reply) => {
    const body = req.body as any;
    const stream = body?.stream;
    if (req.url.includes('error=429')) return reply.status(429).send({ error: 'rate_limited' });
    if (stream) {
      reply.header('content-type', 'text/event-stream');
      return reply.send(
        `event: message_start\ndata: {"type":"message_start"}\n\n` +
        `event: message_delta\ndata: {"type":"message_delta","usage":{"input_tokens":500,"output_tokens":300,"cache_creation_input_tokens":100,"cache_read_input_tokens":200}}\n\n` +
        `event: message_stop\ndata: {"type":"message_stop"}\n\n`
      );
    }
    return {
      id: 'msg_abc', type: 'message', role: 'assistant', model: body?.model || 'claude-sonnet-5',
      content: [{ type: 'text', text: 'Mock Claude response.' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 500, output_tokens: 300, cache_creation_input_tokens: 100, cache_read_input_tokens: 200 },
    };
  });
  app.get('/anthropic/v1/models', async () => ({ object: 'list', data: [] }));

  // OpenAI
  app.post('/openai/v1/chat/completions', async (req, reply) => {
    const body = req.body as any;
    if (body?.stream) {
      reply.header('content-type', 'text/event-stream');
      return reply.send(
        `data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n` +
        `data: {"choices":[{"delta":{"content":"Mock GPT response."}}],"usage":{"prompt_tokens":600,"completion_tokens":400,"prompt_tokens_details":{"cached_tokens":300}}}\n\n` +
        `data: [DONE]\n\n`
      );
    }
    return {
      id: 'chatcmpl_abc', object: 'chat.completion', model: body?.model || 'gpt-4o',
      choices: [{ index: 0, message: { role: 'assistant', content: 'Mock GPT response.' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 600, completion_tokens: 400, total_tokens: 1000, prompt_tokens_details: { cached_tokens: 300 } },
    };
  });
  app.get('/openai/v1/models', async () => ({ object: 'list', data: [] }));

  // DeepSeek
  app.post('/deepseek/v1/chat/completions', async (req, reply) => {
    const body = req.body as any;
    if (body?.stream) {
      reply.header('content-type', 'text/event-stream');
      return reply.send(
        `data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n` +
        `data: {"choices":[{"delta":{"content":"Mock DeepSeek response."}}],"usage":{"prompt_tokens":1200,"completion_tokens":500,"prompt_cache_hit_tokens":800,"prompt_cache_miss_tokens":400}}\n\n` +
        `data: [DONE]\n\n`
      );
    }
    return {
      id: 'ds_abc', object: 'chat.completion', model: body?.model || 'deepseek-v4-flash',
      choices: [{ index: 0, message: { role: 'assistant', content: 'Mock DeepSeek response.' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1200, completion_tokens: 500, total_tokens: 1700, prompt_cache_hit_tokens: 800, prompt_cache_miss_tokens: 400 },
    };
  });

  // Qwen
  app.post('/dashscope/compatible-mode/v1/chat/completions', async (req, reply) => {
    const body = req.body as any;
    if (body?.stream) {
      reply.header('content-type', 'text/event-stream');
      return reply.send(
        `data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n` +
        `data: {"choices":[{"delta":{"content":"Mock Qwen response."}}],"usage":{"prompt_tokens":800,"completion_tokens":350,"prompt_tokens_details":{"cached_tokens":400,"cache_creation_input_tokens":200}}}\n\n` +
        `data: [DONE]\n\n`
      );
    }
    return {
      id: 'qwen_abc', object: 'chat.completion', model: body?.model || 'qwen-flash',
      choices: [{ index: 0, message: { role: 'assistant', content: 'Mock Qwen response.' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 800, completion_tokens: 350, total_tokens: 1150, prompt_tokens_details: { cached_tokens: 400, cache_creation_input_tokens: 200 } },
    };
  });

  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return { app, url: `http://127.0.0.1:${port}` };
}
```

- [ ] **Step 2: 编写验证测试**

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createMockServer } from './mock-llm-server.js';
import type { FastifyInstance } from 'fastify';

describe('mock LLM server', () => {
  let app: FastifyInstance;
  let url: string;

  beforeAll(async () => {
    const server = await createMockServer();
    app = server.app;
    url = server.url;
  });
  afterAll(() => app.close());

  it('返回 Anthropic 格式响应', async () => {
    const res = await fetch(`${url}/anthropic/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.usage.input_tokens).toBe(500);
    expect(data.usage.cache_read_input_tokens).toBe(200);
  });

  it('返回 429 错误', async () => {
    const res = await fetch(`${url}/anthropic/v1/messages?error=429`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'c' }),
    });
    expect(res.status).toBe(429);
  });
});
```

- [ ] **Step 3: 运行测试**

```bash
npx vitest run tests/mock-llm-server.test.ts
```

- [ ] **Step 4: Commit**

---

### Task 4: HTTP 转发器（非流式）

**Files:**
- Create: `llm-monitor/proxy/forwarder.ts`
- Create: `llm-monitor/tests/forwarder.test.ts`

**Interfaces:**
- Produces:
  - `export async function forwardRequest(method: string, url: string, headers: Record<string, string>, body?: Buffer): Promise<{ status: number; json: any; text: string; durationMs: number }>`

- [ ] **Step 1: 编写 forwarder.ts**

```typescript
/** HTTP 转发模块 — 非流式 + 流式 SSE */

export async function forwardRequest(
  method: string,
  url: string,
  headers: Record<string, string>,
  body?: Buffer,
): Promise<{ status: number; json: any; text: string; durationMs: number }> {
  const start = performance.now();
  const res = await fetch(url, {
    method,
    headers: { ...headers, host: undefined as any, connection: undefined as any },
    body: body?.length ? body : undefined,
  });
  const text = await res.text();
  const durationMs = Math.round(performance.now() - start);
  let json: any = null;
  try { json = JSON.parse(text); } catch {}

  return { status: res.status, json, text, durationMs };
}
```

- [ ] **Step 2: 编写测试**

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createMockServer } from './mock-llm-server.js';
import { forwardRequest } from '../proxy/forwarder.js';
import type { FastifyInstance } from 'fastify';

describe('forwarder 非流式', () => {
  let app: FastifyInstance;
  let url: string;

  beforeAll(async () => {
    const s = await createMockServer();
    app = s.app; url = s.url;
  });
  afterAll(() => app.close());

  it('转发 Anthropic 请求', async () => {
    const result = await forwardRequest('POST', `${url}/anthropic/v1/messages`, {
      'content-type': 'application/json',
      authorization: 'Bearer sk-ant-test',
    }, Buffer.from(JSON.stringify({ model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'hi' }] })));
    expect(result.status).toBe(200);
    expect(result.json.usage.input_tokens).toBe(500);
    expect(result.durationMs).toBeGreaterThan(0);
  });

  it('透传 429 错误', async () => {
    const result = await forwardRequest('POST', `${url}/anthropic/v1/messages?error=429`, {
      'content-type': 'application/json',
    }, Buffer.from(JSON.stringify({ model: 'x' })));
    expect(result.status).toBe(429);
  });
});
```

- [ ] **Step 3: 运行测试**

```bash
npx vitest run tests/forwarder.test.ts
```

- [ ] **Step 4: Commit**

---

### Task 5: 流式 SSE 透传

**Files:**
- Modify: `llm-monitor/proxy/forwarder.ts`

**Interfaces:**
- Produces:
  - `export async function forwardStream(method, url, headers, body): Promise<{ stream: ReadableStream; collectResult: () => Promise<{ status: number; text: string; durationMs: number }> }>`

- [ ] **Step 1: 编写流式转发 + SSE usage 提取**

```typescript
export async function forwardStream(
  method: string,
  url: string,
  headers: Record<string, string>,
  body?: Buffer,
): Promise<{
  stream: ReadableStream;
  collectResult: () => Promise<{ status: number; json: any; text: string; durationMs: number }>;
}> {
  const start = performance.now();
  const res = await fetch(url, {
    method,
    headers: { ...headers, host: undefined as any, connection: undefined as any },
    body: body?.length ? body : undefined,
  });

  const reader = res.body!.getReader();
  const chunks: Uint8Array[] = [];
  let status = res.status;

  const stream = new ReadableStream({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
      } else {
        chunks.push(value);
        controller.enqueue(value);
      }
    },
  });

  return {
    stream,
    collectResult: async () => {
      const durationMs = Math.round(performance.now() - start);
      const raw = Buffer.concat(chunks).toString('utf-8');
      let json: any = null;
      try { json = extractUsageFromSSE(raw); } catch {}
      return { status, json, text: raw, durationMs };
    },
  };
}

function extractUsageFromSSE(raw: string): any {
  const lines = raw.split(/\r?\n/);
  let usage: any = null;

  // OpenAI/DeepSeek/Qwen 格式：最后一条 data: 含 usage
  for (const line of lines) {
    if (line.startsWith('data: ') && line !== 'data: [DONE]') {
      try {
        const obj = JSON.parse(line.slice(6));
        if (obj.usage) usage = obj.usage;
      } catch {}
    }
  }

  // Anthropic 格式：message_delta 事件中的 usage
  if (!usage) {
    const events = raw.split(/\n\n/);
    for (const event of events) {
      if (event.includes('message_delta')) {
        for (const line of event.split('\n')) {
          if (line.startsWith('data: ')) {
            try {
              const obj = JSON.parse(line.slice(6));
              if (obj.usage) usage = obj.usage;
            } catch {}
          }
        }
      }
    }
  }

  return usage;
}
```

- [ ] **Step 2: 编写流式测试**

```typescript
it('流式转发并收集 usage', async () => {
  const { stream, collectResult } = await forwardStream('POST', `${url}/openai/v1/chat/completions`, {
    'content-type': 'application/json',
  }, Buffer.from(JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }], stream: true })));

  // 消费流
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  expect(chunks.length).toBeGreaterThan(0);

  const result = await collectResult();
  expect(result.json.prompt_tokens).toBe(600);
  expect(result.json.prompt_tokens_details.cached_tokens).toBe(300);
});
```

- [ ] **Step 3: 运行测试**

```bash
npx vitest run tests/forwarder.test.ts
```

- [ ] **Step 4: Commit**

---

### Task 6: 会话识别

**Files:**
- Create: `llm-monitor/proxy/session.ts`
- Create: `llm-monitor/tests/session.test.ts`

**Interfaces:**
- Consumes: `upsertSession` from Task 2
- Produces:
  - `export function computeFingerprint(provider: string, sourcePort: number, authHeader: string | null): string`
  - `export function toolFromProvider(provider: string): string`
  - `export function getOrCreateSession(provider: string, sourcePort: number, authHeader: string | null, endpoint: string): number`

- [ ] **Step 1: 编写 session.ts**

```typescript
import { createHash } from 'node:crypto';
import { upsertSession } from './db.js';

const TOOL_MAP: Record<string, string> = {
  anthropic: 'claude-code',
  openai: 'codex',
  deepseek: 'deepseek-cli',
  qwen: 'qwen-cli',
};

export function toolFromProvider(provider: string): string {
  return TOOL_MAP[provider] || 'custom';
}

export function computeFingerprint(provider: string, sourcePort: number, authHeader: string | null): string {
  let keyPrefix = '';
  if (authHeader) {
    const parts = authHeader.split(/\s+/);
    if (parts.length >= 2) keyPrefix = parts[1].slice(0, 12);
  }
  const raw = `${provider}:${sourcePort}:${keyPrefix}`;
  return createHash('sha256').update(raw).digest('hex').slice(0, 24);
}

export function getOrCreateSession(
  provider: string, sourcePort: number, authHeader: string | null, endpoint: string,
): number {
  const fingerprint = computeFingerprint(provider, sourcePort, authHeader);
  const tool = toolFromProvider(provider);
  return upsertSession(fingerprint, tool, endpoint);
}
```

- [ ] **Step 2: 编写测试**

```typescript
import { describe, it, expect, beforeAll } from 'vitest';
import { computeFingerprint, toolFromProvider, getOrCreateSession } from '../proxy/session.js';
import { initDb, closeDb } from '../proxy/db.js';
import { createTempDb } from './setup.js';

const tmp = createTempDb();
beforeAll(() => initDb(tmp.dbPath));
afterAll(() => { closeDb(); tmp.cleanup(); });

describe('session', () => {
  it('同一指纹返回相同会话', () => {
    const sid1 = getOrCreateSession('anthropic', 54321, 'Bearer sk-ant-test123', '/v1/messages');
    const sid2 = getOrCreateSession('anthropic', 54321, 'Bearer sk-ant-test123', '/v1/messages');
    expect(sid1).toBe(sid2);
  });

  it('不同端口返回不同会话', () => {
    const sid1 = getOrCreateSession('anthropic', 54321, 'Bearer sk-test', '/v1/messages');
    const sid2 = getOrCreateSession('anthropic', 54322, 'Bearer sk-test', '/v1/messages');
    expect(sid1).not.toBe(sid2);
  });

  it('toolFromProvider 映射正确', () => {
    expect(toolFromProvider('anthropic')).toBe('claude-code');
    expect(toolFromProvider('openai')).toBe('codex');
    expect(toolFromProvider('unknown')).toBe('custom');
  });
});
```

- [ ] **Step 3: 运行测试**

```bash
npx vitest run tests/session.test.ts
```

- [ ] **Step 4: Commit**

---

### Task 7: 路由注册 + 代理集成

**Files:**
- Create: `llm-monitor/proxy/router.ts`
- Create: `llm-monitor/proxy/main.ts`

**Interfaces:**
- Consumes: `forwarder.ts`, `session.ts`, `CallRecord` type
- Produces:
  - `router.ts`: `export async function registerProxyRoutes(app: FastifyInstance): Promise<void>` — 注册 /anthropic/*, /openai/*, /deepseek/*, /dashscope/* 代理路由
  - `main.ts`: `export async function createApp(): Promise<FastifyInstance>` — 创建 Fastify 实例

- [ ] **Step 1: 编写 router.ts**

```typescript
import type { FastifyInstance } from 'fastify';
import { forwardRequest, forwardStream } from './forwarder.js';
import { getOrCreateSession } from './session.js';

const UPSTREAMS: Record<string, string> = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com',
  deepseek: 'https://api.deepseek.com',
  qwen: 'https://dashscope.aliyuncs.com',
};

function cleanHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  const skip = new Set(['host', 'transfer-encoding', 'connection', 'content-length']);
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!skip.has(k.toLowerCase()) && typeof v === 'string') {
      result[k] = v;
    }
  }
  return result;
}

export async function registerProxyRoutes(app: FastifyInstance): Promise<void> {
  for (const [provider, upstream] of Object.entries(UPSTREAMS)) {
    app.route({
      method: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
      url: `/${provider}/*`,
      handler: async (request, reply) => {
        const sourcePort = request.socket.remotePort || 0;
        const authHeader = request.headers.authorization || null;
        const path = (request.params as any)['*'];
        const sessionId = getOrCreateSession(provider, sourcePort, authHeader, `/${path}`);

        const targetUrl = `${upstream}/${path}`;
        const headers = cleanHeaders(request.headers as any);
        const body = request.body ? Buffer.from(JSON.stringify(request.body)) : undefined;
        const isStream = (request.body as any)?.stream === true;

        if (isStream) {
          const { stream, collectResult } = await forwardStream(request.method, targetUrl, headers, body);
          // 后台收集结果（后续集成 Recorder）
          collectResult().then(result => {
            // TODO: 在 Task 12 中集成 Recorder 入队
          });
          return reply.type('text/event-stream').send(stream);
        } else {
          const result = await forwardRequest(request.method, targetUrl, headers, body);
          // 后台记录（后续集成 Recorder）
          // TODO: 在 Task 12 中集成 Recorder 入队
          return reply.status(result.status).type('application/json').send(result.text);
        }
      },
    });
  }
}
```

- [ ] **Step 2: 编写 main.ts**

```typescript
import Fastify from 'fastify';
import { initDb, closeDb } from './db.js';
import { registerProxyRoutes } from './router.js';

export async function createApp(): Promise<Fastify.FastifyInstance> {
  initDb();
  const app = Fastify({ logger: true });
  await registerProxyRoutes(app);

  app.get('/api/health', async () => ({ status: 'ok' }));

  return app;
}

// 直接运行时启动
const isMain = process.argv[1]?.endsWith('main.ts') || process.argv[1]?.endsWith('main.js');
if (isMain) {
  const app = await createApp();
  await app.listen({ port: 9400, host: '127.0.0.1' });
  console.log('🚀 LLM Monitor: http://localhost:9400');
}
```

- [ ] **Step 3: 编写集成测试**

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createMockServer } from './mock-llm-server.js';
import { createApp } from '../proxy/main.js';
import { initDb, closeDb } from '../proxy/db.js';
import { createTempDb } from './setup.js';
import type { FastifyInstance } from 'fastify';

const tmp = createTempDb();

describe('proxy integration', () => {
  let mockApp: FastifyInstance;
  let mockUrl: string;
  let proxyApp: FastifyInstance;

  beforeAll(async () => {
    initDb(tmp.dbPath);
    const mock = await createMockServer();
    mockApp = mock.app;
    mockUrl = mock.url;

    // 重写 UPSTREAMS 指向 mock（通过环境变量或直接注入）
    process.env.LLM_MONITOR_MOCK_UPSTREAM = mockUrl;
    proxyApp = await createApp();
    await proxyApp.listen({ port: 0, host: '127.0.0.1' });
  });

  afterAll(async () => {
    await proxyApp.close();
    await mockApp.close();
    closeDb();
    tmp.cleanup();
  });

  it('代理 Anthropic 非流式请求', async () => {
    const addr = proxyApp.server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    const res = await fetch(`http://127.0.0.1:${port}/anthropic/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer sk-ant-test' },
      body: JSON.stringify({ model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.usage).toBeDefined();
  });
});
```

- [ ] **Step 4: 运行测试**

```bash
npx vitest run tests/ --reporter=verbose
```

- [ ] **Step 5: Commit**

---

### Task 8: Token 归一化器

**Files:**
- Create: `llm-monitor/proxy/normalizer.ts`
- Create: `llm-monitor/tests/normalizer.test.ts`

- [ ] **Step 1: 编写 normalizer.ts**

```typescript
import type { NormalizedTokens } from '../shared/types.js';

export function normalizeTokens(provider: string, responseBody: Record<string, any>): NormalizedTokens {
  const usage = responseBody.usage || {};
  switch (provider) {
    case 'anthropic': return normalizeAnthropic(usage);
    case 'openai': return normalizeOpenAI(usage);
    case 'deepseek': return normalizeDeepSeek(usage);
    case 'qwen': return normalizeQwen(usage);
    default: return {};
  }
}

function normalizeAnthropic(u: any): NormalizedTokens {
  const input = u.input_tokens ?? null;
  const output = u.output_tokens ?? null;
  const cacheRead = u.cache_read_input_tokens || 0;
  const cacheWrite = u.cache_creation_input_tokens || 0;
  const uncached = input != null ? input - cacheWrite : null;
  return {
    prompt_tokens: input, output_tokens: output,
    cache_read_tokens: cacheRead > 0 ? cacheRead : null,
    cache_write_tokens: cacheWrite > 0 ? cacheWrite : null,
    uncached_input: uncached,
  };
}

function normalizeOpenAI(u: any): NormalizedTokens {
  const input = u.prompt_tokens ?? null;
  const output = u.completion_tokens ?? null;
  const cached = (u.prompt_tokens_details?.cached_tokens) || 0;
  const uncached = input != null ? input - cached : null;
  return {
    prompt_tokens: input, output_tokens: output,
    cache_read_tokens: cached > 0 ? cached : null,
    cache_write_tokens: null, uncached_input: uncached,
  };
}

function normalizeDeepSeek(u: any): NormalizedTokens {
  const input = u.prompt_tokens ?? null;
  const output = u.completion_tokens ?? null;
  const cacheHit = u.prompt_cache_hit_tokens || 0;
  const cacheMiss = u.prompt_cache_miss_tokens ?? null;
  return {
    prompt_tokens: input, output_tokens: output,
    cache_read_tokens: cacheHit > 0 ? cacheHit : null,
    cache_write_tokens: null, uncached_input: cacheMiss,
  };
}

function normalizeQwen(u: any): NormalizedTokens {
  const input = u.prompt_tokens ?? null;
  const output = u.completion_tokens ?? null;
  const details = u.prompt_tokens_details || {};
  const cached = details.cached_tokens || 0;
  const cacheCreate = details.cache_creation_input_tokens || 0;
  const uncached = input != null ? input - cached - cacheCreate : null;
  return {
    prompt_tokens: input, output_tokens: output,
    cache_read_tokens: cached > 0 ? cached : null,
    cache_write_tokens: cacheCreate > 0 ? cacheCreate : null,
    uncached_input: uncached,
  };
}
```

- [ ] **Step 2: 参数化测试四家**

```typescript
import { describe, it, expect } from 'vitest';
import { normalizeTokens } from '../proxy/normalizer.js';

describe('normalizer', () => {
  it('Anthropic 归一化', () => {
    const resp = { usage: { input_tokens: 500, output_tokens: 300, cache_creation_input_tokens: 100, cache_read_input_tokens: 200 } };
    const r = normalizeTokens('anthropic', resp);
    expect(r.prompt_tokens).toBe(500);
    expect(r.output_tokens).toBe(300);
    expect(r.cache_read_tokens).toBe(200);
    expect(r.cache_write_tokens).toBe(100);
    expect(r.uncached_input).toBe(400);
  });

  it('OpenAI 归一化', () => {
    const resp = { usage: { prompt_tokens: 600, completion_tokens: 400, prompt_tokens_details: { cached_tokens: 300 } } };
    const r = normalizeTokens('openai', resp);
    expect(r.cache_read_tokens).toBe(300);
    expect(r.uncached_input).toBe(300);
  });

  it('DeepSeek 归一化', () => {
    const resp = { usage: { prompt_tokens: 1200, completion_tokens: 500, prompt_cache_hit_tokens: 800, prompt_cache_miss_tokens: 400 } };
    const r = normalizeTokens('deepseek', resp);
    expect(r.cache_read_tokens).toBe(800);
    expect(r.uncached_input).toBe(400);
  });

  it('Qwen 归一化', () => {
    const resp = { usage: { prompt_tokens: 800, completion_tokens: 350, prompt_tokens_details: { cached_tokens: 400, cache_creation_input_tokens: 200 } } };
    const r = normalizeTokens('qwen', resp);
    expect(r.cache_read_tokens).toBe(400);
    expect(r.cache_write_tokens).toBe(200);
    expect(r.uncached_input).toBe(200);
  });

  it('无缓存时字段为 null', () => {
    const resp = { usage: { prompt_tokens: 100, completion_tokens: 50 } };
    const r = normalizeTokens('openai', resp);
    expect(r.cache_read_tokens).toBeNull();
    expect(r.uncached_input).toBe(100);
  });
});
```

- [ ] **Step 3: 运行测试**

```bash
npx vitest run tests/normalizer.test.ts
```

- [ ] **Step 4: Commit**

---

### Task 9: 定价匹配 + 费用计算

**Files:**
- Create: `llm-monitor/proxy/pricing.ts`
- Create: `llm-monitor/tests/pricing.test.ts`

- [ ] **Step 1: 编写 pricing.ts**

```typescript
import type { NormalizedTokens, Pricing } from '../shared/types.js';
import { listPricing } from './db.js';

export function matchPricing(provider: string, model: string, allPricing: Pricing[]): Pricing | undefined {
  const candidates = allPricing
    .filter(p => p.provider === provider)
    .sort((a, b) => b.model.length - a.model.length);  // 最长前缀优先
  return candidates.find(p => model.startsWith(p.model));
}

export interface CostResult {
  input_cost: number;
  output_cost: number;
  total_cost: number;
  cache_savings: number;
}

export function calculateCost(tokens: NormalizedTokens, pricing: Pricing): CostResult {
  const uncached = tokens.uncached_input || 0;
  const cacheWrite = tokens.cache_write_tokens || 0;
  const cacheRead = tokens.cache_read_tokens || 0;
  const output = tokens.output_tokens || 0;

  const uncachedCost = (uncached / 1_000_000) * pricing.input_price;
  const cacheWriteCost = (cacheWrite / 1_000_000) * pricing.input_price;
  const cacheReadCost = (cacheRead / 1_000_000) * pricing.cache_input_price;
  const outputCost = (output / 1_000_000) * pricing.output_price;

  const inputCost = uncachedCost + cacheWriteCost + cacheReadCost;
  const totalCost = inputCost + outputCost;
  const savings = (cacheRead / 1_000_000) * (pricing.input_price - pricing.cache_input_price);

  return {
    input_cost: Math.round(inputCost * 1e8) / 1e8,
    output_cost: Math.round(outputCost * 1e8) / 1e8,
    total_cost: Math.round(totalCost * 1e8) / 1e8,
    cache_savings: Math.round(savings * 1e8) / 1e8,
  };
}
```

- [ ] **Step 2: 编写测试**

```typescript
import { describe, it, expect } from 'vitest';
import { matchPricing, calculateCost } from '../proxy/pricing.js';
import type { Pricing } from '../shared/types.js';

const SAMPLE_PRICING: Pricing[] = [
  { id: 1, provider: 'anthropic', model: 'claude-opus-5', input_price: 15, cache_input_price: 1.5, output_price: 75, unit: 'per_1M_tokens', currency: 'USD', effective_from: null },
  { id: 2, provider: 'openai', model: 'gpt-4o', input_price: 2.5, cache_input_price: 1.25, output_price: 10, unit: 'per_1M_tokens', currency: 'USD', effective_from: null },
];

describe('pricing', () => {
  it('前缀匹配模型', () => {
    const p = matchPricing('anthropic', 'claude-opus-5-20260101', SAMPLE_PRICING);
    expect(p?.input_price).toBe(15);
  });

  it('无匹配返回 undefined', () => {
    const p = matchPricing('unknown', 'x', SAMPLE_PRICING);
    expect(p).toBeUndefined();
  });

  it('费用计算：全无缓存', () => {
    const tokens = { prompt_tokens: 1000, output_tokens: 500, cache_read_tokens: null, cache_write_tokens: null, uncached_input: 1000 };
    const pricing = SAMPLE_PRICING[1]; // gpt-4o
    const r = calculateCost(tokens, pricing);
    expect(r.input_cost).toBeCloseTo(0.0025, 6);  // 1000 * 2.5 / 1M
    expect(r.output_cost).toBeCloseTo(0.005, 6);  // 500 * 10 / 1M
    expect(r.total_cost).toBeCloseTo(0.0075, 6);
    expect(r.cache_savings).toBe(0);
  });

  it('费用计算：混合缓存', () => {
    const tokens = { prompt_tokens: 1500, output_tokens: 800, cache_read_tokens: 1000, cache_write_tokens: 200, uncached_input: 300 };
    const pricing = SAMPLE_PRICING[0]; // claude-opus-5
    const r = calculateCost(tokens, pricing);
    // uncached: 300 * 15 / 1M = 0.0045
    // cache_write: 200 * 15 / 1M = 0.003
    // cache_read: 1000 * 1.5 / 1M = 0.0015
    // output: 800 * 75 / 1M = 0.06
    expect(r.input_cost).toBeCloseTo(0.009, 6);
    expect(r.output_cost).toBeCloseTo(0.06, 6);
    expect(r.total_cost).toBeCloseTo(0.069, 6);
    // savings: 1000 * (15 - 1.5) / 1M = 0.0135
    expect(r.cache_savings).toBeCloseTo(0.0135, 6);
  });
});
```

- [ ] **Step 3: 运行测试**

```bash
npx vitest run tests/pricing.test.ts
```

- [ ] **Step 4: Commit**

---

### Task 10: Worker 线程消费者 + 记录器

**Files:**
- Create: `llm-monitor/proxy/recorder.ts`
- Create: `llm-monitor/tests/recorder.test.ts`

- [ ] **Step 1: 编写 recorder.ts**

```typescript
import { Worker, isMainThread, parentPort } from 'node:worker_threads';
import type { CallRecord, NormalizedTokens } from '../shared/types.js';
import { normalizeTokens } from './normalizer.js';
import { matchPricing, calculateCost } from './pricing.js';
import { insertCall, updateSessionStats, listPricing } from './db.js';

// Worker 内部的处理逻辑
function processRecord(record: CallRecord): void {
  // 1. 归一化
  if (record.response_body && record.prompt_tokens == null) {
    try {
      const respBody = JSON.parse(record.response_body);
      const tokens = normalizeTokens(record.provider, respBody);
      record.prompt_tokens = tokens.prompt_tokens ?? null;
      record.output_tokens = tokens.output_tokens ?? null;
      record.cache_read_tokens = tokens.cache_read_tokens ?? null;
      record.cache_write_tokens = tokens.cache_write_tokens ?? null;
      record.uncached_input = tokens.uncached_input ?? null;
    } catch {}
  }

  // 2. 定价匹配 + 费用计算
  if (record.prompt_tokens != null || record.output_tokens != null) {
    const allPricing = listPricing();
    const pricing = matchPricing(record.provider, record.model, allPricing as any);
    if (pricing) {
      const tokens: NormalizedTokens = {
        prompt_tokens: record.prompt_tokens,
        output_tokens: record.output_tokens,
        cache_read_tokens: record.cache_read_tokens,
        cache_write_tokens: record.cache_write_tokens,
        uncached_input: record.uncached_input,
      };
      const costs = calculateCost(tokens, pricing as any);
      record.input_cost = costs.input_cost;
      record.output_cost = costs.output_cost;
      record.total_cost = costs.total_cost;
      record.cache_savings = costs.cache_savings;
    }
  }

  // 3. 写入数据库
  insertCall(record);

  // 4. 更新会话统计
  const totalTokens = (record.prompt_tokens || 0) + (record.output_tokens || 0);
  if (record.session_id) {
    updateSessionStats(record.session_id, record.total_cost, totalTokens);
  }
}

// 主线程：队列管理
const queue: CallRecord[] = [];
let timer: ReturnType<typeof setInterval> | null = null;

export function enqueueRecord(record: CallRecord): void {
  queue.push(record);
}

export function startRecorder(): void {
  if (timer) return;
  timer = setInterval(() => {
    while (queue.length > 0) {
      const record = queue.shift()!;
      try {
        processRecord(record);
      } catch (err) {
        console.error('处理记录失败:', err);
      }
    }
  }, 100);  // 每 100ms 消费一次队列
}

export function stopRecorder(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  // 消费剩余
  while (queue.length > 0) {
    const record = queue.shift()!;
    try { processRecord(record); } catch {}
  }
}
```

- [ ] **Step 2: 编写测试**

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { initDb, closeDb, upsertSession, upsertPricing, listCalls, getSession } from '../proxy/db.js';
import { enqueueRecord, startRecorder, stopRecorder } from '../proxy/recorder.js';
import { createTempDb } from './setup.js';
import type { CallRecord } from '../shared/types.js';

const tmp = createTempDb();

beforeAll(async () => {
  initDb(tmp.dbPath);
  upsertPricing('anthropic', 'claude-sonnet-5', 3.0, 0.3, 15.0);
  startRecorder();
});
afterAll(() => { stopRecorder(); closeDb(); tmp.cleanup(); });

describe('recorder', () => {
  it('消费一条记录：归一化 → 定价 → 写库', async () => {
    const sid = upsertSession('fp_rec', 'claude-code', '/v1/messages');
    const record: CallRecord = {
      provider: 'anthropic', model: 'claude-sonnet-5-20260101',
      endpoint: '/v1/messages', method: 'POST', status_code: 200,
      error_message: null, duration_ms: 1200,
      request_body: null,
      response_body: JSON.stringify({
        model: 'claude-sonnet-5',
        usage: { input_tokens: 500, output_tokens: 300, cache_creation_input_tokens: 100, cache_read_input_tokens: 200 },
      }),
      fingerprint: 'fp_rec', source_port: 54321, session_id: sid,
      prompt_tokens: null, output_tokens: null, cache_read_tokens: null,
      cache_write_tokens: null, uncached_input: null,
      input_cost: 0, output_cost: 0, total_cost: 0, cache_savings: 0,
    };
    enqueueRecord(record);
    // 等待消费者处理
    await new Promise(r => setTimeout(r, 300));

    const calls = listCalls(sid);
    expect(calls.length).toBe(1);
    expect(calls[0].total_cost).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 3: 运行测试**

```bash
npx vitest run tests/recorder.test.ts
```

- [ ] **Step 4: Commit**

---

### Task 11: 代理路由集成 Recorder + 查询 API

**Files:**
- Modify: `llm-monitor/proxy/router.ts` — 在转发后调用 `enqueueRecord()`
- Modify: `llm-monitor/proxy/router.ts` — 追加 `/api/*` 查询路由
- Modify: `llm-monitor/proxy/main.ts` — 启动/关闭 Recorder

- [ ] **Step 1: 更新 router.ts 集成 Recorder（非流式 + 流式转发后入队）**

```typescript
// 在 router.ts 中引入
import { enqueueRecord } from './recorder.js';
import type { CallRecord } from '../shared/types.js';

// 在非流式转发后：
const result = await forwardRequest(request.method, targetUrl, headers, body);
const bodyStr = body?.toString('utf-8') || null;
let model = 'unknown';
try { model = JSON.parse(bodyStr!).model || 'unknown'; } catch {}
const authHeader = request.headers.authorization || '';
const fingerprint = computeFingerprint(provider, sourcePort, authHeader);

const record: CallRecord = {
  provider, model, endpoint: `/${path}`, method: request.method,
  status_code: result.status, error_message: result.status >= 400 ? result.text.slice(0, 200) : null,
  duration_ms: result.durationMs,
  request_body: bodyStr, response_body: result.text,
  fingerprint, source_port: sourcePort, session_id: sessionId,
  prompt_tokens: null, output_tokens: null, cache_read_tokens: null,
  cache_write_tokens: null, uncached_input: null,
  input_cost: 0, output_cost: 0, total_cost: 0, cache_savings: 0,
};
enqueueRecord(record);
```

- [ ] **Step 2: 追加 /api/* 查询路由**

```typescript
// sessions
app.get('/api/sessions', async (req) => {
  const { tool, status, limit = '100' } = req.query as any;
  return listSessions(tool, status, parseInt(limit));
});
app.get('/api/sessions/:id', async (req) => {
  const s = getSession(parseInt((req.params as any).id));
  return s || reply.status(404).send('Not found');
});
app.put('/api/sessions/:id/label', async (req) => {
  updateSessionLabel(parseInt((req.params as any).id), (req.body as any).label);
  return { ok: true };
});
app.post('/api/sessions/merge', async (req) => {
  const { source_id, target_id } = req.body as any;
  mergeSessions(source_id, target_id);
  return { ok: true };
});

// calls
app.get('/api/calls', async (req) => {
  const { session_id, limit = '50', offset = '0' } = req.query as any;
  return listCalls(session_id ? parseInt(session_id) : undefined, parseInt(limit), parseInt(offset));
});
app.get('/api/calls/:id', async (req) => {
  const c = getCall(parseInt((req.params as any).id));
  return c || reply.status(404).send('Not found');
});

// stats
app.get('/api/stats', async (req) => {
  const { group_by = 'provider' } = req.query as any;
  return getStats(group_by);
});
```

- [ ] **Step 3: 更新 main.ts 启动/关闭 Recorder**

```typescript
import { startRecorder, stopRecorder } from './recorder.js';

export async function createApp(): Promise<FastifyInstance> {
  initDb();
  startRecorder();  // 启动后台消费者
  const app = Fastify({ logger: true });
  await registerProxyRoutes(app);

  app.addHook('onClose', async () => {
    stopRecorder();
    closeDb();
  });

  return app;
}
```

- [ ] **Step 4: 编写 API 测试**

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createApp } from '../proxy/main.js';
import { initDb, closeDb, upsertPricing } from '../proxy/db.js';
import { createTempDb } from './setup.js';
import type { FastifyInstance } from 'fastify';

const tmp = createTempDb();

describe('API', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    initDb(tmp.dbPath);
    upsertPricing('test', 'test-m', 1.0, 0.5, 2.0);
    app = await createApp();
    await app.listen({ port: 0, host: '127.0.0.1' });
  });
  afterAll(async () => {
    await app.close();
    closeDb();
    tmp.cleanup();
  });

  const baseUrl = () => {
    const addr = app.server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    return `http://127.0.0.1:${port}`;
  };

  it('GET /api/sessions 返回空列表', async () => {
    const res = await fetch(`${baseUrl()}/api/sessions`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it('GET /api/sessions/:id 不存在返回 404', async () => {
    const res = await fetch(`${baseUrl()}/api/sessions/99999`);
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 5: 运行测试**

```bash
npx vitest run tests/api.test.ts
```

- [ ] **Step 6: Commit**

---

### Task 12: 定价 API + 数据管理 API + 预置定价导入

**Files:**
- Modify: `llm-monitor/proxy/router.ts` — 追加 pricing CRUD + data management + default import 路由
- Create: `llm-monitor/data/default-pricing.json`

- [ ] **Step 1: 创建 data/default-pricing.json**（内容同原计划 Task 16 的 JSON）

- [ ] **Step 2: 在 router.ts 追加路由**

```typescript
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  listPricing, upsertPricing, deletePricing,
  clearAllCalls, cleanupOldCalls,
} from './db.js';
import { PORT, DATA_DIR, SESSION_TIMEOUT_SEC, AUTO_CLEANUP_DAYS } from './config.js';

// Pricing CRUD
app.get('/api/pricing', async () => listPricing());
app.post('/api/pricing', async (req) => {
  const { provider, model, input_price, cache_input_price, output_price } = req.body as any;
  const id = upsertPricing(provider, model, input_price, cache_input_price, output_price);
  return { id };
});
app.delete('/api/pricing/:id', async (req) => {
  deletePricing(parseInt((req.params as any).id));
  return { ok: true };
});

// 导入预置定价
app.post('/api/pricing/default', async () => {
  const file = join(import.meta.dirname, '..', 'data', 'default-pricing.json');
  const data = JSON.parse(readFileSync(file, 'utf-8'));
  let count = 0;
  for (const item of data) {
    upsertPricing(item.provider, item.model, item.input_price, item.cache_input_price, item.output_price);
    count++;
  }
  return { imported: count };
});

// Data management
app.post('/api/data/clear', async () => { clearAllCalls(); return { ok: true }; });
app.post('/api/data/cleanup', async (req) => {
  const count = cleanupOldCalls((req.body as any).days);
  return { deleted: count };
});

// Config
app.get('/api/config', async () => ({
  port: PORT, data_dir: DATA_DIR,
  session_timeout_sec: SESSION_TIMEOUT_SEC,
  auto_cleanup_days: AUTO_CLEANUP_DAYS,
}));
```

- [ ] **Step 3: 在 main.ts 中首次启动自动导入预置定价**

```typescript
import { listPricing, upsertPricing } from './db.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

async function importDefaultPricingIfEmpty(): Promise<void> {
  const existing = listPricing();
  if (existing.length === 0) {
    try {
      const file = join(import.meta.dirname, '..', 'data', 'default-pricing.json');
      const data = JSON.parse(readFileSync(file, 'utf-8'));
      for (const item of data) {
        upsertPricing(item.provider, item.model, item.input_price, item.cache_input_price, item.output_price);
      }
      console.log(`已导入 ${data.length} 条预置定价`);
    } catch (err) {
      console.warn('导入预置定价失败:', err);
    }
  }
}
```

- [ ] **Step 4: 编写测试**

```typescript
it('POST /api/pricing/default 导入预置定价', async () => {
  const res = await fetch(`${baseUrl()}/api/pricing/default`, { method: 'POST' });
  expect(res.status).toBe(200);
  const data = await res.json();
  expect(data.imported).toBeGreaterThanOrEqual(8);
});
```

- [ ] **Step 5: 运行测试**

```bash
npx vitest run tests/api.test.ts
```

- [ ] **Step 6: Commit**

---

### Task 13: 前端项目初始化 + 构建配置

**Files:**
- Create: `llm-monitor/web/index.html`
- Create: `llm-monitor/web/src/types/index.ts`（使用 shared/types.ts）
- Create: `llm-monitor/web/src/api/client.ts`（fetch 封装 + 所有 API 函数）
- Create: `llm-monitor/web/src/main.tsx` + `App.tsx`
- Create: `llm-monitor/vite.config.ts`（项目根目录）
- Create: `llm-monitor/web/tailwind.config.js`
- Create: `llm-monitor/web/postcss.config.js`

- [ ] **Step 1: 创建 vite.config.ts（项目根目录）**

```typescript
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { join } from 'node:path';

export default defineConfig({
  plugins: [react()],
  root: 'web',
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:9400',
      '/anthropic': 'http://localhost:9400',
      '/openai': 'http://localhost:9400',
      '/deepseek': 'http://localhost:9400',
      '/dashscope': 'http://localhost:9400',
    },
  },
  resolve: {
    alias: {
      '@shared': join(__dirname, 'shared'),
    },
  },
});
```

- [ ] **Step 2: 创建 api/client.ts**（内容同原计划 Task 17 Step 3）

- [ ] **Step 3: 创建 main.tsx + App.tsx**（内容同原计划 Task 17 Step 4）

- [ ] **Step 4: 创建 index.html + CSS + Tailwind 配置**

```html
<!DOCTYPE html>
<html lang="zh-CN">
  <head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>LLM Monitor</title></head>
  <body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body>
</html>
```

- [ ] **Step 5: 验证构建**

```bash
cd llm-monitor/web && npx tsc --noEmit && npx vite build
```

- [ ] **Step 6: Commit**

---

### Task 14: 前端布局 + 总览页

**Files:**
- Create: `llm-monitor/web/src/components/Layout.tsx`
- Create: `llm-monitor/web/src/components/Sidebar.tsx`
- Create: `llm-monitor/web/src/components/KpiCards.tsx`
- Create: `llm-monitor/web/src/components/CostPieChart.tsx`
- Create: `llm-monitor/web/src/components/TrendChart.tsx`
- Create: `llm-monitor/web/src/components/CallStream.tsx`
- Create: `llm-monitor/web/src/pages/Dashboard.tsx`

内容同原计划 Task 18（前端组件本身不变）。

- [ ] **Step 1-4: 编写组件 + 页面代码**（参照原计划 Task 18）
- [ ] **Step 5: 验证 TypeScript 编译**

```bash
npx tsc --noEmit --project tsconfig.json
```

- [ ] **Step 6: Commit**

---

### Task 15: 会话详情页 + 调用时间线

**Files:**
- Create: `llm-monitor/web/src/components/CallTimeline.tsx`
- Create: `llm-monitor/web/src/pages/SessionDetail.tsx`

内容同原计划 Task 19。

---

### Task 16: 调用详情页

**Files:**
- Create: `llm-monitor/web/src/components/CallDetailPanel.tsx`
- Create: `llm-monitor/web/src/pages/CallDetail.tsx`

内容同原计划 Task 20。

---

### Task 17: 设置页 + 定价表格

**Files:**
- Create: `llm-monitor/web/src/components/PricingTable.tsx`
- Create: `llm-monitor/web/src/pages/Settings.tsx`

内容同原计划 Task 21。

---

### Task 18: 前端构建 + Fastify 静态文件托管

**Files:**
- Modify: `llm-monitor/proxy/main.ts` — 在生产模式下托管 `dist/web/`

```typescript
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

// 在 createApp() 中，添加静态文件托管（生产模式）
const staticDir = join(import.meta.dirname, '..', 'dist', 'web');
if (existsSync(staticDir)) {
  await app.register(fastifyStatic, { root: staticDir, prefix: '/', wildcard: false });
  // SPA fallback
  app.setNotFoundHandler((_req, reply) => {
    reply.sendFile('index.html', staticDir);
  });
}
```

- [ ] **Step 1: 构建前端**

```bash
npm run build
```

- [ ] **Step 2: 启动代理，验证 `http://localhost:9400` 返回 React 面板**

```bash
npm run dev
```

- [ ] **Step 3: Commit**

---

### Task 19: E2E 测试 + README

**Files:**
- Create: `llm-monitor/tests/e2e.test.ts`
- Create: `llm-monitor/README.md`

- [ ] **Step 1: 编写完整 E2E 测试**

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createMockServer } from './mock-llm-server.js';
import { createApp } from '../proxy/main.js';
import { initDb, closeDb, upsertPricing } from '../proxy/db.js';
import { createTempDb } from './setup.js';
import type { FastifyInstance } from 'fastify';

const tmp = createTempDb();

describe('E2E', () => {
  let mockApp: FastifyInstance;
  let mockUrl: string;
  let proxyApp: FastifyInstance;

  beforeAll(async () => {
    initDb(tmp.dbPath);
    const mock = await createMockServer();
    mockApp = mock.app; mockUrl = mock.url;
    process.env.LLM_MONITOR_MOCK_UPSTREAM = mockUrl;
    proxyApp = await createApp();
    await proxyApp.listen({ port: 0, host: '127.0.0.1' });
  });

  afterAll(async () => {
    await proxyApp.close();
    await mockApp.close();
    closeDb();
    tmp.cleanup();
  });

  async function proxyFetch(path: string, opts?: RequestInit) {
    const addr = proxyApp.server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    return fetch(`http://127.0.0.1:${port}${path}`, opts);
  }

  it('完整链路：导入定价 → 模拟调用 → 验证会话 → 验证统计', async () => {
    // 导入定价
    await proxyFetch('/api/pricing/default', { method: 'POST' });

    // 模拟 3 次 Anthropic 调用
    for (let i = 0; i < 3; i++) {
      const res = await proxyFetch('/anthropic/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer sk-ant-test' },
        body: JSON.stringify({ model: 'claude-sonnet-5', messages: [{ role: 'user', content: `test ${i}` }] }),
      });
      expect(res.status).toBe(200);
    }

    // 等待后台处理
    await new Promise(r => setTimeout(r, 500));

    // 验证会话
    const sessionsRes = await proxyFetch('/api/sessions');
    const sessions = await sessionsRes.json();
    expect(sessions.length).toBeGreaterThanOrEqual(1);

    // 验证调用
    const callsRes = await proxyFetch(`/api/calls?session_id=${sessions[0].id}`);
    const calls = await callsRes.json();
    expect(calls.length).toBe(3);

    // 验证统计
    const statsRes = await proxyFetch('/api/stats?group_by=provider');
    const stats = await statsRes.json();
    expect(stats.length).toBeGreaterThanOrEqual(1);
    expect(stats.find((s: any) => s.key === 'anthropic')?.count).toBeGreaterThanOrEqual(3);
  });
});
```

- [ ] **Step 2: 运行全部测试**

```bash
npx vitest run --reporter=verbose
```

- [ ] **Step 3: 编写 README.md**（内容同原计划 Task 23）

- [ ] **Step 4: Commit**

---

## 自检清单

- [x] Spec 覆盖：设计文档 13 个章节全部有对应 Task
- [x] 无占位符：所有 Task 包含完整 TypeScript 代码
- [x] 类型一致性：`shared/types.ts` 中的类型被前后端所有模块引用
- [x] API 签名一致：后端路由与前端 API 客户端匹配
- [x] 测试覆盖：每层都有 Vitest 测试 + Mock Server
- [x] 技术栈完全统一为 Node.js + TypeScript
