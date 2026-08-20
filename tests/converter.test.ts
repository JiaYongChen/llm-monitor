/** 格式转换模块测试 */
import { describe, it, expect } from 'vitest';
import { needsConversion, convertRequest, convertResponse, createResponseTransform } from '../proxy/converter';

// ═══════════════════════════════ 检测 ═══════════════════════════════

describe('needsConversion', () => {
  it('相同格式不需要转换', () => {
    expect(needsConversion('anthropic', 'anthropic')).toBe(false);
    expect(needsConversion('openai', 'openai')).toBe(false);
  });

  it('不同格式需要转换', () => {
    expect(needsConversion('anthropic', 'openai')).toBe(true);
    expect(needsConversion('openai', 'anthropic')).toBe(true);
  });
});

// ═══════════════════════════════ 请求转换 ═══════════════════════════════

describe('convertRequest: Anthropic → OpenAI', () => {
  const from = 'anthropic', to = 'openai';

  it('基本文本消息', () => {
    const { body } = convertRequest(JSON.stringify({
      model: 'claude-sonnet-4-5', max_tokens: 100, stream: true,
      messages: [{ role: 'user', content: '你好' }],
    }), from, to);
    const out = JSON.parse(body);
    expect(out.model).toBe('claude-sonnet-4-5');
    expect(out.messages[0]).toEqual({ role: 'user', content: '你好' });
  });

  it('将 Anthropic content 数组展平为字符串', () => {
    const { body } = convertRequest(JSON.stringify({
      model: 'claude-sonnet-4-5', max_tokens: 100,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }, { type: 'text', text: ' World' }] }],
    }), from, to);
    const out = JSON.parse(body);
    expect(out.messages[0].content).toBe('Hello World');
  });

  it('system 字符串 → 头部 system 消息', () => {
    const { body } = convertRequest(JSON.stringify({
      model: 'claude-sonnet-4-5', max_tokens: 100, system: '你是一个助手',
      messages: [{ role: 'user', content: 'Hi' }],
    }), from, to);
    const out = JSON.parse(body);
    expect(out.messages[0]).toEqual({ role: 'system', content: '你是一个助手' });
    expect(out.messages[1]).toEqual({ role: 'user', content: 'Hi' });
  });

  it('system 数组 → 合并为 system 消息', () => {
    const { body } = convertRequest(JSON.stringify({
      model: 'claude-sonnet-4-5', max_tokens: 100,
      system: [{ type: 'text', text: '角色1' }, { type: 'text', text: '角色2' }],
      messages: [{ role: 'user', content: 'Hi' }],
    }), from, to);
    const out = JSON.parse(body);
    expect(out.messages[0]).toEqual({ role: 'system', content: '角色1\n角色2' });
  });

  it('stop_sequences → stop（数组）', () => {
    const { body } = convertRequest(JSON.stringify({
      model: 'claude-sonnet-4-5', max_tokens: 100,
      messages: [{ role: 'user', content: 'Hi' }],
      stop_sequences: ['###', 'END'],
    }), from, to);
    const out = JSON.parse(body);
    expect(out.stop).toEqual(['###', 'END']);
  });

  it('tools input_schema → function.parameters', () => {
    const { body } = convertRequest(JSON.stringify({
      model: 'claude-sonnet-4-5', max_tokens: 100,
      messages: [{ role: 'user', content: '天气' }],
      tools: [{ name: 'get_weather', description: '获取天气', input_schema: { type: 'object', properties: { city: { type: 'string' } } } }],
    }), from, to);
    const out = JSON.parse(body);
    expect(out.tools[0]).toEqual({
      type: 'function',
      function: { name: 'get_weather', description: '获取天气', parameters: { type: 'object', properties: { city: { type: 'string' } } } },
    });
  });

  it('tool_choice type 映射', () => {
    // auto
    let { body } = convertRequest(JSON.stringify({
      model: 'x', max_tokens: 10, messages: [{ role: 'user', content: 'a' }], tool_choice: { type: 'auto' },
    }), from, to);
    expect(JSON.parse(body).tool_choice).toBe('auto');
    // any
    ({ body } = convertRequest(JSON.stringify({
      model: 'x', max_tokens: 10, messages: [{ role: 'user', content: 'a' }], tool_choice: { type: 'any' },
    }), from, to));
    expect(JSON.parse(body).tool_choice).toBe('required');
    // tool
    ({ body } = convertRequest(JSON.stringify({
      model: 'x', max_tokens: 10, messages: [{ role: 'user', content: 'a' }], tool_choice: { type: 'tool', name: 'get_weather' },
    }), from, to));
    expect(JSON.parse(body).tool_choice).toEqual({ type: 'function', function: { name: 'get_weather' } });
  });

  it('top_k 丢弃，其他透传字段保留', () => {
    const { body } = convertRequest(JSON.stringify({
      model: 'claude-sonnet-4-5', max_tokens: 100, temperature: 0.7, top_p: 0.9, top_k: 40, stream: true,
      messages: [{ role: 'user', content: 'Hi' }],
    }), from, to);
    const out = JSON.parse(body);
    expect(out.temperature).toBe(0.7);
    expect(out.top_p).toBe(0.9);
    expect(out.top_k).toBeUndefined();
    expect(out.stream).toBe(true);
  });

  it('thinking 启用 → reasoning_effort', () => {
    const { body } = convertRequest(JSON.stringify({
      model: 'claude-sonnet-4-5', max_tokens: 100,
      messages: [{ role: 'user', content: 'Hi' }],
      thinking: { type: 'enabled', budget_tokens: 4000 },
    }), from, to);
    expect(JSON.parse(body).reasoning_effort).toBe('medium');
  });

  it('路径变为 /v1/chat/completions', () => {
    const { path } = convertRequest(JSON.stringify({
      model: 'claude-sonnet-4-5', max_tokens: 100,
      messages: [{ role: 'user', content: 'Hi' }],
    }), from, to);
    expect(path).toBe('/v1/chat/completions');
  });

  it('消息历史中的 tool_use → tool_calls', () => {
    const { body } = convertRequest(JSON.stringify({
      model: 'claude-sonnet-4-5', max_tokens: 100,
      messages: [
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_001', name: 'read', input: { path: '/f' } }] },
      ],
    }), from, to);
    const out = JSON.parse(body);
    const assistantMsg = out.messages[1];
    expect(assistantMsg.role).toBe('assistant');
    expect(assistantMsg.tool_calls[0].function.name).toBe('read');
    expect(assistantMsg.tool_calls[0].function.arguments).toBe('{"path":"/f"}');
  });
});

describe('convertRequest: OpenAI → Anthropic', () => {
  const from = 'openai', to = 'anthropic';

  it('基本文本消息', () => {
    const { body } = convertRequest(JSON.stringify({
      model: 'gpt-4o', max_tokens: 100, stream: true,
      messages: [{ role: 'user', content: 'Hello' }],
    }), from, to);
    const out = JSON.parse(body);
    expect(out.model).toBe('gpt-4o');
    expect(out.messages[0]).toEqual({ role: 'user', content: [{ type: 'text', text: 'Hello' }] });
  });

  it('system 消息提取到顶层', () => {
    const { body } = convertRequest(JSON.stringify({
      model: 'gpt-4o', max_tokens: 100,
      messages: [
        { role: 'system', content: '你是助手' },
        { role: 'user', content: 'Hi' },
      ],
    }), from, to);
    const out = JSON.parse(body);
    expect(out.system).toBe('你是助手');
    expect(out.messages[0].role).toBe('user');
  });

  it('多条 system 消息 → 数组', () => {
    const { body } = convertRequest(JSON.stringify({
      model: 'gpt-4o', max_tokens: 100,
      messages: [
        { role: 'system', content: '规则1' },
        { role: 'system', content: '规则2' },
        { role: 'user', content: 'Hi' },
      ],
    }), from, to);
    const out = JSON.parse(body);
    expect(Array.isArray(out.system)).toBe(true);
    expect(out.system[0].text).toBe('规则1');
    expect(out.system[1].text).toBe('规则2');
  });

  it('stop → stop_sequences', () => {
    const { body } = convertRequest(JSON.stringify({
      model: 'gpt-4o', max_tokens: 100,
      messages: [{ role: 'user', content: 'Hi' }],
      stop: ['###'],
    }), from, to);
    const out = JSON.parse(body);
    expect(out.stop_sequences).toEqual(['###']);
  });

  it('单字符串 stop → 数组', () => {
    const { body } = convertRequest(JSON.stringify({
      model: 'gpt-4o', max_tokens: 100,
      messages: [{ role: 'user', content: 'Hi' }],
      stop: '###',
    }), from, to);
    const out = JSON.parse(body);
    expect(out.stop_sequences).toEqual(['###']);
  });

  it('tools function.parameters → input_schema', () => {
    const { body } = convertRequest(JSON.stringify({
      model: 'gpt-4o', max_tokens: 100,
      messages: [{ role: 'user', content: '天气' }],
      tools: [{ type: 'function', function: { name: 'get_weather', description: '天气', parameters: { type: 'object' } } }],
    }), from, to);
    const out = JSON.parse(body);
    expect(out.tools[0]).toEqual({ name: 'get_weather', description: '天气', input_schema: { type: 'object' } });
  });

  it('tool_choice 映射', () => {
    // auto
    let { body } = convertRequest(JSON.stringify({
      model: 'x', max_tokens: 10, messages: [{ role: 'user', content: 'a' }], tool_choice: 'auto',
    }), from, to);
    expect(JSON.parse(body).tool_choice).toEqual({ type: 'auto' });
    // required
    ({ body } = convertRequest(JSON.stringify({
      model: 'x', max_tokens: 10, messages: [{ role: 'user', content: 'a' }], tool_choice: 'required',
    }), from, to));
    expect(JSON.parse(body).tool_choice).toEqual({ type: 'any' });
    // function object
    ({ body } = convertRequest(JSON.stringify({
      model: 'x', max_tokens: 10, messages: [{ role: 'user', content: 'a' }],
      tool_choice: { type: 'function', function: { name: 'get_weather' } },
    }), from, to));
    expect(JSON.parse(body).tool_choice).toEqual({ type: 'tool', name: 'get_weather' });
  });

  it('reasoning_effort → thinking', () => {
    const { body } = convertRequest(JSON.stringify({
      model: 'gpt-4o', max_tokens: 100,
      messages: [{ role: 'user', content: 'Hi' }],
      reasoning_effort: 'high',
    }), from, to);
    const out = JSON.parse(body);
    expect(out.thinking.type).toBe('enabled');
  });

  it('tool 角色消息 → tool_result', () => {
    const { body } = convertRequest(JSON.stringify({
      model: 'gpt-4o', max_tokens: 100,
      messages: [
        { role: 'user', content: 'Hi' },
        { role: 'tool', tool_call_id: 'call_123', content: 'result text' },
      ],
    }), from, to);
    const out = JSON.parse(body);
    const toolMsg = out.messages[1];
    expect(toolMsg.role).toBe('user');
    expect(toolMsg.content[0].type).toBe('tool_result');
    expect(toolMsg.content[0].tool_use_id).toBe('call_123');
    expect(toolMsg.content[0].content).toBe('result text');
  });

  it('assistant 消息含 tool_calls → content 数组含 tool_use', () => {
    const { body } = convertRequest(JSON.stringify({
      model: 'gpt-4o', max_tokens: 100,
      messages: [
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"path":"/f"}' } }] },
      ],
    }), from, to);
    const out = JSON.parse(body);
    const assistantMsg = out.messages[1];
    expect(assistantMsg.content[0].type).toBe('tool_use');
    expect(assistantMsg.content[0].name).toBe('read');
    expect(assistantMsg.content[0].input).toEqual({ path: '/f' });
  });

  it('路径变为 /v1/messages', () => {
    const { path } = convertRequest(JSON.stringify({
      model: 'gpt-4o', max_tokens: 100,
      messages: [{ role: 'user', content: 'Hi' }],
    }), from, to);
    expect(path).toBe('/v1/messages');
  });
});

// ═══════════════════════════════ 非流式响应转换 ═══════════════════════════════

describe('convertResponse: OpenAI → Anthropic', () => {
  const from = 'openai', to = 'anthropic';

  it('基本文本响应', () => {
    const result = convertResponse(JSON.stringify({
      id: 'chatcmpl-123', model: 'gpt-4o', object: 'chat.completion',
      choices: [{ index: 0, message: { role: 'assistant', content: '你好！' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }), from, to);
    const out = JSON.parse(result);
    expect(out.type).toBe('message');
    expect(out.role).toBe('assistant');
    expect(out.content[0]).toEqual({ type: 'text', text: '你好！' });
    expect(out.stop_reason).toBe('end_turn');
    expect(out.usage.input_tokens).toBe(10);
    expect(out.usage.output_tokens).toBe(5);
  });

  it('工具调用', () => {
    const result = convertResponse(JSON.stringify({
      id: 'chatcmpl-456', model: 'gpt-4o',
      choices: [{ index: 0, message: { role: 'assistant', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"path":"/f"}' } }] }, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }), from, to);
    const out = JSON.parse(result);
    expect(out.stop_reason).toBe('tool_use');
    expect(out.content[0].type).toBe('tool_use');
    expect(out.content[0].name).toBe('read');
    expect(out.content[0].input).toEqual({ path: '/f' });
  });

  it('finish_reason 映射', () => {
    const testStop = (finish: string, expected: string) => {
      const r = convertResponse(JSON.stringify({
        id: 'x', model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: 'x' }, finish_reason: finish }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      }), from, to);
      expect(JSON.parse(r).stop_reason).toBe(expected);
    };
    testStop('stop', 'end_turn');
    testStop('length', 'max_tokens');
    testStop('tool_calls', 'tool_use');
  });
});

describe('convertResponse: Anthropic → OpenAI', () => {
  const from = 'anthropic', to = 'openai';

  it('基本文本响应', () => {
    const result = convertResponse(JSON.stringify({
      id: 'msg_123', type: 'message', role: 'assistant', model: 'claude-sonnet-4-5',
      content: [{ type: 'text', text: '你好！' }],
      stop_reason: 'end_turn', stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5 },
    }), from, to);
    const out = JSON.parse(result);
    expect(out.object).toBe('chat.completion');
    expect(out.choices[0].message.content).toBe('你好！');
    expect(out.choices[0].finish_reason).toBe('stop');
    expect(out.usage.prompt_tokens).toBe(10);
    expect(out.usage.completion_tokens).toBe(5);
    expect(out.usage.total_tokens).toBe(15);
  });

  it('工具调用', () => {
    const result = convertResponse(JSON.stringify({
      id: 'msg_456', type: 'message', role: 'assistant', model: 'claude-sonnet-4-5',
      content: [{ type: 'tool_use', id: 'toolu_001', name: 'read', input: { path: '/f' } }],
      stop_reason: 'tool_use', stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5 },
    }), from, to);
    const out = JSON.parse(result);
    expect(out.choices[0].finish_reason).toBe('tool_calls');
    expect(out.choices[0].message.tool_calls[0].function.name).toBe('read');
    expect(out.choices[0].message.tool_calls[0].function.arguments).toBe('{"path":"/f"}');
  });

  it('finish_reason 映射', () => {
    const testStop = (stop: string, expected: string) => {
      const r = convertResponse(JSON.stringify({
        id: 'x', type: 'message', role: 'assistant', model: 'm', content: [{ type: 'text', text: 'x' }], stop_reason: stop, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 },
      }), from, to);
      expect(JSON.parse(r).choices[0].finish_reason).toBe(expected);
    };
    testStop('end_turn', 'stop');
    testStop('max_tokens', 'length');
    testStop('tool_use', 'tool_calls');
  });
});

// ═══════════════════════════════ 流式转换 ═══════════════════════════════

describe('createResponseTransform', () => {
  it('相同格式返回透传 transform', () => {
    const t = createResponseTransform('anthropic', 'anthropic');
    expect(t).toBeInstanceOf(TransformStream);
  });

  it('不同格式返回转换 transform', () => {
    const t = createResponseTransform('openai', 'anthropic');
    expect(t).toBeInstanceOf(TransformStream);
    const t2 = createResponseTransform('anthropic', 'openai');
    expect(t2).toBeInstanceOf(TransformStream);
  });
});

/** 将 SSE 文本完整喂入 transform 并收集输出 */
async function runTransform(t: TransformStream<Uint8Array, Uint8Array>, input: string): Promise<string> {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const reader = t.readable.getReader();
  const writer = t.writable.getWriter();
  const readAll = (async () => {
    let out = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      out += dec.decode(value);
    }
    return out;
  })();
  await writer.write(enc.encode(input));
  await writer.close();
  return readAll;
}

/** 收集 SSE 输出中的全部事件对象 */
function parseSSEOutput(out: string): any[] {
  const events: any[] = [];
  for (const section of out.split('\n\n')) {
    if (!section.trim()) continue;
    for (const line of section.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      if (line.slice(6) === '[DONE]') { events.push({ _done: true }); continue; }
      try { events.push(JSON.parse(line.slice(6))); } catch {}
    }
  }
  return events;
}

describe('A→O 请求转换：流式 usage 注入', () => {
  it('stream:true 时注入 stream_options.include_usage', () => {
    const { body } = convertRequest(JSON.stringify({
      model: 'claude-sonnet-4-5', max_tokens: 100, stream: true,
      messages: [{ role: 'user', content: 'Hi' }],
    }), 'anthropic', 'openai');
    const out = JSON.parse(body);
    expect(out.stream_options).toEqual({ include_usage: true });
  });

  it('非流式请求不注入 stream_options', () => {
    const { body } = convertRequest(JSON.stringify({
      model: 'claude-sonnet-4-5', max_tokens: 100,
      messages: [{ role: 'user', content: 'Hi' }],
    }), 'anthropic', 'openai');
    expect(JSON.parse(body).stream_options).toBeUndefined();
  });
});

describe('A→O 请求转换：tool_result 图片保留', () => {
  it('tool_result 内容块中的图片移入后续用户消息而非丢弃', () => {
    const { body } = convertRequest(JSON.stringify({
      model: 'x', max_tokens: 10,
      messages: [{
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_1', content: [
            { type: 'text', text: '截图如下' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } },
          ] },
        ],
      }],
    }), 'anthropic', 'openai');
    const out = JSON.parse(body);
    expect(out.messages[0]).toMatchObject({ role: 'tool', tool_call_id: 'toolu_1', content: '截图如下' });
    const extra = out.messages[1];
    expect(extra.role).toBe('user');
    expect(Array.isArray(extra.content)).toBe(true);
    expect(extra.content.some((p: any) => p.type === 'image_url' && p.image_url.url.includes('base64,AAA'))).toBe(true);
  });
});

describe('O→A 请求转换：Responses API 与兜底', () => {
  it('input 为纯字符串 → 单条 user 消息（不逐字符遍历）', () => {
    const { body } = convertRequest(JSON.stringify({
      model: 'gpt-5', input: '帮我写代码',
    }), 'openai', 'anthropic');
    const out = JSON.parse(body);
    expect(out.messages).toHaveLength(1);
    expect(out.messages[0]).toEqual({ role: 'user', content: [{ type: 'text', text: '帮我写代码' }] });
  });

  it('input 条目数组：message/function_call/function_call_output 正确映射', () => {
    const { body } = convertRequest(JSON.stringify({
      model: 'gpt-5',
      instructions: '你是助手',
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: '查天气' }] },
        { type: 'function_call', name: 'get_weather', call_id: 'call_1', arguments: '{"city":"北京"}' },
        { type: 'function_call_output', call_id: 'call_1', output: '晴' },
      ],
    }), 'openai', 'anthropic');
    const out = JSON.parse(body);
    expect(out.system).toBe('你是助手');
    expect(out.messages[0]).toEqual({ role: 'user', content: [{ type: 'text', text: '查天气' }] });
    // function_call → assistant tool_use
    expect(out.messages[1].role).toBe('assistant');
    expect(out.messages[1].content[0]).toMatchObject({ type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: '北京' } });
    // function_call_output → user tool_result
    expect(out.messages[2].role).toBe('user');
    expect(out.messages[2].content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'call_1', content: '晴' });
  });

  it('缺 max_tokens 与 max_output_tokens 时兜底 8192', () => {
    const { body } = convertRequest(JSON.stringify({
      model: 'gpt-5', input: 'Hi',
    }), 'openai', 'anthropic');
    expect(JSON.parse(body).max_tokens).toBe(8192);
  });

  it('max_output_tokens 映射为 max_tokens', () => {
    const { body } = convertRequest(JSON.stringify({
      model: 'gpt-5', input: 'Hi', max_output_tokens: 2000,
    }), 'openai', 'anthropic');
    expect(JSON.parse(body).max_tokens).toBe(2000);
  });

  it('连续 role:tool 消息合并为一条 user 消息（角色交替）', () => {
    const { body } = convertRequest(JSON.stringify({
      model: 'gpt-4o', max_tokens: 100,
      messages: [
        { role: 'user', content: '并行查两个' },
        { role: 'assistant', content: null, tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'a', arguments: '{}' } },
          { id: 'call_2', type: 'function', function: { name: 'b', arguments: '{}' } },
        ] },
        { role: 'tool', tool_call_id: 'call_1', content: 'r1' },
        { role: 'tool', tool_call_id: 'call_2', content: 'r2' },
      ],
    }), 'openai', 'anthropic');
    const out = JSON.parse(body);
    expect(out.messages).toHaveLength(3);
    const merged = out.messages[2];
    expect(merged.role).toBe('user');
    expect(merged.content).toHaveLength(2);
    expect(merged.content[0].tool_use_id).toBe('call_1');
    expect(merged.content[1].tool_use_id).toBe('call_2');
  });

  it('thinking 启用时 max_tokens 不低于 budget_tokens', () => {
    const { body } = convertRequest(JSON.stringify({
      model: 'gpt-5', input: 'Hi', max_tokens: 100, reasoning_effort: 'high',
    }), 'openai', 'anthropic');
    const out = JSON.parse(body);
    expect(out.thinking.budget_tokens).toBe(8000);
    expect(out.max_tokens).toBeGreaterThan(8000);
  });
});

describe('O→A 流式转换：stop_reason 与块收尾', () => {
  const openAISSE = (obj: any) => `data: ${JSON.stringify(obj)}\n\n`;

  it('finish_reason=tool_calls → stop_reason=tool_use（不再硬编码 end_turn）', async () => {
    const input =
      openAISSE({ id: 'c1', model: 'gpt-4o', choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] }) +
      openAISSE({ id: 'c1', model: 'gpt-4o', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read', arguments: '' } }] }, finish_reason: null }] }) +
      openAISSE({ id: 'c1', model: 'gpt-4o', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{}' } }] }, finish_reason: null }] }) +
      openAISSE({ id: 'c1', model: 'gpt-4o', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }) +
      'data: [DONE]\n\n';
    const out = await runTransform(createResponseTransform('openai', 'anthropic'), input);
    const events = parseSSEOutput(out);
    const msgDelta = events.find((e: any) => e.type === 'message_delta');
    expect(msgDelta.delta.stop_reason).toBe('tool_use');
  });

  it('finish_reason=length → stop_reason=max_tokens', async () => {
    const input =
      openAISSE({ id: 'c1', model: 'm', choices: [{ index: 0, delta: { content: '文本' }, finish_reason: null }] }) +
      openAISSE({ id: 'c1', model: 'm', choices: [{ index: 0, delta: {}, finish_reason: 'length' }] }) +
      'data: [DONE]\n\n';
    const out = await runTransform(createResponseTransform('openai', 'anthropic'), input);
    const msgDelta = parseSSEOutput(out).find((e: any) => e.type === 'message_delta');
    expect(msgDelta.delta.stop_reason).toBe('max_tokens');
  });

  it('text → 并行 tool → text：content_block_stop 升序且不重复', async () => {
    const input =
      openAISSE({ id: 'c1', model: 'm', choices: [{ index: 0, delta: { content: '前置文本' }, finish_reason: null }] }) +
      openAISSE({ id: 'c1', model: 'm', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'a', arguments: '' } }] }, finish_reason: null }] }) +
      openAISSE({ id: 'c1', model: 'm', choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: 'call_2', type: 'function', function: { name: 'b', arguments: '' } }] }, finish_reason: null }] }) +
      openAISSE({ id: 'c1', model: 'm', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{}' } }] }, finish_reason: null }] }) +
      openAISSE({ id: 'c1', model: 'm', choices: [{ index: 0, delta: { content: '后置文本' }, finish_reason: null }] }) +
      openAISSE({ id: 'c1', model: 'm', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) +
      'data: [DONE]\n\n';
    const out = await runTransform(createResponseTransform('openai', 'anthropic'), input);
    const stops = parseSSEOutput(out).filter((e: any) => e.type === 'content_block_stop').map((e: any) => e.index);
    // 升序且无重复（块 0=text 1=toolA 2=toolB 3=text）
    expect(stops).toEqual([0, 1, 2, 3]);
  });
});

describe('A→O 流式转换：tool_calls 索引', () => {
  const anthropicSSE = (event: string, obj: any) => `event: ${event}\ndata: ${JSON.stringify(obj)}\n\n`;

  it('tool_use 前有 text 块时 tool_calls 索引仍从 0 开始', async () => {
    const input =
      anthropicSSE('message_start', { type: 'message_start', message: { id: 'msg_1', model: 'claude', usage: { input_tokens: 5 } } }) +
      anthropicSSE('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) +
      anthropicSSE('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '我来查' } }) +
      anthropicSSE('content_block_stop', { type: 'content_block_stop', index: 0 }) +
      anthropicSSE('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'read', input: {} } }) +
      anthropicSSE('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"p":1}' } }) +
      anthropicSSE('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 3 } });
    const out = await runTransform(createResponseTransform('anthropic', 'openai'), input);
    const events = parseSSEOutput(out);
    const tcChunks = events.filter((e: any) => e.choices?.[0]?.delta?.tool_calls);
    expect(tcChunks.length).toBeGreaterThanOrEqual(2);
    // 全部 tool_calls 增量都落在索引 0（而非块索引 1）
    for (const c of tcChunks) {
      expect(c.choices[0].delta.tool_calls[0].index).toBe(0);
    }
    expect(tcChunks[0].choices[0].delta.tool_calls[0].function.name).toBe('read');
    expect(tcChunks[1].choices[0].delta.tool_calls[0].function.arguments).toBe('{"p":1}');
  });
});

// ═══════════════════════════════ 边界情况 ═══════════════════════════════

describe('边界情况', () => {
  it('convertResponse: 非 JSON 输入直接返回原文', () => {
    const result = convertResponse('不是 JSON', 'openai', 'anthropic');
    expect(result).toBe('不是 JSON');
  });

  it('convertRequest: 空消息数组', () => {
    const { body } = convertRequest(JSON.stringify({
      model: 'x', max_tokens: 10, messages: [],
    }), 'anthropic', 'openai');
    const out = JSON.parse(body);
    expect(out.messages).toEqual([]);
  });

  it('convertRequest: 未知格式组合返回原 body', () => {
    const raw = JSON.stringify({ model: 'x', messages: [] });
    const { body, path } = convertRequest(raw, 'unknown1' as any, 'unknown2' as any);
    expect(body).toBe(raw);
    expect(path).toBe('');
  });

  it('convertResponse: 未知格式组合返回原 text', () => {
    const text = '{"a":1}';
    expect(convertResponse(text, 'unknown1' as any, 'unknown2' as any)).toBe(text);
  });
});
