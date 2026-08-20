/** 代理请求体上限测试 — 长上下文 LLM 请求不被默认 1MiB 截断（413） */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import { initDb, closeDb, updateProviderConfig } from '../proxy/db.js';
import { registerProxyRoutes } from '../proxy/router.js';
import { PROXY_BODY_LIMIT_BYTES } from '../proxy/config.js';
import { createTempDb } from './setup.js';

const tmp = createTempDb();
let app: ReturnType<typeof Fastify>;

beforeAll(async () => {
  await initDb(tmp.dbPath);
  // 避免真实外呼：指向不可达的本地端口（识别成功但转发失败 → 非 413 即可）
  updateProviderConfig('Anthropic', { base_url: 'http://127.0.0.1:1' });
  // 与 main.ts 相同参数构建代理实例
  app = Fastify({ bodyLimit: PROXY_BODY_LIMIT_BYTES });
  await registerProxyRoutes(app);
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  closeDb();
  tmp.cleanup();
});

describe('代理 bodyLimit', () => {
  it('上限大于 Fastify 默认 1MiB', () => {
    expect(PROXY_BODY_LIMIT_BYTES).toBeGreaterThan(1024 * 1024);
  });

  it('2MB 请求体不被拒绝（无 413）', async () => {
    const bigContent = 'x'.repeat(2 * 1024 * 1024);
    const res = await app.inject({
      method: 'POST',
      url: '/ClaudeCode/v1/messages',
      payload: { model: 'claude-sonnet-5', max_tokens: 10, messages: [{ role: 'user', content: bigContent }] },
    });
    // 转发失败（不可达端口）可接受，但不能是 413 请求体过大
    expect(res.statusCode).not.toBe(413);
  });
});
