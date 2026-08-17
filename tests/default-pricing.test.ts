import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { importDefaultPricing } from '../proxy/default-pricing.js';
import { initDb, closeDb, listPricing, upsertPricing } from '../proxy/db.js';
import { createTempDb } from './setup.js';

describe('importDefaultPricing（种子导入，不覆盖自动同步价）', () => {
  let tmp: ReturnType<typeof createTempDb>;
  beforeAll(async () => {
    tmp = createTempDb();
    await initDb(tmp.dbPath);
  });
  afterAll(() => { closeDb(); tmp.cleanup(); });

  it('已存在同 (provider, model) 行不被覆盖（含自动同步写入的价）', async () => {
    upsertPricing('openai', 'gpt-5.6-sol', 999, 999, 999, 'USD'); // 模拟自动同步写入的自定义价
    await importDefaultPricing();
    const row = listPricing().find(p => p.provider === 'openai' && p.model === 'gpt-5.6-sol')!;
    expect(row.input_price).toBe(999); // 未被预置默认值覆盖
    expect(row.is_default).toBe(0); // 也不被篡改为默认条目
  });

  it('缺失模型会被种子导入（seed-if-absent 幂等）', async () => {
    await importDefaultPricing(); // 再次调用不破坏已有条目
    const row = listPricing().find(p => p.provider === 'anthropic' && p.model === 'claude-opus-5')!;
    expect(row).toBeDefined();
    expect(row.input_price).toBe(5); // 来自 default-pricing.json
    expect(row.currency).toBe('USD');
    expect(row.is_default).toBe(1);
  });
});
