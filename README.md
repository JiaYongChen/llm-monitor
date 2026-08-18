# LLM Monitor

本地 LLM API 调用监控工具 — 代理拦截 CLI 工具（Claude Code、Codex 等）的 API 请求，实时记录调用详情、自动计费，并提供 Web 面板可视化。

## 快速开始

```bash
npm install

npm run dev                                       # 开发模式：代理 :9400 + 面板 :9401（含 HMR）
npm run dev -- --port 8400 --webui-port 8401      # 自定义端口

npm run build                                     # 生产构建（需先 build）
npx tsx proxy/main.ts --port 9400 --webui-port 9401
```

代理 → `http://localhost:9400` · 面板 → `http://localhost:9401`

## 对接 CLI 工具

```bash
npm link                      # 一次性注册全局命令
llm-monitor ClaudeCode        # 通过代理启动 ClaudeCode（当前目录）
llm-monitor codex ./project   # 通过代理启动 Codex（指定目录；chatgpt 为别名）
```

- 工具名大小写不敏感，统一小写存储（claudecode / codex）
- 启动时自动预创建会话并锁定（会话 ID 嵌入 URL `/s/<id>/`），同终端所有请求归入同一会话
- Claude Code 通过 `ANTHROPIC_BASE_URL` 环境变量走代理；Codex 通过 `~/.codex/config.toml`（启动脚本自动合并写入，保留已有配置）

## 主要功能

- 透明代理转发（含 SSE 流式），工具与上游格式不匹配时自动双向转换（Anthropic ↔ OpenAI）
- Token 用量解析（Anthropic / OpenAI Chat Completions / OpenAI Responses API），缓存读写拆分统计
- 会话指纹识别与自动标签，工具级 / 会话级上游供应商与模型配置
- 定价自动同步（供应商模型探测 + 定价源），多币种定价统一换算 CNY 存储，汇率每日自动刷新
- 思考过程分离：终端 `[think]` 前缀实时输出，Web 面板始终可查看
- Web 面板：总览 KPI / 工具与供应商详情 / 会话与调用详情 / 设置

## 技术栈

| 层 | 选择 |
|----|------|
| 代理 | Fastify + TypeScript |
| 数据库 | sql.js (SQLite WASM) |
| 前端 | React 18 + Vite + Tailwind CSS |
| 查询 | TanStack Query |
| 测试 | Vitest |

## 测试

```bash
npm test                # 运行全部测试
npx vitest --watch      # watch 模式
```

详细架构、模块职责与 API 说明见 [AGENTS.md](AGENTS.md)。
