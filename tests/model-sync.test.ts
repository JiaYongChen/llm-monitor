import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { probeModelsOpenAI, probeModelsAnthropic } from '../proxy/model-sync.js';

// 本地 mock：验证鉴权头 + 返回模型列表
let app: FastifyInstance;
let url: string;

beforeAll(async () => {
  app = Fastify({ logger: false });
  // OpenAI 兼容格式：Bearer 鉴权
  app.get('/openai/v1/models', async (req, reply) => {
    if (req.headers.authorization !== 'Bearer sk-openai') return reply.status(401).send({ error: 'unauthorized' });
    return { object: 'list', data: [{ id: 'Gpt-5.6-Sol' }, { id: 'gpt-5.6-luna' }] };
  });
  // Anthropic 格式：x-api-key 鉴权
  app.get('/anthropic/v1/models', async (req, reply) => {
    if (req.headers['x-api-key'] !== 'sk-ant') return reply.status(401).send({ error: 'unauthorized' });
    return { data: [{ id: 'claude-opus-5' }, { id: 'claude-sonnet-5' }], has_more: false, first_id: null, last_id: null };
  });
  // 触发超时用：挂起响应
  app.get('/slow/v1/models', async () => new Promise(() => {}));
  await app.listen({ port: 0, host: '127.0.0.1' });
  url = `http://127.0.0.1:${(app.server.address() as any).port}`;
});
afterAll(async () => {
  // /slow 挂起响应连接需先销毁，否则 close 等待不活跃连接直至 hook 超时
  app.server.closeAllConnections?.();
  await app.close();
});

describe('probeModels', () => {
  it('OpenAI 兼容格式：Bearer 头 + data.id 提取 + 小写归一化', async () => {
    const models = await probeModelsOpenAI(`${url}/openai`, 'sk-openai');
    expect(models).toEqual(['gpt-5.6-sol', 'gpt-5.6-luna']);
  });
  it('OpenAI 兼容格式：鉴权失败抛错', async () => {
    await expect(probeModelsOpenAI(`${url}/openai`, 'wrong-key')).rejects.toThrow(/HTTP 401/);
  });
  it('Anthropic 格式：x-api-key 头 + data.id 提取', async () => {
    const models = await probeModelsAnthropic(`${url}/anthropic`, 'sk-ant');
    expect(models).toEqual(['claude-opus-5', 'claude-sonnet-5']);
  });
  it('超时中止抛错', async () => {
    // 探测超时在此测试中缩短为 1s，通过环境变量控制
    process.env.LLM_MONITOR_PROBE_TIMEOUT_MS = '1000';
    try {
      await expect(probeModelsOpenAI(`${url}/slow`, 'sk')).rejects.toThrow();
    } finally {
      delete process.env.LLM_MONITOR_PROBE_TIMEOUT_MS;
    }
  });
  it('畸形 JSON 抛错', async () => {
    await expect(probeModelsOpenAI(`${url}/missing`, 'sk')).rejects.toThrow();
  });
});
