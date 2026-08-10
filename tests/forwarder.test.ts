import { describe, it, expect } from 'vitest';
import { buildCleanResponseBody } from '../proxy/forwarder.js';

/** 构造 Anthropic SSE 流 */
function anthropicSSE(model: string, text: string, usage: object): string {
  const lines: string[] = [];
  lines.push(`event: message_start`);
  lines.push(`data: ${JSON.stringify({ type: 'message_start', message: { model, id: 'msg_1', type: 'message', role: 'assistant', content: [] as any[], stop_reason: null, usage: null } })}`);
  lines.push('');
  lines.push(`event: content_block_start`);
  lines.push(`data: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}`);
  lines.push('');
  lines.push(`event: content_block_delta`);
  lines.push(`data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })}`);
  lines.push('');
  lines.push(`event: content_block_stop`);
  lines.push(`data: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}`);
  lines.push('');
  lines.push(`event: message_delta`);
  lines.push(`data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage })}`);
  lines.push('');
  lines.push(`event: message_stop`);
  lines.push(`data: ${JSON.stringify({ type: 'message_stop' })}`);
  lines.push('');
  return lines.join('\n');
}

/** 构造 OpenAI 兼容 SSE 流 */
function openaiSSE(model: string, content: string, usage: object): string {
  const lines: string[] = [];
  lines.push(`data: ${JSON.stringify({ id: 'chatcmpl_1', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] })}`);
  lines.push('');
  lines.push(`data: ${JSON.stringify({ id: 'chatcmpl_1', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { content } }] })}`);
  lines.push('');
  lines.push(`data: ${JSON.stringify({ id: 'chatcmpl_1', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage })}`);
  lines.push('');
  lines.push('data: [DONE]');
  lines.push('');
  return lines.join('\n');
}

describe('buildCleanResponseBody', () => {
  it('从 Anthropic SSE 中提取 content + usage', () => {
    const raw = anthropicSSE('claude-sonnet-5', '你好，世界！', { input_tokens: 500, output_tokens: 300 });
    const result = buildCleanResponseBody(raw);
    expect(result).not.toBeNull();
    const obj = JSON.parse(result!);
    expect(obj.model).toBe('claude-sonnet-5');
    expect(obj.content).toBe('你好，世界！');
    expect(obj.usage).toEqual({ input_tokens: 500, output_tokens: 300 });
  });

  it('从 OpenAI SSE 中提取 content + usage', () => {
    const raw = openaiSSE('gpt-4o', 'Hello!', { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 });
    const result = buildCleanResponseBody(raw);
    expect(result).not.toBeNull();
    const obj = JSON.parse(result!);
    expect(obj.model).toBe('gpt-4o');
    expect(obj.content).toBe('Hello!');
    expect(obj.usage).toEqual({ prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 });
  });

  it('处理 \\r\\n 换行符', () => {
    const raw = anthropicSSE('claude-opus-5', 'test', { input_tokens: 10, output_tokens: 5 })
      .replace(/\n/g, '\r\n');
    const result = buildCleanResponseBody(raw);
    expect(result).not.toBeNull();
    const obj = JSON.parse(result!);
    expect(obj.model).toBe('claude-opus-5');
    expect(obj.content).toBe('test');
  });

  it('空 SSE 流返回 null', () => {
    const result = buildCleanResponseBody('');
    expect(result).toBeNull();
  });

  it('仅有 [DONE] 标记的流返回 null', () => {
    const result = buildCleanResponseBody('data: [DONE]\n\n');
    expect(result).toBeNull();
  });

  it('提取 OpenAI role 信息', () => {
    const raw = openaiSSE('gpt-4o', 'Hello!', { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
    const obj = JSON.parse(buildCleanResponseBody(raw)!);
    expect(obj.role).toBe('assistant');
  });

  it('从 Anthropic content_block_start 中提取初始文本（无 delta 的短响应）', () => {
    // 模拟短响应：文本完全在 content_block_start 中，不发送 content_block_delta
    const lines = [
      'event: message_start',
      `data: ${JSON.stringify({ type: 'message_start', message: { model: 'claude-haiku-4-5', id: 'msg_1', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Hi' }], stop_reason: null, usage: null } })}`,
      '',
      'event: content_block_start',
      `data: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'Hi' } })}`,
      '',
      'event: content_block_stop',
      `data: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}`,
      '',
      'event: message_delta',
      `data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 10, output_tokens: 1 } })}`,
      '',
      'event: message_stop',
      `data: ${JSON.stringify({ type: 'message_stop' })}`,
      '',
    ].join('\n');
    const result = buildCleanResponseBody(lines);
    expect(result).not.toBeNull();
    const obj = JSON.parse(result!);
    expect(obj.model).toBe('claude-haiku-4-5');
    expect(obj.content).toBe('Hi');
    expect(obj.usage).toEqual({ input_tokens: 10, output_tokens: 1 });
  });
});
