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

  // 流式请求注入 stream_options.include_usage：OpenAI 兼容供应商仅在显式开启时
  // 才在流末回传 usage，缺失会导致转换链路上所有流式调用提取不到 usage 而漏计费
  if (out.stream === true) {
    out.stream_options = { include_usage: true };
  }

  // messages: content 数组扁平化为字符串，image 块转 image_url，
  // tool_use/tool_result 全部收集后统一构造（不再提前 return，修复并行工具调用丢失）
  if (body.messages) {
    out.messages = body.messages.map((msg: any) => {
      const role = msg.role;
      if (typeof msg.content === 'string') {
        return { role, content: msg.content };
      }
      if (!Array.isArray(msg.content)) {
        return { role, content: String(msg.content || '') };
      }

      const textParts: string[] = [];
      const imageParts: any[] = [];
      const toolCalls: any[] = [];
      const toolResults: any[] = [];

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
        } else if (block.type === 'tool_use' && role === 'assistant') {
          // assistant 消息历史中的 tool_use → tool_calls（收集全部，不提前 return）
          toolCalls.push({
            id: block.id || `toolu_${Date.now()}`,
            type: 'function',
            function: { name: block.name || '', arguments: JSON.stringify(block.input || {}) },
          });
        } else if (block.type === 'tool_result') {
          // tool_result → role: "tool" 消息（收集全部后展开为独立消息）
          // Anthropic 允许 content 为内容块数组，OpenAI tool 角色必须是字符串 → 文本扁平化，
          // 图片块无法用 tool 角色表达 → 移入后续用户消息，避免丢弃
          const tc = block.content;
          let flatContent: string;
          if (typeof tc === 'string') {
            flatContent = tc;
          } else if (Array.isArray(tc)) {
            const texts: string[] = [];
            for (const b of tc) {
              if (b?.type === 'image' && b.source?.type === 'base64' && b.source?.data && b.source?.media_type) {
                imageParts.push({
                  type: 'image_url',
                  image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` },
                });
              } else {
                texts.push(b?.text ?? JSON.stringify(b));
              }
            }
            flatContent = texts.join('\n');
          } else {
            flatContent = String(tc || '');
          }
          toolResults.push({ role: 'tool', tool_call_id: block.tool_use_id || '', content: flatContent });
        }
      }

      // 如果有 tool_result，展开为多条独立消息；
      // 同消息中的文本/图片不丢弃（改为后续用户消息，图片用 content 数组承载）
      if (toolResults.length > 0) {
        const results = [...toolResults];
        if (textParts.length > 0 || imageParts.length > 0) {
          if (imageParts.length > 0) {
            const parts: any[] = [];
            if (textParts.length > 0) parts.push({ type: 'text', text: textParts.join('') });
            parts.push(...imageParts);
            results.push({ role, content: parts });
          } else {
            const extraContent = textParts.join('') || '';
            if (extraContent) results.push({ role, content: extraContent });
          }
        }
        return results;
      }

      // 构建 content（文本 + 图片，不含工具调用）
      let content: string | any[] | null;
      if (imageParts.length > 0 && textParts.length === 0) {
        content = imageParts;
      } else if (imageParts.length > 0) {
        content = [{ type: 'text', text: textParts.join('') }, ...imageParts];
      } else {
        content = textParts.join('') || null;
      }

      // assistant 消息带有 tool_calls
      if (toolCalls.length > 0) {
        return { role, content, tool_calls: toolCalls };
      }

      return { role, content };
    }).flat().filter(Boolean);
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

/** 将 Responses API 的 input 归一化为 Chat Completions 风格消息数组。
 *  input 可能为纯字符串、message/function_call/function_call_output/reasoning 等条目数组。 */
function responsesInputToMessages(input: any): any[] {
  if (typeof input === 'string') return [{ role: 'user', content: input }];
  if (!Array.isArray(input)) return [];
  const msgs: any[] = [];
  const pendingCalls: any[] = [];
  // 连续 function_call 合并进同一条 assistant 消息（并行工具调用）
  const flushCalls = () => {
    if (pendingCalls.length > 0) {
      msgs.push({ role: 'assistant', content: null, tool_calls: pendingCalls.splice(0) });
    }
  };
  for (const item of input) {
    if (typeof item === 'string') {
      flushCalls();
      msgs.push({ role: 'user', content: item });
      continue;
    }
    switch (item?.type) {
      case 'message': {
        flushCalls();
        const role = item.role === 'assistant' ? 'assistant'
          : item.role === 'system' || item.role === 'developer' ? item.role
          : 'user';
        const content = Array.isArray(item.content)
          ? item.content.map((p: any) => {
              if (p?.type === 'input_text' || p?.type === 'output_text' || p?.type === 'summary_text' || p?.type === 'text') {
                return { type: 'text', text: p.text || '' };
              }
              if (p?.type === 'input_image') {
                const url = typeof p.image_url === 'string' ? p.image_url : p.image_url?.url || '';
                return { type: 'image_url', image_url: { url } };
              }
              return { type: 'text', text: typeof p?.text === 'string' ? p.text : JSON.stringify(p ?? '') };
            })
          : [{ type: 'text', text: String(item.content ?? '') }];
        msgs.push({ role, content });
        break;
      }
      case 'function_call':
        pendingCalls.push({
          id: item.call_id || item.id || '',
          type: 'function',
          function: {
            name: item.name || '',
            arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {}),
          },
        });
        break;
      case 'function_call_output':
        flushCalls();
        msgs.push({
          role: 'tool',
          tool_call_id: item.call_id || '',
          content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? ''),
        });
        break;
      default:
        // reasoning / item_reference 等其余条目无 Anthropic 等价物（加密推理无法还原），跳过
        break;
    }
  }
  flushCalls();
  return msgs;
}

/** 消息内容扁平化为文本（system/developer 消息可能是字符串或内容块数组） */
function flattenContentToText(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((p: any) => p?.text ?? '').filter(Boolean).join('\n');
  }
  return String(content ?? '');
}

/** OpenAI 请求体 → Anthropic 请求体。
 *  兼容 Chat Completions（messages + system）和 Responses API（input + instructions）。 */
function openAIRequestToAnthropic(body: Record<string, any>): { body: Record<string, any>; path: string } {
  const out: Record<string, any> = {};

  // 透传字段
  for (const k of ['model', 'max_tokens', 'temperature', 'top_p', 'stream']) {
    if (body[k] !== undefined) out[k] = body[k];
  }
  // max_tokens 兜底：Anthropic 必填；Responses API 用 max_output_tokens，均缺失时给默认值
  if (out.max_tokens == null) {
    out.max_tokens = typeof body.max_output_tokens === 'number' ? body.max_output_tokens : 8192;
  }

  // 提取 system 消息
  const messages: any[] = [];
  const sysMessages: string[] = [];

  // Responses API: instructions → system prompt
  if (body.instructions != null) {
    sysMessages.push(typeof body.instructions === 'string' ? body.instructions : String(body.instructions));
  }

  // 统一消息来源：Chat Completions 用 messages，Responses API 用 input（归一化为 chat 风格）
  const sourceMsgs = body.messages || (body.input != null ? responsesInputToMessages(body.input) : undefined);
  // 连续 role:'tool' 消息合并为一条 user 消息的多个 tool_result 块（Anthropic 要求角色交替）
  const pendingToolResults: any[] = [];
  const flushToolResults = () => {
    if (pendingToolResults.length > 0) {
      messages.push({ role: 'user', content: pendingToolResults.splice(0) });
    }
  };
  if (sourceMsgs) {
    for (const msg of sourceMsgs) {
      if (msg.role === 'system' || msg.role === 'developer') {
        sysMessages.push(flattenContentToText(msg.content));
        continue;
      }
      // 工具结果消息（收集后统一展开）
      if (msg.role === 'tool') {
        pendingToolResults.push({
          type: 'tool_result',
          tool_use_id: msg.tool_call_id || '',
          content: typeof msg.content === 'string' ? msg.content : flattenContentToText(msg.content),
        });
        continue;
      }
      flushToolResults();
      // 普通消息
      const role = msg.role === 'assistant' ? 'assistant' : 'user';
      let content: any[];

      // 文本内容
      if (typeof msg.content === 'string' && msg.content) {
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
      } else if (msg.content != null) {
        content = [{ type: 'text', text: String(msg.content) }];
      } else {
        content = [];
      }

      // 工具调用（OpenAI 允许 content 和 tool_calls 共存）
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          content.push({
            type: 'tool_use',
            id: tc.id || `call_${Date.now()}`,
            name: tc.function?.name || '',
            input: safeJsonParse(tc.function?.arguments) || {},
          });
        }
      }
      messages.push({ role, content: content.length > 0 ? content : null });
    }
  }
  flushToolResults();
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
    const budget = body.reasoning_effort === 'high' ? 8000 : 4000;
    out.thinking = { type: 'enabled', budget_tokens: budget };
    // Anthropic 要求 max_tokens > budget_tokens，不足时抬高兜底
    if (out.max_tokens <= budget) out.max_tokens = budget + 1024;
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
  nextBlockIndex: number;       // 下一个可用的 Anthropic block index
  currentBlockType: string | null;  // 'text' | 'tool_use' — 当前活跃的 block 类型
  // 每个 OpenAI tool_call index → Anthropic block 映射（解决并行工具增量串位）
  toolSlots: { anthropicIdx: number; name: string; args: string }[];
  contentEmitted: boolean;
  finishReason: string | null;  // 上游 finish_reason（flush 时映射为 Anthropic stop_reason）
  openBlocks: number[];         // 已 start 未 stop 的 block 索引（收尾时升序关闭，防重复/乱序）
}

function freshState(): StreamState {
  return {
    msgId: '', model: '', inputTokens: 0, outputTokens: 0,
    nextBlockIndex: 0, currentBlockType: null,
    toolSlots: [], contentEmitted: false,
    finishReason: null, openBlocks: [],
  };
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
    // 关闭所有仍开放的 content block（升序、不重复）
    if (this.state.openBlocks.length > 0) {
      controller.enqueue(this.encoder.encode(this.closeBlocks(this.state.openBlocks)));
      this.state.openBlocks = [];
    }
    // stop_reason 由上游 finish_reason 映射（此前硬编码 end_turn 会丢失 tool_calls/length 信号）
    const stopMap: Record<string, string> = { stop: 'end_turn', length: 'max_tokens', tool_calls: 'tool_use', content_filter: 'end_turn' };
    const stopReason = this.state.finishReason
      ? (stopMap[this.state.finishReason] || this.state.finishReason)
      : 'end_turn';
    controller.enqueue(this.encoder.encode(formatAnthropicSSE('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: this.state.outputTokens },
    })));
    controller.enqueue(this.encoder.encode(formatAnthropicSSE('message_stop', { type: 'message_stop' })));
  }

  /** 关闭指定索引的 content block（升序输出，保证协议顺序） */
  private closeBlocks(idxs: number[]): string {
    let out = '';
    for (const idx of [...idxs].sort((a, b) => a - b)) {
      out += formatAnthropicSSE('content_block_stop', { type: 'content_block_stop', index: idx });
    }
    return out;
  }

  private convertEvent(evt: any): string | null {
    if (evt._done) return null; // [DONE] 不单独发送，flush 中处理

    const delta = evt.choices?.[0]?.delta;
    const finishReason = evt.choices?.[0]?.finish_reason;
    if (finishReason) this.state.finishReason = finishReason;

    // 收集模型/ID/usage
    if (evt.model && !this.state.model) this.state.model = evt.model;
    if (evt.id && !this.state.msgId) this.state.msgId = evt.id;
    if (evt.usage?.prompt_tokens) this.state.inputTokens = evt.usage.prompt_tokens;
    if (evt.usage?.completion_tokens) this.state.outputTokens = evt.usage.completion_tokens;

    let output = '';

    // 首个有内容的 chunk → 先发送 message_start + ping，然后继续处理 delta（修复 #2：不再 return 丢弃当前事件数据）
    if (!this.state.contentEmitted) {
      this.state.contentEmitted = true;
      output += formatAnthropicSSE('message_start', {
        type: 'message_start',
        message: {
          id: this.state.msgId,
          type: 'message',
          role: 'assistant',
          model: this.state.model,
          content: [],
          usage: this.state.inputTokens > 0 ? { input_tokens: this.state.inputTokens } : undefined,
        },
      });
      output += formatAnthropicSSE('ping', { type: 'ping' });
    }

    // 工具调用增量 — 按 tc.index 分槽跟踪
    if (delta?.tool_calls) {
      for (const tc of delta.tool_calls) {
        const slotIdx = tc.index ?? 0;
        // 确保 slot 存在
        while (this.state.toolSlots.length <= slotIdx) {
          this.state.toolSlots.push({ anthropicIdx: -1, name: '', args: '' });
        }
        const slot = this.state.toolSlots[slotIdx];

        if (tc.function?.name) {
          // 只在从 text 切换到 tool_use 时关闭 text block，tool_use→tool_use 不关闭（并行工具各有独立 block）
          if (this.state.currentBlockType === 'text') {
            output += this.closeBlocks(this.state.openBlocks);
            this.state.openBlocks = [];
          }
          // 为这个工具调用分配新的 Anthropic block index
          slot.anthropicIdx = this.state.nextBlockIndex++;
          this.state.openBlocks.push(slot.anthropicIdx);
          slot.name = tc.function.name;
          slot.args = '';
          this.state.currentBlockType = 'tool_use';
          output += formatAnthropicSSE('content_block_start', {
            type: 'content_block_start',
            index: slot.anthropicIdx,
            content_block: {
              type: 'tool_use',
              id: tc.id || `toolu_${Date.now()}`,
              name: tc.function.name,
              input: {},
            },
          });
        } else if (tc.function?.arguments !== undefined) {
          // 按 index 追加到正确的 slot
          slot.args += tc.function.arguments;
          output += formatAnthropicSSE('content_block_delta', {
            type: 'content_block_delta',
            index: slot.anthropicIdx >= 0 ? slot.anthropicIdx : this.state.nextBlockIndex - 1,
            delta: { type: 'input_json_delta', partial_json: tc.function.arguments },
          });
        }
      }
      return output || null;
    }

    // 文本增量
    if (delta?.content) {
      if (this.state.currentBlockType !== 'text') {
        // 从 tool_use 切换到 text → 升序关闭所有仍开放的工具块
        if (this.state.currentBlockType === 'tool_use') {
          output += this.closeBlocks(this.state.openBlocks);
          this.state.openBlocks = [];
        }
        this.state.currentBlockType = 'text';
        const textBlockIdx = this.state.nextBlockIndex++;
        this.state.openBlocks.push(textBlockIdx);
        output += formatAnthropicSSE('content_block_start', {
          type: 'content_block_start',
          index: textBlockIdx,
          content_block: { type: 'text', text: '' },
        }) + formatAnthropicSSE('content_block_delta', {
          type: 'content_block_delta',
          index: textBlockIdx,
          delta: { type: 'text_delta', text: delta.content },
        });
        return output;
      }
      return output + formatAnthropicSSE('content_block_delta', {
        type: 'content_block_delta',
        index: this.state.nextBlockIndex - 1,
        delta: { type: 'text_delta', text: delta.content },
      });
    }

    // finish_reason（非流式 chunk）→ 不在这里发，flush 统一处理
    return output || null;
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
        this.state.currentBlockType = obj.content_block?.type || null;
        if (this.state.currentBlockType === 'tool_use') {
          // OpenAI tool_calls 索引从 0 递增，不能直接用 Anthropic 块索引
          // （块序列中 tool_use 前面可能有 text/thinking 块，块索引会串位）
          const toolIdx = this.state.toolSlots.length;
          this.state.toolSlots.push({ anthropicIdx: obj.index ?? 0, name: obj.content_block?.name || '', args: '' });
          const chunk: any = {
            id: this.state.msgId,
            object: 'chat.completion.chunk',
            created: this.created,
            model: this.state.model,
            choices: [{ index: 0, delta: { tool_calls: [{ index: toolIdx, id: obj.content_block.id, type: 'function', function: { name: obj.content_block.name, arguments: '' } }] }, finish_reason: null }],
          };
          return formatOpenAISSE(chunk);
        }
        // text block 可能直接携带初始文本（短响应场景）
        if (this.state.currentBlockType === 'text' && obj.content_block?.text) {
          const chunk: any = {
            id: this.state.msgId,
            object: 'chat.completion.chunk',
            created: this.created,
            model: this.state.model,
            choices: [{ index: 0, delta: { content: obj.content_block.text }, finish_reason: null }],
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
          // 按 Anthropic 块索引反查 tool_calls 槽位，保证增量落到正确的工具调用上
          const slotIdx = this.state.toolSlots.findIndex(s => s.anthropicIdx === (obj.index ?? 0));
          const toolIdx = slotIdx >= 0 ? slotIdx : this.state.toolSlots.length;
          const chunk: any = {
            id: this.state.msgId,
            object: 'chat.completion.chunk',
            created: this.created,
            model: this.state.model,
            choices: [{ index: 0, delta: { tool_calls: [{ index: toolIdx, function: { arguments: obj.delta.partial_json } }] }, finish_reason: null }],
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
