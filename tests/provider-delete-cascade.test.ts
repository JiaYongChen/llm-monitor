/** 供应商删除级联清理测试 — 会话覆写 / 工具级上游 / 模型行不留孤儿引用 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  initDb, closeDb,
  addProviderConfig, deleteProviderConfig, deleteAllThirdPartyProviders, listProviderConfigs,
  updateToolConfig, getToolConfig,
  createPendingSession, getSession, updateSessionUpstream,
  listProviderModels, seedProviderModels,
} from '../proxy/db.js';
import { createTempDb } from './setup.js';

const tmp = createTempDb();
beforeAll(async () => { await initDb(tmp.dbPath); });
afterAll(() => { closeDb(); tmp.cleanup(); });

describe('删除单个供应商级联清理', () => {
  it('deleteProviderConfig 清除会话覆写、工具级上游与模型行', () => {
    addProviderConfig('cascade1', 'https://c1.example.com', '', 'sk-1');
    seedProviderModels([{ provider: 'cascade1', model: 'm1', input_price: 1, cache_input_price: 0.5, output_price: 2, currency: 'USD' }], Date.now());
    updateToolConfig('codex', 'cascade1', 'm1');
    const sid = createPendingSession('codex');
    updateSessionUpstream(sid, 'cascade1');

    const result = deleteProviderConfig('cascade1');
    expect(result.ok).toBe(true);

    // 会话覆写清除
    expect(getSession(sid)!.upstream_provider).toBeNull();
    // 工具级上游清除（否则该工具流量持续 500/503）
    const tc = getToolConfig('codex');
    expect(tc?.upstream_provider ?? null).toBeNull();
    expect(tc?.upstream_model ?? null).toBeNull();
    // 模型行清除
    expect(listProviderModels().filter(m => m.provider === 'cascade1')).toHaveLength(0);
  });
});

describe('批量清空第三方供应商级联清理', () => {
  it('deleteAllThirdPartyProviders 清除全部引用且保留内置供应商', () => {
    addProviderConfig('cascade2', 'https://c2.example.com', '', 'sk-2');
    addProviderConfig('cascade3', 'https://c3.example.com', '', 'sk-3');
    seedProviderModels([
      { provider: 'cascade2', model: 'm2', input_price: 1, cache_input_price: 0, output_price: 2, currency: 'USD' },
      { provider: 'cascade3', model: 'm3', input_price: 1, cache_input_price: 0, output_price: 2, currency: 'USD' },
    ], Date.now());
    updateToolConfig('claudecode', 'cascade2', 'm2');
    const sid = createPendingSession('claudecode');
    updateSessionUpstream(sid, 'cascade3');

    const count = deleteAllThirdPartyProviders();
    expect(count).toBeGreaterThanOrEqual(2);

    // 内置供应商保留
    const names = listProviderConfigs().map(c => c.provider);
    expect(names).toContain('anthropic');
    expect(names).toContain('openai');
    expect(names).not.toContain('cascade2');
    expect(names).not.toContain('cascade3');
    // 全部引用清除
    expect(getSession(sid)!.upstream_provider).toBeNull();
    const tc = getToolConfig('claudecode');
    expect(tc?.upstream_provider ?? null).toBeNull();
    expect(listProviderModels().filter(m => m.provider === 'cascade2' || m.provider === 'cascade3')).toHaveLength(0);
  });
});
