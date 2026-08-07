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

  const stream = new ReadableStream({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
      } else {
        chunks.push(value);
        controller.enqueue(value);
      }
    },
  });

  return {
    stream,
    collectResult: async () => {
      const durationMs = Math.round(performance.now() - start);
      const raw = Buffer.concat(chunks).toString('utf-8');
      let json: any = null;
      try { json = extractUsageFromSSE(raw); } catch {}
      return { status, json, text: raw, durationMs };
    },
  };
}

/** 从 SSE 文本中提取 usage JSON */
function extractUsageFromSSE(raw: string): any {
  const lines = raw.split(/\r?\n/);
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
    const events = raw.split(/\n\n/);
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
