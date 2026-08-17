/** /api/colors 端点测试 — 色板 + 两池注册表返回形状 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import { initDb, closeDb } from '../proxy/db.js';
import { registerCategoryColor } from '../proxy/colors.js';
import { registerApiRoutes } from '../proxy/router.js';
import { createTempDb } from './setup.js';

const tmp = createTempDb();

beforeAll(async () => {
  await initDb(tmp.dbPath);
  registerCategoryColor('tool', 'kimi');
});
afterAll(() => { closeDb(); tmp.cleanup(); });

describe('GET /api/colors', () => {
  it('返回 32 色板 + 两池注册表', async () => {
    const app = Fastify({ logger: false });
    registerApiRoutes(app);
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/api/colors' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.palette.length).toBe(32);
    expect(body.palette[0]).toEqual({ idx: 0, color: '#ff7f0e' });
    expect(body.tools.claudecode).toBe(0);
    expect(body.tools.codex).toBe(1);
    expect(body.tools.kimi).toBe(2);
    expect(body.providers.anthropic).toBe(0);
    expect(body.providers.openai).toBe(1);
    await app.close();
  });
});
