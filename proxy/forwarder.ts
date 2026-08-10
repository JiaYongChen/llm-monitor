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

  // Anthropic 格式：message_delta 事件中的 usage
  if (!usage) {
    const events = normalized.split(/\n\n/);
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
  let anthropicUsage: any = null;
  for (const event of events) {
    for (const line of event.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      try {
        const obj = JSON.parse(line.slice(6));
        if (obj.type === 'message_start') {
          anthropicModel = obj.message?.model || '';
        } else if (obj.type === 'content_block_start') {
          // content_block 初始文本：流式传输时为空，短响应时可能直接携带完整文本
          if (obj.content_block?.type === 'text' && obj.content_block.text) {
            anthropicText.push(obj.content_block.text);
          }
        } else if (obj.type === 'content_block_delta' && obj.delta?.text) {
          anthropicText.push(obj.delta.text);
        } else if (obj.type === 'message_delta' && obj.usage) {
          anthropicUsage = obj.usage;
        }
      } catch {}
    }
  }
  if (anthropicText.length > 0) {
    return JSON.stringify({
      model: anthropicModel,
      content: anthropicText.join(''),
      usage: anthropicUsage,
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
        }
      } catch {}
    }
  }
  if (openaiText.length > 0) {
    return JSON.stringify({
      model: openaiModel,
      role: openaiRole,
      content: openaiText.join(''),
      usage: openaiUsage,
    });
  }

  return null;
}
