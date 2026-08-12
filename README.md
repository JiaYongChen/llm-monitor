# LLM Monitor

本地 LLM API 调用监控工具 — 代理拦截 CLI 工具的 API 请求，实时记录调用详情、自动计费、Web 面板可视化。

## 快速开始

```bash
cd llm-monitor
npm install

# 开发模式（双端口：代理 :9400 + 面板 :9401，含 HMR）
npm run dev

# 自定义端口
npm run dev -- --port 8400 --webui-port 8401

# 生产模式
npm run build
npx tsx proxy/main.ts --port 9400 --webui-port 9401
```

代理 → `http://localhost:9400`  ·  面板 → `http://localhost:9401`

## 对接 CLI 工具

```bash
# 一键启动（自动预创建会话并锁定，同终端复用同一会话）
npm link                           # 一次性注册命令
llm-monitor ClaudeCode             # 通过代理启动 ClaudeCode
llm-monitor codex                  # 通过代理启动 Codex
```

### 代理 Base URL

**Claude Code** — 环境变量 `ANTHROPIC_BASE_URL`：
```bash
export ANTHROPIC_BASE_URL="http://localhost:9400/ClaudeCode"
# 含会话锁定（同终端复用）：
export ANTHROPIC_BASE_URL="http://localhost:9400/s/<id>/ClaudeCode"
```

**Codex** — 配置文件 `~/.codex/config.toml`（不支持 `OPENAI_BASE_URL` 环境变量）：
```toml
model_provider = "LLM-Monitor"
model = "gpt-5.6-sol"
preferred_auth_method = "apikey"
forced_login_method = "api"

[model_providers.LLM-Monitor]
name = "LLM-Monitor"
base_url = "http://localhost:9400/codex"
experimental_bearer_token = "llm-monitor"
wire_api = "responses"
```
```toml
# 含会话锁定（同终端复用）：
base_url = "http://localhost:9400/s/<id>/codex"
```

> URL 路径以工具名作前缀，大小写不敏感。脚本使用 `/s/<id>/` 嵌入会话 ID，同终端所有请求归入同一会话。`llm-monitor codex` 启动脚本会自动写入 `config.toml`。

## 功能

### 调用拦截与记录
- 透明代理转发（含 SSE 流式），无侵入
- **格式转换**：自动检测工具格式与上游供应商格式，不匹配时双向转换（Anthropic ↔ OpenAI）
- 自动解析请求/响应中的 Token 用量（Anthropic / OpenAI 两种格式）
- 缓存读写拆分：未缓存输入、缓存写入、缓存命中分别统计
- **思考过程显示**：自动分离模型的思考/推理内容，终端实时输出（`[think]` 前缀、区域分隔），Web 面板折叠展示

### 会话管理
- **指纹识别**：SHA256(provider + 首条消息种子) → 同一聊天自动归属同一会话
- **自动标签**：新建会话自动提取首条用户消息作为标签
- **工具标识**：URL 工具名前缀反向识别（`/ClaudeCode/*` → ClaudeCode，`/codex/*` → codex）
- 工具级上游配置：Dashboard 可设置每个工具的默认上游供应商和模型，新会话自动继承
- 会话级上游覆盖：会话详情页可单独覆盖供应商和模型

### 上游供应商管理
- 上游覆盖优先级：会话 > 工具 > URL 路径默认
- 会话级和工具级均支持独立选择供应商和模型
- 转发地址显示完整 URL（含端点路径）
- 格式转换在上游与工具格式不匹配时自动触发

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
- **总览**：KPI 卡片（原始数值显示）+ 费用分布图（按工具 / 供应商 / 模型分组筛选）
- **工具页**：筛选到具体工具时显示上游供应商和模型配置
- **会话详情**：调用时间线 + 上游配置 + 费用汇总
- **调用详情**：请求/响应体查看 + Token 与费用明细
- **设置**：供应商管理（URL / Key / 启停）、定价表管理、币种切换、数据清空

## 技术栈

| 层 | 选择 |
|----|------|
| 代理 | Fastify + TypeScript |
| 数据库 | sql.js (SQLite WASM) |
| HTTP | 原生 fetch (undici) |
| 前端 | React 18 + Vite + Tailwind CSS |
| 查询 | TanStack Query |
| 测试 | Vitest |

## 项目结构

```
llm-monitor/
├── proxy/                       # Node.js 代理层
│   ├── main.ts                  # Fastify 入口，双端口 server
│   ├── config.ts                # CLI 参数解析 + 常量
│   ├── db.ts                    # SQLite CRUD + 建表 + 迁移
│   ├── router.ts                # 代理路由（/*）+ /api/* 查询 API
│   ├── forwarder.ts             # HTTP 转发（含 SSE 流式透传）
│   ├── converter.ts             # Anthropic ↔ OpenAI 格式双向转换
│   ├── session.ts               # 会话指纹 + 标签生成 + CRUD
│   ├── normalizer.ts            # Token 归一化（anthropic / openai）
│   ├── pricing.ts               # 定价匹配 + 费用计算
│   ├── rates.ts                 # 汇率获取 / 缓存 / 定时刷新
│   ├── recorder.ts              # 后台消费者（队列 → 计费 → 写库 + 统计累加）
│   ├── thinking-preview.ts      # 终端思考输出格式化
│   └── data/
│       └── default-pricing.json # 预置模型定价
├── webui/                       # React 前端
│   ├── index.html
│   ├── vite.config.ts
│   └── src/
│       ├── pages/               # Dashboard / SessionDetail / Settings
│       ├── components/          # Sidebar / KpiCards / CallTimeline / ui/
│       ├── lib/                 # currency / utils
│       └── api/                 # API 客户端
├── shared/                      # 前后端共享类型定义
│   └── extractThinking.ts       # 思考提取函数（兼容三种响应形态）
├── scripts/                     # CLI 启动脚本
│   ├── start-tool               # bash (macOS/Linux)
│   ├── start-tool.cmd           # → PowerShell (Windows)
│   ├── start-tool.ps1           # PowerShell 实现
│   └── llm-monitor.cmd          # Windows 别名
├── tests/                       # Vitest 测试
├── dist/                        # 构建输出（已 gitignore）
│   └── web/                     # 前端静态文件
├── tsconfig.json
├── package.json
└── CLAUDE.md
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
| GET | `/api/tool-configs` | 工具级上游配置 |
| GET | `/api/config` | 全局配置（含汇率） |
| GET | `/proxy/health` | 健康检查 |

### 代理端口（9400）
| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/proxy/sessions/start` | 预创建 pending 会话 |
| GET | `/proxy/health` | 健康检查 |

### 写入（面板端口 9401）
| PUT | `/api/sessions/:id/label` | 更新会话标签 |
| PUT | `/api/sessions/:id/upstream` | 更新会话上游供应商 |
| PUT | `/api/sessions/:id/model` | 更新会话上游模型 |
| POST | `/api/sessions/merge` | 合并会话 |
| DELETE | `/api/sessions/:id` | 删除会话 |
| PUT | `/api/tool-configs/:tool` | 更新工具上游配置 |
| POST | `/api/pricing` | 添加/更新定价 |
| POST | `/api/pricing/default` | 重置默认定价 |
| DELETE | `/api/pricing/:id` | 删除定价 |
| PUT | `/api/providers/:provider` | 更新供应商配置 |
| POST | `/api/providers` | 添加供应商 |
| DELETE | `/api/providers/:provider` | 删除供应商 |
| PUT | `/api/config` | 更新全局配置 |
| POST | `/api/rates/refresh` | 手动刷新汇率 |
| POST | `/api/data/clear` | 清空全部数据（含统计表） |
| POST | `/api/data/clear-providers` | 清空第三方供应商 |
| POST | `/api/data/clear-sessions` | 清空全部会话（统计不变） |
| POST | `/api/data/cleanup` | 清理 N 天前的旧调用（统计不变） |

## 测试

```bash
npm test                # 运行全部 127 个测试
npx vitest --watch      # watch 模式
```
