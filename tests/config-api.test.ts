/** /api/config timezone 字段测试 — 默认值 + PUT 持久化。
 *  两个测试共享同一临时库，按声明顺序执行：默认值断言必须先于 PUT 持久化断言。 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import { initDb, closeDb } from '../proxy/db.js';
import { registerApiRoutes } from '../proxy/router.js';
import { createTempDb } from './setup.js';

const tmp = createTempDb();

beforeAll(async () => { await initDb(tmp.dbPath); });
afterAll(() => { closeDb(); tmp.cleanup(); });

describe('GET/PUT /api/config timezone', () => {
  it('未设置时默认返回 timezone: "8"', async () => {
    const app = Fastify({ logger: false });
    registerApiRoutes(app);
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/api/config' });
    expect(res.statusCode).toBe(200);
    expect(res.json().timezone).toBe('8');
    await app.close();
  });

  it('PUT { timezone: "0" } 后 GET 返回 "0"（metadata 持久化）', async () => {
    const app = Fastify({ logger: false });
    registerApiRoutes(app);
    await app.ready();
    const put = await app.inject({ method: 'PUT', url: '/api/config', payload: { timezone: '0' } });
    expect(put.statusCode).toBe(200);
    const res = await app.inject({ method: 'GET', url: '/api/config' });
    expect(res.json().timezone).toBe('0');
    await app.close();
  });
});
