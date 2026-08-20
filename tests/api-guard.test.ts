/** 数据管理 API 防护测试 — days 参数校验 + CSRF Origin 校验 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { initDb, closeDb } from '../proxy/db.js';
import { registerApiRoutes } from '../proxy/router.js';
import { createTempDb } from './setup.js';

const tmp = createTempDb();
let app: FastifyInstance;

beforeAll(async () => {
  await initDb(tmp.dbPath);
  app = Fastify();
  registerApiRoutes(app);
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  closeDb();
  tmp.cleanup();
});

describe('cleanup days 参数校验', () => {
  it('days=0 拒绝（防止删光全部调用）', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/data/cleanup', payload: { days: 0 } });
    expect(res.statusCode).toBe(400);
  });

  it('days=-5 拒绝', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/data/cleanup', payload: { days: -5 } });
    expect(res.statusCode).toBe(400);
  });

  it('days 缺失或非整数拒绝', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/data/cleanup', payload: {} })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/data/cleanup', payload: { days: 'abc' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/data/cleanup', payload: { days: 1.5 } })).statusCode).toBe(400);
  });

  it('days=30 接受', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/data/cleanup', payload: { days: 30 } });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).deleted).toBe(0);
  });
});

describe('CSRF Origin 校验（写操作）', () => {
  it('跨站 Origin 的写操作 → 403', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/data/clear-sessions',
      headers: { origin: 'http://evil.example.com' },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
  });

  it('同源 Origin 的写操作放行', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/data/clear-sessions',
      headers: { origin: 'http://localhost:9401', host: 'localhost:9401' },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
  });

  it('无 Origin 的非浏览器请求放行（CLI/curl）', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/data/clear-sessions', payload: {} });
    expect(res.statusCode).toBe(200);
  });

  it('GET 请求不受 Origin 校验影响', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/config',
      headers: { origin: 'http://evil.example.com' },
    });
    expect(res.statusCode).toBe(200);
  });
});
