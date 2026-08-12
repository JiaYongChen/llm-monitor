import { describe, it, expect } from 'vitest';
import { buildCleanResponseBody } from '../proxy/forwarder.js';

/** 构造 Anthropic SSE 流。
 *  真实格式：input/cache 在 message_start.message.usage，output 在 message_delta.usage */
function anthropicSSE(model: string, text: string, inputUsage: object, outputUsage: object): string {
  const lines: string[] = [];
  lines.push(`event: message_start`);
  lines.push(`data: ${JSON.stringify({ type: 'message_start', message: { model, id: 'msg_1', type: 'message', role: 'assistant', content: [] as any[], stop_reason: null, usage: inputUsage } })}`);
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
  lines.push(`data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: outputUsage })}`);
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
    const raw = anthropicSSE('claude-sonnet-5', '你好，世界！',
      { input_tokens: 500, cache_read_input_tokens: 100 },
      { output_tokens: 300 },
    );
    const result = buildCleanResponseBody(raw);
    expect(result).not.toBeNull();
    const obj = JSON.parse(result!);
    expect(obj.model).toBe('claude-sonnet-5');
    expect(obj.content).toBe('你好，世界！');
    expect(obj.usage).toEqual({ input_tokens: 500, cache_read_input_tokens: 100, output_tokens: 300 });
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
    const raw = anthropicSSE('claude-opus-5', 'test',
      { input_tokens: 10 },
      { output_tokens: 5 },
    ).replace(/\n/g, '\r\n');
    const result = buildCleanResponseBody(raw);
    expect(result).not.toBeNull();
    const obj = JSON.parse(result!);
    expect(obj.model).toBe('claude-opus-5');
    expect(obj.content).toBe('test');
    expect(obj.usage).toEqual({ input_tokens: 10, output_tokens: 5 });
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

  it('★ Anthropic usage 合并：message_start(input) + message_delta(output)', () => {
    const raw = anthropicSSE('claude-sonnet-5', '你好',
      { input_tokens: 500, cache_read_input_tokens: 200, cache_creation_input_tokens: 100 },
      { output_tokens: 300 },
    );
    const obj = JSON.parse(buildCleanResponseBody(raw)!);
    // 验证 input 侧 token（来自 message_start）和 output 侧 token（来自 message_delta）正确合并
    expect(obj.usage).toEqual({
      input_tokens: 500, cache_read_input_tokens: 200, cache_creation_input_tokens: 100,
      output_tokens: 300,
    });
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

  it('★ 纯 tool_use 响应（无文本）也能提取 usage', () => {
    const lines = [
      'event: message_start',
      `data: ${JSON.stringify({ type: 'message_start', message: { model: 'claude-sonnet-5', id: 'msg_1', type: 'message', role: 'assistant', content: [], usage: { input_tokens: 200 } } })}`,
      '',
      'event: content_block_start',
      `data: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tool_1', name: 'read_file', input: {} } })}`,
      '',
      'event: content_block_delta',
      `data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"file_path":"/tmp/test"}' } })}`,
      '',
      'event: content_block_stop',
      `data: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}`,
      '',
      'event: message_delta',
      `data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 30 } })}`,
      '',
      'event: message_stop',
      `data: ${JSON.stringify({ type: 'message_stop' })}`,
      '',
    ].join('\n');
    const result = buildCleanResponseBody(lines);
    expect(result).not.toBeNull();
    const obj = JSON.parse(result!);
    expect(obj.usage).toEqual({ input_tokens: 200, output_tokens: 30 });
    // 应包含工具调用标识
    expect(obj.content).toContain('调用工具');
    expect(obj.content).toContain('read_file');
  });

  it('★ 纯思考响应也能提取 usage', () => {
    const lines = [
      'event: message_start',
      `data: ${JSON.stringify({ type: 'message_start', message: { model: 'claude-sonnet-5', id: 'msg_1', type: 'message', role: 'assistant', content: [], usage: { input_tokens: 500 } } })}`,
      '',
      'event: content_block_start',
      `data: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '我需要分析这个文件的内容' } })}`,
      '',
      'event: content_block_delta',
      `data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '先读取文件，然后理解其结构' } })}`,
      '',
      'event: content_block_stop',
      `data: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}`,
      '',
      'event: message_delta',
      `data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 50 } })}`,
      '',
      'event: message_stop',
      `data: ${JSON.stringify({ type: 'message_stop' })}`,
      '',
    ].join('\n');
    const result = buildCleanResponseBody(lines);
    expect(result).not.toBeNull();
    const obj = JSON.parse(result!);
    expect(obj.usage).toEqual({ input_tokens: 500, output_tokens: 50 });
  });

  it('★ OpenAI 纯 tool_calls 响应（无文本）也能提取 usage', () => {
    const lines = [
      `data: ${JSON.stringify({ id: 'chatcmpl_1', object: 'chat.completion.chunk', model: 'gpt-4o', choices: [{ index: 0, delta: { role: 'assistant', content: null, tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '' } }] }, finish_reason: null }] })}`,
      '',
      `data: ${JSON.stringify({ id: 'chatcmpl_1', object: 'chat.completion.chunk', model: 'gpt-4o', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":"Beijing"}' } }] } }] })}`,
      '',
      `data: ${JSON.stringify({ id: 'chatcmpl_1', object: 'chat.completion.chunk', model: 'gpt-4o', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })}`,
      '',
      'data: [DONE]',
      '',
    ].join('\n');
    const result = buildCleanResponseBody(lines);
    expect(result).not.toBeNull();
    const obj = JSON.parse(result!);
    expect(obj.usage).toEqual({ prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 });
    expect(obj.content).toContain('调用工具');
    expect(obj.content).toContain('get_weather');
  });

  it('空流无 usage 仍返回 null', () => {
    const lines = [
      'event: message_start',
      `data: ${JSON.stringify({ type: 'message_start', message: { model: 'claude-sonnet-5', id: 'msg_1', type: 'message', role: 'assistant', content: [], usage: null } })}`,
      '',
      'event: message_stop',
      `data: ${JSON.stringify({ type: 'message_stop' })}`,
      '',
    ].join('\n');
    const result = buildCleanResponseBody(lines);
    expect(result).toBeNull();
  });

  it('★ Anthropic thinking_delta 与正文分离', () => {
    const lines = [
      'event: message_start',
      `data: ${JSON.stringify({ type: 'message_start', message: { model: 'claude-opus-5', id: 'msg_1', type: 'message', role: 'assistant', content: [], usage: { input_tokens: 500 } } })}`,
      '',
      'event: content_block_start',
      `data: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '先分析' } })}`,
      '',
      'event: content_block_delta',
      `data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '需求，再给方案' } })}`,
      '',
      'event: content_block_stop',
      `data: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}`,
      '',
      'event: content_block_start',
      `data: ${JSON.stringify({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } })}`,
      '',
      'event: content_block_delta',
      `data: ${JSON.stringify({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '最终答案' } })}`,
      '',
      'event: content_block_stop',
      `data: ${JSON.stringify({ type: 'content_block_stop', index: 1 })}`,
      '',
      'event: message_delta',
      `data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 30 } })}`,
      '',
      'event: message_stop',
      `data: ${JSON.stringify({ type: 'message_stop' })}`,
      '',
    ].join('\n');
    const obj = JSON.parse(buildCleanResponseBody(lines)!);
    expect(obj.thinking).toBe('先分析需求，再给方案');
    expect(obj.content).toBe('最终答案');
    expect(obj.usage).toEqual({ input_tokens: 500, output_tokens: 30 });
  });

  it('★ 纯思考响应（无正文无 usage）也返回，含 thinking 字段', () => {
    const lines = [
      'event: message_start',
      `data: ${JSON.stringify({ type: 'message_start', message: { model: 'claude-opus-5', id: 'msg_1', type: 'message', role: 'assistant', content: [], usage: null } })}`,
      '',
      'event: content_block_start',
      `data: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '只有思考' } })}`,
      '',
      'event: content_block_stop',
      `data: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}`,
      '',
      'event: message_stop',
      `data: ${JSON.stringify({ type: 'message_stop' })}`,
      '',
    ].join('\n');
    const result = buildCleanResponseBody(lines);
    expect(result).not.toBeNull();
    const obj = JSON.parse(result!);
    expect(obj.thinking).toBe('只有思考');
    expect(obj.content).toBeUndefined();
  });

  // ── OpenAI Responses API 格式（/responses 端点）──

  /** 构造 OpenAI Responses API SSE 流 */
  function responsesSSE(model: string, content: string, usage: object): string {
    const lines: string[] = [];
    lines.push(`event: response.created`);
    lines.push(`data: ${JSON.stringify({ type: 'response.created', response: { id: 'resp_1', object: 'response', model, status: 'in_progress' } })}`);
    lines.push('');
    if (content) {
      lines.push(`event: response.output_text.delta`);
      lines.push(`data: ${JSON.stringify({ type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: content })}`);
      lines.push('');
    }
    lines.push(`event: response.completed`);
    lines.push(`data: ${JSON.stringify({ type: 'response.completed', response: { id: 'resp_1', model, usage } })}`);
    lines.push('');
    return lines.join('\n');
  }

  it('★ 从 Responses API SSE 中提取 content + usage', () => {
    const raw = responsesSSE('gpt-5.6-sol', '你好，世界！', { input_tokens: 100, output_tokens: 50, total_tokens: 150 });
    const result = buildCleanResponseBody(raw);
    expect(result).not.toBeNull();
    const obj = JSON.parse(result!);
    expect(obj.model).toBe('gpt-5.6-sol');
    expect(obj.content).toBe('你好，世界！');
    expect(obj.usage).toEqual({ input_tokens: 100, output_tokens: 50, total_tokens: 150 });
  });

  it('★ Responses API 多段 delta 拼接', () => {
    const lines = [
      'event: response.created',
      `data: ${JSON.stringify({ type: 'response.created', response: { id: 'resp_1', model: 'gpt-5.6-sol' } })}`,
      '',
      'event: response.output_text.delta',
      `data: ${JSON.stringify({ type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: '第一段' })}`,
      '',
      'event: response.output_text.delta',
      `data: ${JSON.stringify({ type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: '第二段' })}`,
      '',
      'event: response.completed',
      `data: ${JSON.stringify({ type: 'response.completed', response: { id: 'resp_1', usage: { input_tokens: 10, output_tokens: 4 } } })}`,
      '',
    ].join('\n');
    const obj = JSON.parse(buildCleanResponseBody(lines)!);
    expect(obj.content).toBe('第一段第二段');
    expect(obj.model).toBe('gpt-5.6-sol');
  });

  it('★ Responses API 无 content 有 usage 也返回', () => {
    const lines = [
      'event: response.created',
      `data: ${JSON.stringify({ type: 'response.created', response: { id: 'resp_1', model: 'gpt-5.6-sol' } })}`,
      '',
      'event: response.completed',
      `data: ${JSON.stringify({ type: 'response.completed', response: { id: 'resp_1', usage: { input_tokens: 50, output_tokens: 0 } } })}`,
      '',
    ].join('\n');
    const result = buildCleanResponseBody(lines);
    expect(result).not.toBeNull();
    const obj = JSON.parse(result!);
    expect(obj.content).toBeUndefined();
    expect(obj.usage).toEqual({ input_tokens: 50, output_tokens: 0 });
  });

  it('★ Responses API reasoning_text.delta 与正文分离', () => {
    const lines = [
      'event: response.created',
      `data: ${JSON.stringify({ type: 'response.created', response: { id: 'resp_1', model: 'gpt-5.6-sol' } })}`,
      '',
      'event: response.reasoning_text.delta',
      `data: ${JSON.stringify({ type: 'response.reasoning_text.delta', item_id: 'rsn_1', output_index: 0, content_index: 0, delta: '思考中' })}`,
      '',
      'event: response.reasoning_text.delta',
      `data: ${JSON.stringify({ type: 'response.reasoning_text.delta', item_id: 'rsn_1', output_index: 0, content_index: 0, delta: '…继续' })}`,
      '',
      'event: response.output_text.delta',
      `data: ${JSON.stringify({ type: 'response.output_text.delta', item_id: 'msg_1', output_index: 1, content_index: 0, delta: '最终答案' })}`,
      '',
      'event: response.completed',
      `data: ${JSON.stringify({ type: 'response.completed', response: { id: 'resp_1', usage: { input_tokens: 100, output_tokens: 50 } } })}`,
      '',
    ].join('\n');
    const obj = JSON.parse(buildCleanResponseBody(lines)!);
    expect(obj.thinking).toBe('思考中…继续');
    expect(obj.content).toBe('最终答案');
    expect(obj.model).toBe('gpt-5.6-sol');
  });

  it('★ Responses API 仅 event: 行含 type（data JSON 无 type 字段）', () => {
    // 兼容供应商（如 Qwen）可能只在 event: 行写类型，data JSON 不含 type
    const lines = [
      'event: response.created',
      `data: ${JSON.stringify({ response: { id: 'resp_1', model: 'qwen-max' } })}`,
      '',
      'event: response.output_text.delta',
      `data: ${JSON.stringify({ delta: '你好' })}`,
      '',
      'event: response.output_text.delta',
      `data: ${JSON.stringify({ delta: '世界' })}`,
      '',
      'event: response.completed',
      `data: ${JSON.stringify({ response: { usage: { input_tokens: 50, output_tokens: 30, total_tokens: 80 } } })}`,
      '',
    ].join('\n');
    const result = buildCleanResponseBody(lines);
    expect(result).not.toBeNull();
    const obj = JSON.parse(result!);
    expect(obj.model).toBe('qwen-max');
    expect(obj.content).toBe('你好世界');
    expect(obj.usage).toEqual({ input_tokens: 50, output_tokens: 30, total_tokens: 80 });
  });

  it('★ Responses API event:type 无空格格式（Qwen 兼容）', () => {
    // Qwen SSE 使用 "event:response.created"（冒号后无空格）
    const lines = [
      'id:1',
      'event:response.created',
      ':HTTP_STATUS/200',
      `data:${JSON.stringify({ response: { id: 'resp_1', model: 'qwen3.8-max', output: [] } })}`,
      '',
      'event:response.output_text.delta',
      `data:${JSON.stringify({ delta: '你好' })}`,
      '',
      'event:response.completed',
      `data:${JSON.stringify({ response: { usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 } } })}`,
      '',
    ].join('\n');
    const result = buildCleanResponseBody(lines);
    expect(result).not.toBeNull();
    const obj = JSON.parse(result!);
    expect(obj.model).toBe('qwen3.8-max');
    expect(obj.content).toBe('你好');
    expect(obj.usage).toEqual({ input_tokens: 100, output_tokens: 50, total_tokens: 150 });
  });

  it('★ OpenAI reasoning_content 与 content 分离', () => {
    const lines = [
      `data: ${JSON.stringify({ id: 'chatcmpl_1', object: 'chat.completion.chunk', model: 'deepseek-r1', choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: '分析中' } }] })}`,
      '',
      `data: ${JSON.stringify({ id: 'chatcmpl_1', object: 'chat.completion.chunk', model: 'deepseek-r1', choices: [{ index: 0, delta: { reasoning_content: '，继续推导' } }] })}`,
      '',
      `data: ${JSON.stringify({ id: 'chatcmpl_1', object: 'chat.completion.chunk', model: 'deepseek-r1', choices: [{ index: 0, delta: { content: '最终回答' } }] })}`,
      '',
      `data: ${JSON.stringify({ id: 'chatcmpl_1', object: 'chat.completion.chunk', model: 'deepseek-r1', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}`,
      '',
      'data: [DONE]',
      '',
    ].join('\n');
    const obj = JSON.parse(buildCleanResponseBody(lines)!);
    expect(obj.thinking).toBe('分析中，继续推导');
    expect(obj.content).toBe('最终回答');
    expect(obj.model).toBe('deepseek-r1');
  });
});
