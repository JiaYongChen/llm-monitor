/** 模型同步 API 测试：provider-models 查询/刷新/开关 + 供应商配置变更自动触发同步
 *  本地 mock 服务器模拟 OpenAI 兼容 /v1/models 探测端点 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { initDb, closeDb, addProviderConfig, listProviderModels } from '../proxy/db.js';
import { registerApiRoutes } from '../proxy/router.js';
import { createTempDb } from './setup.js';

let app: FastifyInstance;
let probeUrl: string;
let probeApp: FastifyInstance;
let tmp: ReturnType<typeof createTempDb>;

beforeAll(async () => {
  tmp = createTempDb();
  await initDb(tmp.dbPath);
  probeApp = Fastify({ logger: false });
  probeApp.get('/v1/models', async () => ({ object: 'list', data: [{ id: 'api-model-a' }] }));
  // 定价源 mock：避免 syncProvider 内真实请求 liteLLM（同 model-sync.test.ts 惯例）
  probeApp.get('/prices.json', async () => ({
    sample_spec: { input_cost_per_token: 0, output_cost_per_token: 0 },
    'api-model-a': { input_cost_per_token: 1e-6, output_cost_per_token: 5e-6 },
  }));
  await probeApp.listen({ port: 0, host: '127.0.0.1' });
  probeUrl = `http://127.0.0.1:${(probeApp.server.address() as any).port}`;
  process.env.LLM_MONITOR_PRICING_URLS = JSON.stringify({ liteLLM: `${probeUrl}/prices.json` });
  app = Fastify({ logger: false });
  registerApiRoutes(app);
  await app.ready();
});
afterAll(async () => {
  delete process.env.LLM_MONITOR_PRICING_URLS;
  await app.close(); await probeApp.close(); closeDb(); tmp.cleanup();
});

describe('model-sync API', () => {
  it('GET /api/provider-models 返回探测模型行', async () => {
    addProviderConfig('api-prov', probeUrl, '', 'sk');
    const res = await app.inject({ method: 'POST', url: '/api/provider-models/refresh', payload: { provider: 'api-prov' } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ok');
    expect(body.model_count).toBe(1);
    const list = await app.inject({ method: 'GET', url: '/api/provider-models' });
    expect(list.json().filter((r: any) => r.provider === 'api-prov')).toHaveLength(1);
  });

  it('PUT /api/provider-models/:provider/:model/enabled 切换模型开关', async () => {
    const res = await app.inject({
      method: 'PUT', url: '/api/provider-models/api-prov/api-model-a/enabled',
      payload: { enabled: false },
    });
    expect(res.statusCode).toBe(200);
    const row = listProviderModels().find(r => r.provider === 'api-prov' && r.model === 'api-model-a');
    expect(row!.enabled).toBe(0);
  });

  it('POST /api/providers 后自动异步触发同步', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/providers',
      payload: { provider: 'async-prov', base_url: probeUrl, base_url_anthropic: '', api_key: 'sk' },
    });
    expect(res.statusCode).toBe(200);
    // 异步触发：轮询等待 provider_models 出现（最多 2s）
    const deadline = Date.now() + 2000;
    let rows: any[] = [];
    while (Date.now() < deadline) {
      rows = listProviderModels().filter(r => r.provider === 'async-prov');
      if (rows.length > 0) break;
      await new Promise(r => setTimeout(r, 50));
    }
    expect(rows.map(r => r.model)).toEqual(['api-model-a']);
  });

  it('PUT /api/providers/:provider 更新 api_key 后自动触发同步', async () => {
    // 已有供应商无 key → 更新 key 后自动探测
    addProviderConfig('update-prov', probeUrl, '', '');
    await app.inject({
      method: 'PUT', url: '/api/providers/update-prov',
      payload: { api_key: 'sk' },
    });
    const deadline = Date.now() + 2000;
    let rows: any[] = [];
    while (Date.now() < deadline) {
      rows = listProviderModels().filter(r => r.provider === 'update-prov');
      if (rows.length > 0) break;
      await new Promise(r => setTimeout(r, 50));
    }
    expect(rows).toHaveLength(1);
  });
});
