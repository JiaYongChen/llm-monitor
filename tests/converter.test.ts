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
