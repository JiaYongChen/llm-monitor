/** Mock LLM Server 测试（上游路径） */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createMockServer } from './mock-llm-server.js';
import type { FastifyInstance } from 'fastify';

describe('mock LLM server', () => {
  let app: FastifyInstance;
  let url: string;

  beforeAll(async () => {
    const server = await createMockServer();
    app = server.app;
    url = server.url;
  });
  afterAll(() => app.close());

  it('Anthropic 上游 /v1/messages', async () => {
    const res = await fetch(`${url}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(res.status).toBe(200);
    const data: any = await res.json();
    expect(data.usage.input_tokens).toBe(500);
    expect(data.usage.cache_read_input_tokens).toBe(200);
  });

  it('OpenAI 上游 /v1/chat/completions', async () => {
    const res = await fetch(`${url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] }),
    });
    const data: any = await res.json();
    expect(data.usage.prompt_tokens_details.cached_tokens).toBe(300);
  });

  it('DeepSeek 根据 model 前缀区分格式', async () => {
    const res = await fetch(`${url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'hi' }] }),
    });
    const data: any = await res.json();
    expect(data.usage.prompt_cache_hit_tokens).toBe(800);
  });

  it('Qwen 根据 model 前缀区分格式', async () => {
    const res = await fetch(`${url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'qwen-flash', messages: [{ role: 'user', content: 'hi' }] }),
    });
    const data: any = await res.json();
    expect(data.usage.prompt_tokens_details.cached_tokens).toBe(400);
  });

  it('429 错误', async () => {
    const res = await fetch(`${url}/v1/messages?error=429`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'c' }),
    });
    expect(res.status).toBe(429);
  });
});
