import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { probeModelsOpenAI, probeModelsAnthropic, syncProvider, getSyncStatus } from '../proxy/model-sync.js';
import { initDb, closeDb, listPricing, addProviderConfig, listProviderModels, getSetting, upsertPricing } from '../proxy/db.js';
import { createTempDb } from './setup.js';

// 本地 mock：验证鉴权头 + 返回模型列表
let app: FastifyInstance;
let url: string;
let tmp: ReturnType<typeof createTempDb>;

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
  // 探测 mock：返回 3 个模型
  app.get('/probe/v1/models', async (req, reply) => {
    if (req.headers.authorization !== 'Bearer sk-ok') return reply.status(401).send({ error: 'unauthorized' });
    return { object: 'list', data: [{ id: 'gpt-5.6-sol' }, { id: 'gpt-5.6-luna' }, { id: 'unknown-xyz' }] };
  });
  // 定价源 mock：liteLLM fixture（内联 Task 1 的 LITELLM_FIXTURE；补 gpt-5.6-luna 条目以满足 priced_count=2 断言）
  const LITELLM_FIXTURE = {
    sample_spec: { input_cost_per_token: 0, output_cost_per_token: 0 },
    'gpt-5.6-sol': { input_cost_per_token: 5e-6, output_cost_per_token: 30e-6, cache_read_input_token_cost: 2.5e-6 },
    'gpt-5.6-luna': { input_cost_per_token: 4e-6, output_cost_per_token: 20e-6, cache_read_input_token_cost: 2e-6 },
    'claude-sonnet-5': { input_cost_per_token: 3e-6, output_cost_per_token: 15e-6, cache_read_input_token_cost: 0.3e-6 },
    'claude-haiku-4-5-20251001': { input_cost_per_token: 1e-6, output_cost_per_token: 5e-6 },
    'moonshot/kimi-k2': { input_cost_per_token: 0.5e-6, output_cost_per_token: 1.5e-6 },
    'anthropic.claude-opus-4-6-v1': { input_cost_per_token: 5e-6, output_cost_per_token: 25e-6, cache_read_input_token_cost: 0.5e-6 },
  };
  app.get('/prices.json', async () => LITELLM_FIXTURE);
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

// 集成场景：mock 供应商 /v1/models + mock 定价源（通过环境变量注入）
describe('syncProvider 集成', () => {
  beforeAll(async () => {
    tmp = createTempDb();
    await initDb(tmp.dbPath);
    // 定价源注入 mock（/prices.json），避免真实网络；定价源失败用例临时覆盖为失效地址后清理
    process.env.LLM_MONITOR_PRICING_URLS = JSON.stringify({ liteLLM: `${url}/prices.json` });
  });
  afterAll(() => { closeDb(); tmp.cleanup(); });

  it('api_key 为空 → no_key，不探测', async () => {
    addProviderConfig('empty-key-prov', 'https://example.com', '', '');
    const r = await syncProvider('empty-key-prov');
    expect(r.status).toBe('no_key');
    expect(getSyncStatus('empty-key-prov')?.status).toBe('no_key');
  });

  it('探测成功：模型入 provider_models、匹配定价写入 pricing（覆盖已有条目）、状态 ok', async () => {
    addProviderConfig('mock-prov', `${url}/probe`, '', 'sk-ok');
    await syncProvider('mock-prov');
    const rows = listProviderModels().filter(r => r.provider === 'mock-prov');
    expect(rows.map(r => r.model).sort()).toEqual(['gpt-5.6-luna', 'gpt-5.6-sol', 'unknown-xyz']);
    const pricing = listPricing().filter(p => p.provider === 'mock-prov');
    expect(pricing).toHaveLength(2); // unknown-xyz 匹配不到不建条目
    const sol = pricing.find(p => p.model === 'gpt-5.6-sol');
    expect(sol.input_price).toBe(5);
    expect(sol.currency).toBe('USD');
    const st = getSyncStatus('mock-prov');
    expect(st.status).toBe('ok');
    expect(st.model_count).toBe(3);
    expect(st.priced_count).toBe(2);
  });

  it('定价覆盖已有条目（全部覆盖语义）', async () => {
    upsertPricing('mock-prov', 'gpt-5.6-sol', 999, 999, 999, 'USD'); // 先写入旧价
    await syncProvider('mock-prov');
    const sol = listPricing().find(p => p.provider === 'mock-prov' && p.model === 'gpt-5.6-sol');
    expect(sol.input_price).toBe(5); // 被覆盖
  });

  it('探测失败：状态 error、已有数据不动、不置灰', async () => {
    addProviderConfig('dead-prov', `${url}/not-exist`, '', 'sk');
    const r = await syncProvider('dead-prov');
    expect(r.status).toBe('error');
    expect(getSyncStatus('dead-prov')?.status).toBe('error');
  });

  it('定价源失败：模型照常更新，pricing 保持现状，状态仍 ok', async () => {
    process.env.LLM_MONITOR_PRICING_URLS = JSON.stringify({ liteLLM: `${url}/dead-price`, modelsDev: `${url}/dead-price` });
    try {
      addProviderConfig('no-price-prov', `${url}/probe`, '', 'sk-ok');
      await syncProvider('no-price-prov');
      expect(listProviderModels().filter(r => r.provider === 'no-price-prov')).toHaveLength(3);
      const st = getSyncStatus('no-price-prov');
      expect(st.status).toBe('ok');
      expect(st.priced_count).toBe(0);
    } finally {
      delete process.env.LLM_MONITOR_PRICING_URLS;
    }
  });
});
