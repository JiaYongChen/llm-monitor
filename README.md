# LLM Monitor

本地 LLM API 调用监控工具 — 代理拦截 CLI 工具的 API 请求，实时记录调用详情、自动计费、Web 面板可视化。

## 快速开始

```bash
cd llm-monitor
npm install

# 开发模式（单端口 :9400，含 HMR）
npm run dev

# 生产模式
npm run build
npx tsx proxy/main.ts
```

代理 + 面板：`http://localhost:9400`

## 对接 CLI 工具

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

设置后正常使用 CLI 工具，API 调用自动经过代理并被记录。

## 功能

### 调用拦截与记录
- 透明代理转发（含 SSE 流式），无侵入
- 自动解析请求/响应中的 Token 用量（支持 Anthropic / OpenAI / DeepSeek 格式）
- 缓存读写拆分：未缓存输入、缓存写入、缓存命中分别统计

### 会话管理
- 三元组指纹识别：provider + 源端口 + API Key 前缀
- 自动会话聚合，支持手动合并 / 标签编辑
- 会话级上游供应商覆盖

### 费用计算
- 可编辑的多币种模型定价表（CNY / USD / EUR / JPY / GBP）
- 定价按供应商 + 模型前缀匹配，支持自定义定价
- 非 CNY 定价自动按汇率换算为 CNY 存储
- 前端展示按用户选择币种实时换算

### 汇率管理
- Frankfurter API 每日 09:30（北京时间）自动刷新
- 失败时使用上次缓存，无缓存时使用内置兜底汇率
- 支持手动刷新

### Web 面板
- **总览**：KPI 卡片 + 费用分布图（按工具 / 供应商 / 模型分组筛选）
- **会话详情**：调用时间线 + 费用汇总
- **调用详情**：请求/响应体查看 + 费用明细
- **设置**：供应商管理（URL / Key / 启停）、定价表管理、币种切换、数据清空

## 技术栈

| 层 | 选择 |
|----|------|
| 代理 | Fastify + TypeScript |
| 数据库 | sql.js (SQLite WASM, 浏览器内存) |
| HTTP | 原生 fetch (undici) |
| 前端 | React 18 + Vite + Tailwind CSS |
| 查询 | TanStack Query |
| 测试 | Vitest |

## 项目结构

```
llm-monitor/
├── proxy/                      # Node.js 代理层
│   ├── main.ts                 # Fastify 入口，集成 Vite 中间件
│   ├── config.ts               # 端口等配置
│   ├── db.ts                   # SQLite CRUD + 建表 + 迁移
│   ├── router.ts               # 代理路由（/*）+ /api/* 查询 API
│   ├── forwarder.ts            # HTTP 转发（含 SSE 流式透传）
│   ├── session.ts              # 会话指纹计算 + CRUD
│   ├── normalizer.ts           # 响应体 Token 归一化
│   ├── pricing.ts              # 定价匹配 + 费用计算
│   ├── rates.ts                # 汇率获取 / 缓存 / 定时刷新
│   ├── recorder.ts             # 后台消费者（队列 → 计费 → 写库）
│   └── data/
│       └── default-pricing.json # 预置模型定价
├── webui/                      # React 前端
│   ├── index.html
│   ├── vite.config.ts
│   └── src/
│       ├── pages/              # Dashboard / SessionDetail / Settings
│       ├── components/         # Sidebar / KpiCards / CallTimeline / ui/
│       ├── lib/                # currency（货币工具 + 上下文） / utils
│       └── api/                # API 客户端
├── shared/                     # 前后端共享类型定义
├── tests/                      # Vitest 测试 + Mock LLM Server
├── dist/                       # 构建输出
│   ├── proxy/                  # 后端编译产物
│   └── web/                    # 前端静态文件
├── tsconfig.json               # 跨项目 TypeScript 配置
├── vitest.config.ts
└── package.json
```

## API 端点

### 查询
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/stats?group_by=tool\|provider\|model` | 聚合统计 |
| GET | `/api/calls?session_id=&limit=&offset=` | 调用列表 |
| GET | `/api/calls/:id` | 单条调用详情 |
| GET | `/api/sessions` | 会话列表 |
| GET | `/api/sessions/:id` | 会话详情 |
| GET | `/api/pricing` | 定价列表 |
| GET | `/api/providers` | 供应商列表 |
| GET | `/api/config` | 全局配置（含汇率） |

### 写入
| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/pricing` | 添加/更新定价 |
| POST | `/api/pricing/default` | 重置默认定价 |
| DELETE | `/api/pricing/:id` | 删除定价（默认不可删） |
| PUT | `/api/providers/:provider` | 更新供应商配置 |
| POST | `/api/providers` | 添加供应商 |
| DELETE | `/api/providers/:provider` | 删除供应商 |
| PUT | `/api/sessions/:id` | 更新会话标签/上游 |
| POST | `/api/config` | 更新全局配置 |
| POST | `/api/rates/refresh` | 手动刷新汇率 |
| POST | `/api/data/clear` | 清空全部数据（保留供应商配置） |

## 测试

```bash
npm test                  # 运行全部 35 个测试
npx vitest --watch        # watch 模式
```
