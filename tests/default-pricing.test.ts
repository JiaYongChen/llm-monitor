import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { importDefaultPricing } from '../proxy/default-pricing.js';
import { initDb, closeDb, listProviderModels, replaceProviderModels } from '../proxy/db.js';
import { createTempDb } from './setup.js';

describe('importDefaultPricing（种子导入 provider_models，不覆盖自动同步价）', () => {
  let tmp: ReturnType<typeof createTempDb>;
  beforeAll(async () => { tmp = createTempDb(); await initDb(tmp.dbPath); });
  afterAll(() => { closeDb(); tmp.cleanup(); });

  it('缺失行被种子导入（enabled=1, available=1, 带价格）', async () => {
    await importDefaultPricing();
    const row = listProviderModels().find(p => p.provider === 'anthropic' && p.model === 'claude-opus-5')!;
    expect(row.input_price).toBe(5);
    expect(row.output_price).toBe(25);
    expect(row.currency).toBe('USD');
    expect(row.enabled).toBe(1);
    expect(row.available).toBe(1);
    expect(listProviderModels().filter(p => p.provider === 'openai')).toHaveLength(3);
    expect(listProviderModels().filter(p => p.provider === 'anthropic')).toHaveLength(4);
  });

  it('已存在同 (provider, model) 行不被覆盖（含自动同步写入的价）', async () => {
    replaceProviderModels('openai', ['gpt-5.6-sol'], new Map([['gpt-5.6-sol', { input_price: 999, cache_input_price: 999, output_price: 999 }]]), Date.now()); // 模拟自动同步写入的自定义价
    await importDefaultPricing();
    const row = listProviderModels().find(p => p.provider === 'openai' && p.model === 'gpt-5.6-sol')!;
    expect(row.input_price).toBe(999); // 自动同步价不被种子覆盖
  });

  it('seed-if-absent 幂等：重复导入不新增行', async () => {
    const before = listProviderModels().length;
    await importDefaultPricing();
    expect(listProviderModels().length).toBe(before);
  });
});
