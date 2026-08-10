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
  collectResult: () => Promise<{ status: number; json: any; text: string; durationMs: number }>;
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
      let json: any = null;
      try { json = extractUsageFromSSE(raw); } catch {}
      // 将原始 SSE 文本转换为干净的结构化 JSON，便于前端展示和 recorder 解析
      const cleanText = buildCleanResponseBody(raw) ?? raw;
      return { status, json, text: cleanText, durationMs };
    },
  };
}

/** 从 SSE 文本中提取 usage JSON */
function extractUsageFromSSE(raw: string): any {
  const normalized = raw.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
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

  // Anthropic 格式：usage 分散在 message_start（input）和 message_delta（output）中
  if (!usage) {
    let inputUsage: any = null;
    let outputUsage: any = null;
    const events = normalized.split(/\n\n/);
    for (const event of events) {
      for (const line of event.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        try {
          const obj = JSON.parse(line.slice(6));
          if (obj.type === 'message_start' && obj.message?.usage) {
            inputUsage = obj.message.usage;
          } else if (obj.type === 'message_delta' && obj.usage) {
            outputUsage = obj.usage;
          }
        } catch {}
      }
    }
    const merged = { ...(inputUsage || {}), ...(outputUsage || {}) };
    if (Object.keys(merged).length > 0) usage = merged;
  }

  return usage;
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
          } else if (obj.content_block?.type === 'tool_use') {
            anthropicText.push(`[调用工具: ${obj.content_block.name}]`);
          }
        } else if (obj.type === 'content_block_delta') {
          // 文本增量（text_delta）、工具调用增量（input_json_delta）、思考增量（thinking_delta）
          if (obj.delta?.text) {
            anthropicText.push(obj.delta.text);
          } else if (obj.delta?.partial_json) {
            anthropicText.push(obj.delta.partial_json);
          } else if (obj.delta?.thinking) {
            anthropicText.push(obj.delta.thinking);
          }
        } else if (obj.type === 'message_delta' && obj.usage) {
          // message_delta 包含 output_tokens
          anthropicOutputUsage = obj.usage;
        }
      } catch {}
    }
  }
  // 合并两个事件中的 usage：input 侧来自 message_start，output 侧来自 message_delta
  const anthropicUsage = { ...(anthropicInputUsage || {}), ...(anthropicOutputUsage || {}) };
  const hasAnthropicUsage = Object.keys(anthropicUsage).length > 0;
  // 有文本内容或 token 数据时均返回结构化 JSON，避免无文本响应（如纯 tool_use）丢失 usage
  if (anthropicText.length > 0 || hasAnthropicUsage) {
    return JSON.stringify({
      model: anthropicModel,
      content: anthropicText.join('') || '(非文本响应)',
      usage: hasAnthropicUsage ? anthropicUsage : undefined,
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
          if (delta.content) openaiText.push(delta.content);
          // 工具调用增量（tool_calls）
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              if (tc.function?.arguments) openaiText.push(tc.function.arguments);
              if (tc.function?.name) openaiText.push(`[调用工具: ${tc.function.name}]`);
            }
          }
        }
      } catch {}
    }
  }
  // 有文本内容或有 token 数据时均返回结构化 JSON
  if (openaiText.length > 0 || openaiUsage) {
    return JSON.stringify({
      model: openaiModel,
      role: openaiRole,
      content: openaiText.join('') || '(非文本响应)',
      usage: openaiUsage,
    });
  }

  return null;
}
