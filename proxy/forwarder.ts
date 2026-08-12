/** HTTP 转发模块 — 非流式 + 流式 SSE 透传 */

export async function forwardRequest(
  method: string,
  url: string,
  headers: Record<string, string>,
  body?: Buffer,
): Promise<{ status: number; json: any; text: string; durationMs: number }> {
  const cleanHeaders: Record<string, string> = {};
  const skip = new Set(['host', 'transfer-encoding', 'connection', 'content-length']);
  for (const [k, v] of Object.entries(headers)) {
    if (!skip.has(k.toLowerCase()) && v) cleanHeaders[k] = v;
  }

  const start = performance.now();
  const res = await fetch(url, {
    method,
    headers: cleanHeaders,
    body: body?.length ? new Uint8Array(body) : undefined,
  });
  const text = await res.text();
  const durationMs = Math.round(performance.now() - start);

  let json: any = null;
  try { json = JSON.parse(text); } catch {}

  return { status: res.status, json, text, durationMs };
}

export async function forwardStream(
  method: string,
  url: string,
  headers: Record<string, string>,
  body?: Buffer,
): Promise<{
  stream: ReadableStream;
  collectResult: () => Promise<{ status: number; json: null; text: string; durationMs: number }>;
}> {
  const cleanHeaders: Record<string, string> = {};
  const skip = new Set(['host', 'transfer-encoding', 'connection', 'content-length']);
  for (const [k, v] of Object.entries(headers)) {
    if (!skip.has(k.toLowerCase()) && v) cleanHeaders[k] = v;
  }

  const start = performance.now();
  const res = await fetch(url, {
    method,
    headers: cleanHeaders,
    body: body?.length ? new Uint8Array(body) : undefined,
  });

  const reader = res.body!.getReader();
  const chunks: Uint8Array[] = [];
  const status = res.status;
  let settled = false;
  let streamDoneResolve: () => void;
  const streamDone = new Promise<void>(r => { streamDoneResolve = r; });
  /** 确保 streamDone 只 resolve 一次，避免泄漏 */
  const finish = () => { if (!settled) { settled = true; streamDoneResolve(); } };

  const stream = new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          finish();
        } else {
          chunks.push(value);
          controller.enqueue(value);
        }
      } catch {
        // 网络错误或 reader 被取消
        finish();
        try { controller.close(); } catch {}
      }
    },
    cancel() {
      reader.cancel();
      finish();
    },
  });

  return {
    stream,
    // collectResult 等待 stream 完全消费后再读取 chunks，避免竞态
    collectResult: async () => {
      await streamDone;
      const durationMs = Math.round(performance.now() - start);
      const raw = Buffer.concat(chunks).toString('utf-8');
      // buildCleanResponseBody 一次解析完成 content + usage 提取，recorder 后续直接读 text
      const text = buildCleanResponseBody(raw) ?? raw;
      return { status, json: null, text, durationMs };
    },
  };
}

/**
 * 从 SSE 原始文本中提取干净的结构化响应体。
 * 支持 Anthropic（content_block_delta.text）和 OpenAI（choices[].delta.content）格式。
 * 返回 JSON 字符串，解析失败时返回 null。
 */
export function buildCleanResponseBody(raw: string): string | null {
  // 统一换行符，然后按双换行分割 SSE 事件
  const events = raw.replace(/\r\n/g, '\n').split(/\n\n/);

  // ── 尝试 Anthropic 格式 ──
  const anthropicText: string[] = [];
  const anthropicThinking: string[] = [];
  let anthropicModel = '';
  let anthropicInputUsage: any = null;   // message_start.message.usage（input_tokens、缓存）
  let anthropicOutputUsage: any = null;  // message_delta.usage（output_tokens）
  for (const event of events) {
    for (const line of event.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      try {
        const obj = JSON.parse(line.slice(6));
        if (obj.type === 'message_start') {
          anthropicModel = obj.message?.model || '';
          // message_start 包含 input_tokens 和缓存相关 token
          if (obj.message?.usage) {
            anthropicInputUsage = obj.message.usage;
          }
        } else if (obj.type === 'content_block_start') {
          // content_block 初始文本：流式传输时为空，短响应时可能直接携带完整文本
          if (obj.content_block?.type === 'text' && obj.content_block.text) {
            anthropicText.push(obj.content_block.text);
          } else if (obj.content_block?.type === 'tool_use' && obj.content_block.name) {
            anthropicText.push(`[调用工具: ${obj.content_block.name}]`);
          } else if (obj.content_block?.type === 'thinking' && obj.content_block.thinking) {
            // 思考块的初始文本（短思考响应可能无后续 delta）→ 独立收集，与正文分离
            anthropicThinking.push(obj.content_block.thinking);
          }
        } else if (obj.type === 'content_block_delta') {
          // 文本增量（text_delta）、工具调用增量（input_json_delta）、思考增量（thinking_delta）
          if (obj.delta?.text) {
            anthropicText.push(obj.delta.text);
          } else if (obj.delta?.partial_json) {
            anthropicText.push(obj.delta.partial_json);
          } else if (obj.delta?.thinking) {
            anthropicThinking.push(obj.delta.thinking);
          }
        } else if (obj.type === 'message_delta' && obj.usage) {
          // message_delta 包含 output_tokens
          anthropicOutputUsage = obj.usage;
        }
      } catch {}
    }
  }
  // 合并 usage：input 侧键来自 message_start，output_tokens 来自 message_delta（权威）
  // 兼容网关可能任一侧回显另一侧的键，显式指定来源避免覆盖
  const anthropicUsage: any = { ...(anthropicInputUsage || {}) };
  if (anthropicOutputUsage) {
    // output_tokens 始终以 message_delta 为准（仅在该键实际存在时才覆盖）
    if (anthropicOutputUsage.output_tokens != null) {
      anthropicUsage.output_tokens = anthropicOutputUsage.output_tokens;
    }
    // message_delta 其他非 output_tokens 键，仅在 input 侧不存在时纳入
    for (const k of Object.keys(anthropicOutputUsage)) {
      if (!(k in anthropicUsage) && anthropicOutputUsage[k] != null) anthropicUsage[k] = anthropicOutputUsage[k];
    }
  }
  // 至少有一侧非空 usage 即可（排除网关回显的 usage:{} 空对象）
  const hasAnthropicUsage = (anthropicInputUsage != null && Object.keys(anthropicInputUsage).length > 0)
    || (anthropicOutputUsage != null && Object.keys(anthropicOutputUsage).length > 0);
  if (anthropicText.length > 0 || anthropicThinking.length > 0 || hasAnthropicUsage) {
    return JSON.stringify({
      model: anthropicModel,
      // 正文非空时才输出 content 字段（纯思考响应无正文，不输出该键）
      ...(anthropicText.length > 0 ? { content: anthropicText.join('') } : {}),
      ...(anthropicThinking.length > 0 ? { thinking: anthropicThinking.join('') } : {}),
      usage: Object.keys(anthropicUsage).length > 0 ? anthropicUsage : null,
    });
  }

  // ── 尝试 OpenAI 格式（含 DeepSeek/Qwen 等兼容格式） ──
  const openaiText: string[] = [];
  let openaiModel = '';
  let openaiUsage: any = null;
  let openaiRole = '';
  for (const event of events) {
    for (const line of event.split('\n')) {
      if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
      try {
        const obj = JSON.parse(line.slice(6));
        if (obj.model) openaiModel = obj.model;
        if (obj.usage) openaiUsage = obj.usage;
        const delta = obj.choices?.[0]?.delta;
        if (delta) {
          if (delta.role) openaiRole = delta.role;
          // 推理内容在前，确保思考→答案的阅读顺序（DeepSeek-R1 / Qwen-reasoner / o 系列）
          if (delta.reasoning_content) openaiText.push(delta.reasoning_content);
          if (delta.content) openaiText.push(delta.content);
          // 工具调用增量（先标记名再参数，避免顺序颠倒）
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              if (tc.function?.name) openaiText.push(`[调用工具: ${tc.function.name}]`);
              if (tc.function?.arguments) openaiText.push(tc.function.arguments);
            }
          }
        }
      } catch {}
    }
  }
  // 有文本内容或有非空 token 数据时均返回结构化 JSON（空对象 {} 不计为有效 usage）
  const hasOpenaiUsage = openaiUsage && Object.keys(openaiUsage).length > 0;
  if (openaiText.length > 0 || hasOpenaiUsage) {
    return JSON.stringify({
      model: openaiModel,
      role: openaiRole,
      content: openaiText.join(''),
      usage: hasOpenaiUsage ? openaiUsage : null,
    });
  }

  return null;
}
