# LLM Monitor

本地 LLM API 调用监控工具 — 通过代理拦截 Claude Code / Codex 等工具的 API 请求，记录调用详情、计算费用、提供 Web 面板。

## 快速开始

```bash
cd llm-monitor
npm install

# 开发模式（单端口 :9400，含 HMR）
npm run dev

# 生产模式（构建前端后单进程启动）
npm run build
npx tsx proxy/main.ts
# 代理 + 面板：http://localhost:9400
```

## 对接

在启动 Claude Code / Codex 等工具前设置环境变量：

```bash
# Claude Code
export ANTHROPIC_BASE_URL="http://localhost:9400/anthropic"

# Codex
export OPENAI_BASE_URL="http://localhost:9400/openai/v1"

# DeepSeek CLI
export DEEPSEEK_BASE_URL="http://localhost:9400/deepseek/v1"

# Qwen CLI
export DASHSCOPE_BASE_URL="http://localhost:9400/dashscope/compatible-mode/v1"
```

设置后正常使用 CLI 工具，所有 API 调用自动经过代理并被记录。

## 功能

- 支持 Anthropic / OpenAI / DeepSeek / Qwen 四家 LLM 提供商
- 自动会话识别（三元组指纹：provider + 源端口 + API Key 前缀）
- Token 归一化 + 费用计算（输入/输出/缓存分计）
- 缓存命中/未命中拆分，缓存节省统计
- 实时调用流 + 历史聚合
- 可编辑的模型定价表
- 预置常见模型定价

## 技术栈

| 层 | 选择 |
|----|------|
| 代理 | Fastify + TypeScript |
| 数据库 | sql.js (SQLite WASM) |
| HTTP 客户端 | 原生 fetch (undici) |
| 前端 | React 18 + Vite + Tailwind CSS |
| 图表 | Recharts |
| 测试 | Vitest |

## 项目结构

```
llm-monitor/
├── proxy/                 # Node.js 代理层
│   ├── main.ts            # Fastify 入口
│   ├── config.ts          # 配置管理
│   ├── db.ts              # SQLite (sql.js) CRUD
│   ├── router.ts          # 代理路由 + /api/* 查询
│   ├── forwarder.ts       # HTTP 转发（含流式 SSE）
│   ├── session.ts         # 会话识别
│   ├── normalizer.ts      # Token 归一化
│   ├── pricing.ts         # 定价匹配 + 费用计算
│   ├── recorder.ts        # 后台消费者
│   └── data/              # 预置定价
├── webui/                   # React 前端（Vite root）
│   ├── index.html
│   ├── vite.config.ts     # Vite 构建配置（npm scripts 通过 --config 指定）
│   ├── postcss.config.js
│   └── src/
│       ├── pages/         # Dashboard, SessionDetail, CallDetail, Settings
│       ├── components/    # 布局 + 图表 + 详情面板 + ui/
│       ├── lib/           # cn() 工具函数
│       └── api/           # API 客户端
├── shared/                # 前后端共享类型
├── tests/                 # Vitest 测试 + Mock LLM Server
├── dist/webui/              # 前端构建输出
├── tsconfig.json          # TypeScript 配置（横跨 proxy/webui/shared/tests）
├── vitest.config.ts       # 测试配置
├── tailwind.config.js     # Tailwind 配置（PostCSS 插件从 cwd 解析，必须在根）
├── components.json        # shadcn CLI 配置（从 cwd 解析，必须在根）
└── package.json
```

### 目录约定

- `@/` 别名 → 项目根目录（tsconfig paths + Vite alias 双重解析）
- **web 内部互导**：使用相对路径
- **跨入根级共享代码**（`shared/`）：使用 `@/` 别名
- **构建命令**：一律从项目根执行（`npm run dev` / `npm run build`）

## 测试

```bash
npm test                # 运行所有测试
npx vitest --watch      # watch 模式
```
