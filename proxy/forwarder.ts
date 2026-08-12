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

  // 诊断：上游返回错误状态码时记录（用 clone 避免消费原始 body）
  if (res.status >= 400) {
    res.clone().text()
      .then(body => console.log(`[proxy] ⚠ 上游错误 status=${res.status} | ${body.slice(0, 300)}`))
      .catch(() => console.log(`[proxy] ⚠ 上游错误 status=${res.status} | (无法读取响应体)`));
  }

  const reader = res.body!.getReader();
  const chunks: Uint8Array[] = [];
  const status = res.status;
  let settled = false;
  let streamError: string | null = null;
  let streamDoneResolve: () => void;
  const streamDone = new Promise<void>(r => { streamDoneResolve = r; });
  /** 确保 streamDone 只 resolve 一次，避免泄漏 */
  const finish = (err?: string) => { if (!settled) { settled = true; if (err) streamError = err; streamDoneResolve(); } };

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
      } catch (err: any) {
        // 网络错误或 reader 被取消 — 记录具体原因用于诊断
        finish(err?.message || String(err));
        try { controller.close(); } catch {}
      }
    },
    cancel() {
      reader.cancel();
      // 已有数据时 cancel 属于正常结束（Fastify/客户端主动关闭），不记录为异常
      finish(chunks.length === 0 ? '客户端取消（无数据）' : undefined);
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
      // 诊断：流异常结束时记录原因
      if (streamError) {
        console.log(`[proxy] ⚠ 流异常结束 | ${streamError} | 已接收 ${chunks.length} 个分块 ${raw.length} 字节 | ${durationMs}ms`);
      }
      return { status, json: null, text, durationMs };
    },
  };
}

/**
 * 从 SSE 原始文本中提取干净的结构化响应体。
 * 支持三种格式：Anthropic、OpenAI Responses API（/responses）、OpenAI Chat Completions。
 * 返回 JSON 字符串，解析失败时返回 null。
 */
/** 从 SSE data: 行提取 JSON 文本，兼容 "data:{...}" 和 "data: {...}" 两种格式 */
function parseDataLine(line: string): any | null {
  const json = line.startsWith('data: ') ? line.slice(6) : line.slice(5);
  try { return JSON.parse(json); } catch { return null; }
}

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
      if (!line.startsWith('data:')) continue;
      try {
        const obj = parseDataLine(line);
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

  // ── 尝试 OpenAI Responses API 格式（/responses 端点，Codex 等新工具使用）──
  const respText: string[] = [];
  const respThinking: string[] = [];
  let respModel = '';
  let respUsage: any = null;
  for (const event of events) {
    // 从 SSE event: 行提取事件类型（兼容 "event:type" 和 "event: type" 两种格式）
    let sseEventType = '';
    for (const line of event.split('\n')) {
      if (line.startsWith('event:')) {
        sseEventType = line.slice(6).trim();
        continue;
      }
      if (!line.startsWith('data:') || line === 'data: [DONE]') continue;
      try {
        const obj = parseDataLine(line);
        // 优先用 data JSON 的 type，缺失时回退到 SSE event: 行
        const eventType = obj.type || sseEventType;
        // response.created → 获取模型名
        if (eventType === 'response.created') {
          respModel = obj.response?.model || '';
          // 某些供应商可能在 response.created 中就带 usage（如 input_tokens）
          if (obj.response?.usage && Object.keys(obj.response.usage).length > 0) {
            respUsage = { ...respUsage, ...obj.response.usage };
          }
        }
        // response.output_text.delta → 文本增量
        else if (eventType === 'response.output_text.delta' && obj.delta) {
          respText.push(obj.delta);
        }
        // response.reasoning_text.delta → 思考增量
        else if (eventType === 'response.reasoning_text.delta' && obj.delta) {
          respThinking.push(obj.delta);
        }
        // response.completed → 获取 usage（最终权威）
        else if (eventType === 'response.completed') {
          if (obj.response?.usage) respUsage = { ...respUsage, ...obj.response.usage };
        }
        // response.output_item.done → 某些供应商在此携带 usage
        else if (eventType === 'response.output_item.done') {
          if (obj.item?.usage) respUsage = { ...respUsage, ...obj.item.usage };
        }
      } catch {}
    }
  }
  const hasRespUsage = respUsage && Object.keys(respUsage).length > 0;
  // 诊断：检测到 Responses API 事件但缺少关键数据时输出详情
  if (!hasRespUsage && respText.length === 0 && respThinking.length === 0) {
    if (respModel) {
      console.log(`[proxy] ⚠ Responses API 检测到 response.created（模型=${respModel}）但无后续 delta/completed 事件 — 流可能被提前取消`);
    }
  } else if (!hasRespUsage) {
    console.log(`[proxy] ⚠ Responses API 有文本（${respText.length} 段）但缺少 usage（response.completed 未收到或格式不符）`);
  }
  if (respText.length > 0 || respThinking.length > 0 || hasRespUsage) {
    return JSON.stringify({
      model: respModel,
      // 正文非空时才输出 content 字段（纯思考响应无正文，不输出该键）
      ...(respText.length > 0 ? { content: respText.join('') } : {}),
      ...(respThinking.length > 0 ? { thinking: respThinking.join('') } : {}),
      usage: hasRespUsage ? respUsage : null,
    });
  }

  // ── 尝试 OpenAI Chat Completions 格式（含 DeepSeek/Qwen 等兼容格式）──
  const openaiText: string[] = [];
  const openaiThinking: string[] = [];
  let openaiModel = '';
  let openaiUsage: any = null;
  let openaiRole = '';
  for (const event of events) {
    for (const line of event.split('\n')) {
      if (!line.startsWith('data:') || line === 'data: [DONE]') continue;
      try {
        const obj = parseDataLine(line);
        if (obj.model) openaiModel = obj.model;
        if (obj.usage) openaiUsage = obj.usage;
        const delta = obj.choices?.[0]?.delta;
        if (delta) {
          if (delta.role) openaiRole = delta.role;
          // 推理内容（DeepSeek-R1 / Qwen-reasoner / o 系列）→ 独立收集，与正文分离
          if (delta.reasoning_content) openaiThinking.push(delta.reasoning_content);
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
  if (openaiText.length > 0 || openaiThinking.length > 0 || hasOpenaiUsage) {
    return JSON.stringify({
      model: openaiModel,
      role: openaiRole,
      // 正文非空时才输出 content 字段（纯思考响应无正文，不输出该键）
      ...(openaiText.length > 0 ? { content: openaiText.join('') } : {}),
      ...(openaiThinking.length > 0 ? { thinking: openaiThinking.join('') } : {}),
      usage: hasOpenaiUsage ? openaiUsage : null,
    });
  }

  // 三种格式均未匹配 → 输出前 300 字符供诊断
  console.log(`[proxy] ⚠ buildCleanResponseBody 未匹配任何格式 | 首 300 字符: ${raw.slice(0, 300).replace(/\n/g, '\\n')}`);
  return null;
}
