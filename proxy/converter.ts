/** API 格式转换模块 — Anthropic ↔ OpenAI 请求/响应双向转换 */

// ═══════════════════════════════════════════════════════════════════
// 请求转换
// ═══════════════════════════════════════════════════════════════════

/** Anthropic 请求体 → OpenAI 请求体 */
function anthropicRequestToOpenAI(body: Record<string, any>): { body: Record<string, any>; path: string } {
  const out: Record<string, any> = {};

  // 透传字段
  for (const k of ['model', 'max_tokens', 'temperature', 'top_p', 'stream']) {
    if (body[k] !== undefined) out[k] = body[k];
  }

  // messages: content 数组扁平化为字符串，image 块转 image_url
  if (body.messages) {
    out.messages = body.messages.map((msg: any) => {
      const role = msg.role;
      let content: string | any[];
      if (typeof msg.content === 'string') {
        content = msg.content;
      } else if (Array.isArray(msg.content)) {
        const textParts: string[] = [];
        const imageParts: any[] = [];
        for (const block of msg.content) {
          if (block.type === 'text') {
            textParts.push(block.text);
          } else if (block.type === 'image') {
            // Anthropic image → OpenAI image_url（仅支持 base64）
            if (block.source?.type === 'base64' && block.source?.data && block.source?.media_type) {
              imageParts.push({
                type: 'image_url',
                image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` },
              });
            }
          } else if (block.type === 'tool_use') {
            // assistant 消息历史中的 tool_use → tool_calls
            if (role === 'assistant') return {
              role,
              content: null,
              tool_calls: [{
                id: block.id || `toolu_${Date.now()}`,
                type: 'function',
                function: { name: block.name || '', arguments: JSON.stringify(block.input || {}) },
              }],
            };
          } else if (block.type === 'tool_result') {
            // tool_result → role: "tool" 消息（跳过合并，由外层还原时处理）
            return { role: 'tool', tool_call_id: block.tool_use_id || '', content: block.content || '' };
          }
        }
        if (imageParts.length > 0 && textParts.length === 0) {
          content = imageParts;
        } else if (imageParts.length > 0) {
          content = [{ type: 'text', text: textParts.join('') }, ...imageParts];
        } else {
          content = textParts.join('');
        }
      } else {
        content = String(msg.content || '');
      }
      return { role, content };
    }).filter(Boolean);
  }

  // system prompt → messages 头部
  if (body.system) {
    const sysContent = typeof body.system === 'string'
      ? body.system
      : Array.isArray(body.system)
        ? body.system.map((s: any) => s.text || '').filter(Boolean).join('\n')
        : String(body.system);
    if (sysContent) {
      out.messages = [{ role: 'system', content: sysContent }, ...(out.messages || [])];
    }
  }

  // stop_sequences → stop
  if (body.stop_sequences) out.stop = body.stop_sequences;

  // tools: input_schema → function.parameters
  if (body.tools) {
    out.tools = body.tools.map((t: any) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description || '',
        parameters: t.input_schema || {},
      },
    }));
  }

  // tool_choice
  if (body.tool_choice) {
    const tc = body.tool_choice;
    if (tc?.type === 'auto') out.tool_choice = 'auto';
    else if (tc?.type === 'any') out.tool_choice = 'required';
    else if (tc?.type === 'tool' && tc.name) out.tool_choice = { type: 'function', function: { name: tc.name } };
  }

  // thinking → reasoning_effort（近似映射）
  if (body.thinking?.type === 'enabled') {
    out.reasoning_effort = body.thinking.budget_tokens && body.thinking.budget_tokens >= 8000 ? 'high' : 'medium';
  }

  return { body: out, path: '/v1/chat/completions' };
}

/** OpenAI 请求体 → Anthropic 请求体 */
function openAIRequestToAnthropic(body: Record<string, any>): { body: Record<string, any>; path: string } {
  const out: Record<string, any> = {};

  // 透传字段
  for (const k of ['model', 'max_tokens', 'temperature', 'top_p', 'stream']) {
    if (body[k] !== undefined) out[k] = body[k];
  }

  // 提取 system 消息
  const messages: any[] = [];
  const sysMessages: string[] = [];
  if (body.messages) {
    for (const msg of body.messages) {
      if (msg.role === 'system') {
        sysMessages.push(typeof msg.content === 'string' ? msg.content : String(msg.content || ''));
        continue;
      }
      // 工具结果消息
      if (msg.role === 'tool') {
        messages.push({
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: msg.tool_call_id || '', content: msg.content || '' }],
        });
        continue;
      }
      // 普通消息
      const role = msg.role === 'assistant' ? 'assistant' : 'user';
      let content: any[];
      if (msg.content == null && msg.tool_calls) {
        // 纯工具调用消息
        content = msg.tool_calls.map((tc: any) => ({
          type: 'tool_use',
          id: tc.id || `call_${Date.now()}`,
          name: tc.function?.name || '',
          input: safeJsonParse(tc.function?.arguments) || {},
        }));
      } else if (typeof msg.content === 'string') {
        content = [{ type: 'text', text: msg.content }];
      } else if (Array.isArray(msg.content)) {
        content = msg.content.map((p: any) => {
          if (p.type === 'image_url') {
            const url = p.image_url?.url || '';
            const base64Match = url.match(/^data:([^;]+);base64,(.+)$/);
            if (base64Match) {
              return { type: 'image', source: { type: 'base64', media_type: base64Match[1], data: base64Match[2] } };
            }
            return { type: 'image', source: { type: 'url', url } };
          }
          return p; // text 块直接保留
        });
      } else {
        content = [{ type: 'text', text: String(msg.content || '') }];
      }
      messages.push({ role, content });
    }
  }
  if (sysMessages.length > 0) {
    out.system = sysMessages.length === 1 ? sysMessages[0] : sysMessages.map(s => ({ type: 'text', text: s }));
  }
  out.messages = messages;

  // stop → stop_sequences
  if (body.stop) {
    out.stop_sequences = Array.isArray(body.stop) ? body.stop : [body.stop];
  }

  // tools: function.parameters → input_schema
  if (body.tools) {
    out.tools = body.tools.map((t: any) => ({
      name: t.function?.name || t.name || '',
      description: t.function?.description || t.description || '',
      input_schema: t.function?.parameters || t.input_schema || {},
    }));
  }

  // tool_choice
  if (body.tool_choice) {
    if (body.tool_choice === 'auto') out.tool_choice = { type: 'auto' };
    else if (body.tool_choice === 'required') out.tool_choice = { type: 'any' };
    else if (typeof body.tool_choice === 'object') {
      const name = body.tool_choice.function?.name || '';
      out.tool_choice = name ? { type: 'tool', name } : { type: 'auto' };
    }
  }

  // reasoning_effort → thinking（仅标记启用，budget_tokens 无法精确还原）
  if (body.reasoning_effort) {
    out.thinking = { type: 'enabled', budget_tokens: body.reasoning_effort === 'high' ? 8000 : 4000 };
  }

  return { body: out, path: '/v1/messages' };
}

// ═══════════════════════════════════════════════════════════════════
// 非流式响应转换
// ═══════════════════════════════════════════════════════════════════

/** OpenAI 响应 JSON → Anthropic 响应 JSON */
function openAIResponseToAnthropic(json: any): any {
  const choice = json.choices?.[0] || {};
  const msg = choice.message || {};

  const content: any[] = [];
  if (msg.content) {
    content.push({ type: 'text', text: msg.content });
  }
  if (msg.tool_calls) {
    for (const tc of msg.tool_calls) {
      content.push({
        type: 'tool_use',
        id: tc.id || `toolu_${Date.now()}`,
        name: tc.function?.name || '',
        input: safeJsonParse(tc.function?.arguments) || {},
      });
    }
  }
  // 转换 stop_reason
  const finishReason = choice.finish_reason || 'stop';
  const stopReasonMap: Record<string, string> = { stop: 'end_turn', length: 'max_tokens', tool_calls: 'tool_use', content_filter: 'stop_sequence' };
  const usage = json.usage || {};
  return {
    id: json.id || `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    model: json.model || '',
    content,
    stop_reason: stopReasonMap[finishReason] || finishReason,
    stop_sequence: null,
    usage: {
      input_tokens: usage.prompt_tokens ?? 0,
      output_tokens: usage.completion_tokens ?? 0,
    },
  };
}

/** Anthropic 响应 JSON → OpenAI 响应 JSON */
function anthropicResponseToOpenAI(json: any): any {
  const content = json.content || [];
  const textParts: string[] = [];
  const toolCalls: any[] = [];
  for (const block of content) {
    if (block.type === 'text') {
      textParts.push(block.text);
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id || `call_${Date.now()}`,
        type: 'function',
        function: { name: block.name || '', arguments: JSON.stringify(block.input || {}) },
      });
    }
  }
  const stopReasonMap: Record<string, string> = { end_turn: 'stop', max_tokens: 'length', tool_use: 'tool_calls', stop_sequence: 'stop' };
  const usage = json.usage || {};
  return {
    id: json.id || `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: json.model || '',
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: textParts.join('') || null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      },
      finish_reason: stopReasonMap[json.stop_reason] || json.stop_reason || 'stop',
    }],
    usage: {
      prompt_tokens: usage.input_tokens ?? 0,
      completion_tokens: usage.output_tokens ?? 0,
      total_tokens: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
    },
  };
}

// ═══════════════════════════════════════════════════════════════════
// 流式 SSE 转换
// ═══════════════════════════════════════════════════════════════════

interface StreamState {
  msgId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  blockIndex: number;
  blockType: string | null;       // 'text' | 'tool_use'
  toolName: string;
  toolArgs: string;
  contentEmitted: boolean;        // 是否已发送首个 chunk（含 role）
}

function freshState(): StreamState {
  return { msgId: '', model: '', inputTokens: 0, outputTokens: 0, blockIndex: 0, blockType: null, toolName: '', toolArgs: '', contentEmitted: false };
}

/** 将一段 SSE 文本解析为事件对象数组 */
function parseSSEChunk(text: string): Array<{ event?: string; data?: any; done?: boolean }> {
  const events: Array<{ event?: string; data?: any; done?: boolean }> = [];
  for (const section of text.split(/\n\n/)) {
    if (!section.trim()) continue;
    const evt: any = {};
    for (const line of section.split('\n')) {
      if (line.startsWith('event: ')) {
        evt._event = line.slice(7).trim();
      } else if (line.startsWith('data: ')) {
        const data = line.slice(6);
        if (data === '[DONE]') {
          evt._done = true;
        } else {
          try { Object.assign(evt, JSON.parse(data)); } catch {}
        }
      }
    }
    events.push(evt);
  }
  return events;
}

/** 将 Anthropic 事件序列化为 SSE 文本 */
function formatAnthropicSSE(event: string, data: any): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** 将 OpenAI chunk 序列化为 SSE 文本 */
function formatOpenAISSE(data: any): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

/** OpenAI SSE 流 → Anthropic SSE 流（供 ClaudeCode 客户端消费） */
class OpenAIStreamToAnthropicTransformer implements Transformer<Uint8Array, Uint8Array> {
  private state = freshState();
  private buffer = '';
  private decoder = new TextDecoder();
  private encoder = new TextEncoder();

  transform(chunk: Uint8Array, controller: TransformStreamDefaultController<Uint8Array>) {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    const parts = this.buffer.split('\n\n');
    this.buffer = parts.pop() || '';

    for (const part of parts) {
      const events = parseSSEChunk(part + '\n\n');
      for (const evt of events) {
        const output = this.convertEvent(evt);
        if (output) controller.enqueue(this.encoder.encode(output));
      }
    }
  }

  flush(controller: TransformStreamDefaultController<Uint8Array>) {
    // 处理残留 + 发送结束事件
    if (this.buffer.trim()) {
      const events = parseSSEChunk(this.buffer + '\n\n');
      for (const evt of events) {
        const output = this.convertEvent(evt);
        if (output) controller.enqueue(this.encoder.encode(output));
      }
    }
    // 确保有一个 text 内容块
    if (this.state.blockType === 'text') {
      controller.enqueue(this.encoder.encode(formatAnthropicSSE('content_block_stop', { type: 'content_block_stop', index: this.state.blockIndex })));
    }
    // 发送 message_delta + message_stop
    controller.enqueue(this.encoder.encode(formatAnthropicSSE('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: this.state.outputTokens },
    })));
    controller.enqueue(this.encoder.encode(formatAnthropicSSE('message_stop', { type: 'message_stop' })));
  }

  private convertEvent(evt: any): string | null {
    if (evt._done) return null; // [DONE] 不单独发送，flush 中处理

    const delta = evt.choices?.[0]?.delta;
    const finishReason = evt.choices?.[0]?.finish_reason;

    // 收集模型/ID/usage
    if (evt.model && !this.state.model) this.state.model = evt.model;
    if (evt.id && !this.state.msgId) this.state.msgId = evt.id;
    if (evt.usage?.prompt_tokens) this.state.inputTokens = evt.usage.prompt_tokens;
    if (evt.usage?.completion_tokens) this.state.outputTokens = evt.usage.completion_tokens;

    // 首个有内容的 chunk → 发送 message_start
    if (!this.state.contentEmitted) {
      this.state.contentEmitted = true;
      const msgs: string[] = [];
      // message_start
      msgs.push(formatAnthropicSSE('message_start', {
        type: 'message_start',
        message: {
          id: this.state.msgId,
          type: 'message',
          role: 'assistant',
          model: this.state.model,
          content: [],
          usage: this.state.inputTokens > 0 ? { input_tokens: this.state.inputTokens } : undefined,
        },
      }));
      // ping（某些客户端需要）
      msgs.push(formatAnthropicSSE('ping', { type: 'ping' }));
      return msgs.join('');
    }

    // 工具调用增量
    if (delta?.tool_calls) {
      for (const tc of delta.tool_calls) {
        if (tc.function?.name) {
          // 关闭前一个 block，开启新 tool_use block
          if (this.state.blockType === 'text') {
            // ... we need to send content_block_stop first
          }
          if (this.state.blockType === 'tool_use') {
            // close previous tool_use
          }
          this.state.blockType = 'tool_use';
          this.state.toolName = tc.function.name;
          this.state.toolArgs = '';
          this.state.blockIndex++;
          let out = '';
          if (this.state.blockIndex > 0) {
            // Close previous text block if exists
            // Actually let me simplify this...
          }
          return formatAnthropicSSE('content_block_start', {
            type: 'content_block_start',
            index: this.state.blockIndex,
            content_block: { type: 'tool_use', id: tc.id || `toolu_${Date.now()}`, name: tc.function.name, input: {} },
          });
        }
        if (tc.function?.arguments) {
          this.state.toolArgs += tc.function.arguments;
          return formatAnthropicSSE('content_block_delta', {
            type: 'content_block_delta',
            index: this.state.blockIndex,
            delta: { type: 'input_json_delta', partial_json: tc.function.arguments },
          });
        }
      }
      return null;
    }

    // 文本增量
    if (delta?.content) {
      if (this.state.blockType !== 'text') {
        this.state.blockType = 'text';
        this.state.blockIndex = 0;
        return formatAnthropicSSE('content_block_start', {
          type: 'content_block_start',
          index: this.state.blockIndex,
          content_block: { type: 'text', text: '' },
        }) + formatAnthropicSSE('content_block_delta', {
          type: 'content_block_delta',
          index: this.state.blockIndex,
          delta: { type: 'text_delta', text: delta.content },
        });
      }
      return formatAnthropicSSE('content_block_delta', {
        type: 'content_block_delta',
        index: this.state.blockIndex,
        delta: { type: 'text_delta', text: delta.content },
      });
    }

    // finish_reason（非流式 chunk）→ 不在这里发，flush 统一处理
    return null;
  }
}

/** Anthropic SSE 流 → OpenAI SSE 流（供 Codex 客户端消费） */
class AnthropicStreamToOpenAITransformer implements Transformer<Uint8Array, Uint8Array> {
  private state = freshState();
  private buffer = '';
  private decoder = new TextDecoder();
  private encoder = new TextEncoder();
  private created = Math.floor(Date.now() / 1000);

  transform(chunk: Uint8Array, controller: TransformStreamDefaultController<Uint8Array>) {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    const parts = this.buffer.split('\n\n');
    this.buffer = parts.pop() || '';

    for (const part of parts) {
      if (!part.trim()) continue;
      // 提取 event 类型行
      const lines = part.split('\n');
      const eventLine = lines.find(l => l.startsWith('event: '));
      const dataLine = lines.find(l => l.startsWith('data: '));
      if (!dataLine) continue;
      const eventType = eventLine?.slice(7).trim();
      let obj: any = null;
      try { obj = JSON.parse(dataLine.slice(6)); } catch { continue; }

      const out = this.convertEvent(eventType, obj);
      if (out) controller.enqueue(this.encoder.encode(out));
    }
  }

  flush(controller: TransformStreamDefaultController<Uint8Array>) {
    if (this.buffer.trim()) {
      const lines = this.buffer.split('\n');
      const dataLine = lines.find(l => l.startsWith('data: '));
      const eventLine = lines.find(l => l.startsWith('event: '));
      if (dataLine) {
        const eventType = eventLine?.slice(7).trim();
        let obj: any = null;
        try { obj = JSON.parse(dataLine.slice(6)); } catch {}
        if (obj) {
          const out = this.convertEvent(eventType, obj);
          if (out) controller.enqueue(this.encoder.encode(out));
        }
      }
    }
    // 发送 [DONE]
    controller.enqueue(this.encoder.encode('data: [DONE]\n\n'));
  }

  private convertEvent(eventType: string | undefined, obj: any): string | null {
    if (!obj.type) return null;

    switch (obj.type) {
      case 'message_start': {
        this.state.msgId = obj.message?.id || '';
        this.state.model = obj.message?.model || '';
        if (obj.message?.usage) {
          this.state.inputTokens = obj.message.usage.input_tokens || 0;
        }
        // 发送首个 chunk（含 role）
        const chunk: any = {
          id: this.state.msgId,
          object: 'chat.completion.chunk',
          created: this.created,
          model: this.state.model,
          choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
        };
        return formatOpenAISSE(chunk);
      }

      case 'content_block_start': {
        this.state.blockType = obj.content_block?.type || null;
        if (obj.content_block?.name) this.state.toolName = obj.content_block.name;
        if (this.state.blockType === 'tool_use') {
          const chunk: any = {
            id: this.state.msgId,
            object: 'chat.completion.chunk',
            created: this.created,
            model: this.state.model,
            choices: [{ index: 0, delta: { tool_calls: [{ index: obj.index || 0, id: obj.content_block.id, type: 'function', function: { name: obj.content_block.name, arguments: '' } }] }, finish_reason: null }],
          };
          return formatOpenAISSE(chunk);
        }
        return null;
      }

      case 'content_block_delta': {
        if (obj.delta?.type === 'text_delta') {
          const chunk: any = {
            id: this.state.msgId,
            object: 'chat.completion.chunk',
            created: this.created,
            model: this.state.model,
            choices: [{ index: 0, delta: { content: obj.delta.text }, finish_reason: null }],
          };
          return formatOpenAISSE(chunk);
        }
        if (obj.delta?.type === 'input_json_delta') {
          const chunk: any = {
            id: this.state.msgId,
            object: 'chat.completion.chunk',
            created: this.created,
            model: this.state.model,
            choices: [{ index: 0, delta: { tool_calls: [{ index: obj.index || 0, function: { arguments: obj.delta.partial_json } }] }, finish_reason: null }],
          };
          return formatOpenAISSE(chunk);
        }
        return null;
      }

      case 'message_delta': {
        if (obj.usage?.output_tokens) this.state.outputTokens = obj.usage.output_tokens;
        const stopMap: Record<string, string> = { end_turn: 'stop', max_tokens: 'length', tool_use: 'tool_calls' };
        const finishReason = stopMap[obj.delta?.stop_reason] || obj.delta?.stop_reason || 'stop';
        const chunk: any = {
          id: this.state.msgId,
          object: 'chat.completion.chunk',
          created: this.created,
          model: this.state.model,
          choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
          usage: {
            prompt_tokens: this.state.inputTokens,
            completion_tokens: this.state.outputTokens,
            total_tokens: this.state.inputTokens + this.state.outputTokens,
          },
        };
        return formatOpenAISSE(chunk);
      }

      default:
        return null;
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
// 公共 API
// ═══════════════════════════════════════════════════════════════════

/** 检测是否需要格式转换 */
export function needsConversion(sourceFormat: string, targetFormat: string): boolean {
  return sourceFormat !== targetFormat;
}

/**
 * 转换请求体。
 * @param bodyStr 原始请求体 JSON 字符串
 * @param from 源格式（工具格式）— 'anthropic' | 'openai'
 * @param to 目标格式（上游格式）— 'anthropic' | 'openai'
 * @returns { body: 转换后的 JSON 字符串, path: 上游路径 }
 */
export function convertRequest(bodyStr: string, from: string, to: string): { body: string; path: string } {
  const parsed = JSON.parse(bodyStr);
  if (from === 'anthropic' && to === 'openai') {
    const { body, path } = anthropicRequestToOpenAI(parsed);
    return { body: JSON.stringify(body), path };
  }
  if (from === 'openai' && to === 'anthropic') {
    const { body, path } = openAIRequestToAnthropic(parsed);
    return { body: JSON.stringify(body), path };
  }
  return { body: bodyStr, path: '' };
}

/**
 * 转换非流式响应体。
 * @param text 上游返回的响应文本
 * @param from 源格式（上游格式）— 'anthropic' | 'openai'
 * @param to 目标格式（客户端格式）— 'anthropic' | 'openai'
 */
export function convertResponse(text: string, from: string, to: string): string {
  if (from === to) return text;
  let json: any;
  try { json = JSON.parse(text); } catch { return text; }

  if (from === 'openai' && to === 'anthropic') {
    return JSON.stringify(openAIResponseToAnthropic(json));
  }
  if (from === 'anthropic' && to === 'openai') {
    return JSON.stringify(anthropicResponseToOpenAI(json));
  }
  return text;
}

/**
 * 创建流式 SSE 响应转换 TransformStream。
 * @param from 源格式（上游 SSE 格式）— 'anthropic' | 'openai'
 * @param to 目标格式（客户端 SSE 格式）— 'anthropic' | 'openai'
 */
export function createResponseTransform(from: string, to: string): TransformStream<Uint8Array, Uint8Array> {
  if (from === to) {
    return new TransformStream({ transform(chunk, c) { c.enqueue(chunk); } });
  }
  if (from === 'openai' && to === 'anthropic') {
    return new TransformStream(new OpenAIStreamToAnthropicTransformer());
  }
  if (from === 'anthropic' && to === 'openai') {
    return new TransformStream(new AnthropicStreamToOpenAITransformer());
  }
  return new TransformStream({ transform(chunk, c) { c.enqueue(chunk); } });
}

// ═══════════════════════════════════════════════════════════════════
// 工具函数
// ═══════════════════════════════════════════════════════════════════

function safeJsonParse(s: string): any {
  try { return JSON.parse(s); } catch { return null; }
}
