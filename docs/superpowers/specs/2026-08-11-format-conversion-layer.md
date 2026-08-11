# API 格式转换层设计

## 问题

代理做透明转发，不做格式转换。ClaudeCode 发 Anthropic 格式请求、Codex 发 OpenAI 格式请求。当上游供应商与原工具格式不匹配时（ClaudeCode→OpenAI 上游、Codex→Anthropic 上游），路径和请求体格式均不兼容，请求必然失败。

## 目标

新增格式转换模块，自动检测源格式（工具类型）与目标格式（上游供应商 api_format），不匹配时透明转换请求体和响应体，使跨格式转发可工作。

## 架构

```
CLI 工具 ─→ router ─→ converter ─→ forwarder ─→ 上游 API
                             │
                    源格式 ≠ 目标格式时启用
```

新增文件：`proxy/converter.ts`

### 格式检测

```
sourceFormat = tool === 'ClaudeCode' ? 'anthropic' : 'openai'
targetFormat = upstreamProvider.api_format
               || (provider 名推断：'Anthropic'→'anthropic', 其他→'openai')

conversion = sourceFormat !== targetFormat
```

### 导出接口

```typescript
// 请求转换：返回 { body, path } — 转换后的请求体字符串和上游路径
convertRequest(body: string, sourceFormat: string, targetFormat: string): { body: string; path: string }

// 非流式响应转换：返回转换后的完整响应文本
convertResponse(text: string, sourceFormat: string, targetFormat: string): string

// 流式响应转换：返回 TransformStream，逐块 SSE 转换
convertStream(sourceFormat: string, targetFormat: string): TransformStream
```

### router.ts 集成点

在 `getConfiguredUpstream` 之后、`forwardRequest`/`forwardStream` 之前插入转换逻辑：

```
if (sourceFormat !== targetFormat) {
  converted = convertRequest(bodyStr, sourceFormat, targetFormat)
  body = converted.body
  remaining = converted.path  // 替换上游路径
}
// 流式：stream.pipeThrough(convertStream(sourceFormat, targetFormat))
// 非流式：result.text = convertResponse(result.text, sourceFormat, targetFormat)
```

## 请求体转换

### Anthropic → OpenAI

| Anthropic | OpenAI | 逻辑 |
|---|---|---|
| `model` | `model` | 透传 |
| `max_tokens` | `max_tokens` | 透传 |
| `temperature` | `temperature` | 透传 |
| `top_p` | `top_p` | 透传 |
| `top_k` | — | 丢弃 |
| `stream` | `stream` | 透传 |
| `system` (顶层) | `messages[0]` | `{role:"system", content}` 插入头部 |
| `messages[].content` (数组) | `messages[].content` (字符串) | text 块拼接，image 块转 image_url |
| `stop_sequences` | `stop` | 透传 |
| `tools[].input_schema` | `tools[].function.parameters` | 字段重命名 |
| `tool_choice` | `tool_choice` | `{type:"auto"/"any"/"tool"}` → `"auto"/"required"/{...}` |
| `thinking` | `reasoning_effort` | `{type:"enabled"}`→`"medium"` |

### OpenAI → Anthropic

逆映射：
- 从 messages 数组提取 `role:system` → 顶层 `system`
- image_url → `{type:"image", source:{...}}`
- `stop` → `stop_sequences`
- tools function 格式逆向

## 流式响应转换

### Anthropic SSE → OpenAI SSE

状态机跟踪当前 block 索引和类型：

```
message_start      → 首个 chunk: delta.role="assistant"
content_block_start → 记录 block[index].type
content_block_delta:
  text_delta       → delta.content
  input_json_delta → delta.tool_calls[].function.arguments
  thinking_delta   → 丢弃
content_block_stop → 内部状态更新
message_delta      → finish_reason chunk + usage
message_stop       → [DONE]
```

### OpenAI SSE → Anthropic SSE

从连续 chunk 流重建 Anthropic 事件序列：

```
首个 chunk         → message_start + content_block_start + ping
delta.content      → content_block_delta(text_delta)
delta.tool_calls   → 累积为 content_block_start(tool_use) + input_json_delta
finish_reason      → content_block_stop + message_delta + message_stop
```

## 非流式响应转换

完整 JSON 字段映射，无状态机。

### Anthropic → OpenAI

```
content[] 扁平化: text 块拼接，tool_use 块 → tool_calls[]
stop_reason → finish_reason: end_turn→stop, max_tokens→length, tool_use→tool_calls
usage: input_tokens→prompt_tokens, output_tokens→completion_tokens, +total_tokens
```

### OpenAI → Anthropic

逆向映射，重建 content 数组结构。

## Token 使用量转换

转换后的响应体保持目标格式，`buildCleanResponseBody` 和 `normalizeTokens` 不做修改——它们已支持两种格式的 usage 解析。转换层确保输出的 usage 字段始终与响应体格式一致。

## 测试

- `tests/converter.test.ts`：覆盖四个方向，包含流式 SSE 事件序列测试
- 请求体转换：字段映射正确性
- 流式转换：SSE 事件序列完整性、tool call 增量累积
- 非流式转换：完整 JSON 字段映射
- 边界：空 content、纯 tool_use 调用、空消息数组、system prompt

## 不变约束

- `proxy/forwarder.ts` 不做修改——转发层保持透明
- `proxy/normalizer.ts` 不做修改——已支持两种格式
- 现有 69 项测试全部保持通过
- 转换仅在 `sourceFormat !== targetFormat` 时启用，无转换需求时路径不变
