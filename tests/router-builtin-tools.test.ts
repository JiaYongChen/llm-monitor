/** 路由测试：内置工具前缀（ClaudeCode / Codex）在无 tool_config 行时也应可路由 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import { initDb, closeDb, updateProviderConfig, addProviderConfig } from '../proxy/db.js';
import { registerProxyRoutes } from '../proxy/router.js';
import { createTempDb } from './setup.js';

const tmp = createTempDb();
let app: ReturnType<typeof Fastify>;

beforeAll(async () => {
  await initDb(tmp.dbPath);
  // 避免真实外呼：内置供应商指向不可达的本地端口（识别成功但转发失败 → 非 400 即可）
  updateProviderConfig('Anthropic', { base_url: 'http://127.0.0.1:1' });
  updateProviderConfig('OpenAI', { base_url: 'http://127.0.0.1:1' });
  app = Fastify();
  await registerProxyRoutes(app);
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  closeDb();
  tmp.cleanup();
});

describe('内置工具路由（无 tool_config 行）', () => {
  it('POST /ClaudeCode/v1/messages → 识别成功（非 400 无法识别）', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/ClaudeCode/v1/messages',
      payload: { model: 'claude-sonnet-5', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(res.statusCode).not.toBe(400);
  });

  it('POST /Codex/v1/responses → 识别成功（非 400 无法识别）', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/Codex/v1/responses',
      payload: { model: 'gpt-5', input: 'hi' },
    });
    expect(res.statusCode).not.toBe(400);
  });

  it('内置工具名与同名供应商并存时让位于供应商路径', async () => {
    // 自定义供应商 'ClaudeCode'（非内置名，可添加）→ 停用后 /ClaudeCode/* 应命中「供应商已禁用」
    // 若内置工具映射优先，则会走 Anthropic 转发（非 503-禁用响应）
    addProviderConfig('ClaudeCode', 'http://127.0.0.1:1', '', '');
    updateProviderConfig('ClaudeCode', { enabled: false });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/ClaudeCode/v1/messages',
        payload: { model: 'claude-sonnet-5', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] },
      });
      expect(res.statusCode).toBe(503);
      expect(res.body).toContain('已禁用');
    } finally {
      updateProviderConfig('ClaudeCode', { enabled: true });
    }
  });
});
