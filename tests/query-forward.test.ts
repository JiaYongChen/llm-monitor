/** 转发附加查询串测试 — 分页/过滤/网关必需参数不丢失 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { initDb, closeDb, updateProviderConfig } from '../proxy/db.js';
import { registerProxyRoutes } from '../proxy/router.js';
import { createTempDb } from './setup.js';

const tmp = createTempDb();
let upstream: FastifyInstance;
let app: FastifyInstance;

beforeAll(async () => {
  await initDb(tmp.dbPath);

  // 模拟上游：回显收到的查询参数
  upstream = Fastify({ logger: false });
  upstream.get('/anthropic/v1/models', async (req) => {
    const q = req.query as Record<string, string>;
    return { after: q.after ?? null, limit: q.limit ?? null };
  });
  await upstream.listen({ port: 0, host: '127.0.0.1' });
  const addr = upstream.server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;

  updateProviderConfig('Anthropic', { base_url: `http://127.0.0.1:${port}/anthropic` });
  app = Fastify();
  await registerProxyRoutes(app);
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await upstream?.close();
  closeDb();
  tmp.cleanup();
});

describe('转发附加查询串', () => {
  it('查询参数原样到达上游（含编码字符）', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/claudecode/v1/models?after=cursor%20x&limit=5',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.after).toBe('cursor x');
    expect(body.limit).toBe('5');
  });
});
