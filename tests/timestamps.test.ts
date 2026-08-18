/** 配置表时间戳测试 — provider_config / tool_config 的 created_at / updated_at 维护 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { initDb, closeDb, addProviderConfig, updateProviderConfig, updateToolConfig, listProviderConfigs, listToolConfigs, listProviderModels, replaceProviderModels } from '../proxy/db.js';
import { createTempDb } from './setup.js';

const tmp = createTempDb();
beforeAll(async () => { await initDb(tmp.dbPath); });
afterAll(() => { closeDb(); tmp.cleanup(); });

describe('配置表时间戳', () => {
  it('addProviderConfig 新插入：created_at 与 updated_at 相等且 > 0', () => {
    addProviderConfig('tsprov', 'https://t.example', '', 'k1');
    const row = listProviderConfigs().find((p: any) => p.provider === 'tsprov')!;
    expect(row.created_at).toBeGreaterThan(0);
    expect(row.updated_at).toBe(row.created_at);
  });

  it('addProviderConfig 更新既有自定义供应商：updated_at 变化、created_at 不变', async () => {
    addProviderConfig('tsprov2', 'https://t2.example', '', 'k1');
    const before = listProviderConfigs().find((p: any) => p.provider === 'tsprov2')!;
    await new Promise(r => setTimeout(r, 5)); // 确保毫秒时间戳可区分
    addProviderConfig('tsprov2', 'https://t2b.example', '', 'k2');
    const after = listProviderConfigs().find((p: any) => p.provider === 'tsprov2')!;
    expect(after.updated_at).toBeGreaterThan(before.updated_at);
    expect(after.created_at).toBe(before.created_at);
  });

  it('updateProviderConfig：updated_at 更新', async () => {
    addProviderConfig('tsprov3', 'https://t3.example', '', '');
    const before = listProviderConfigs().find((p: any) => p.provider === 'tsprov3')!;
    await new Promise(r => setTimeout(r, 5));
    updateProviderConfig('tsprov3', { api_key: 'k3' });
    const after = listProviderConfigs().find((p: any) => p.provider === 'tsprov3')!;
    expect(after.updated_at).toBeGreaterThan(before.updated_at);
    expect(after.created_at).toBe(before.created_at);
  });

  it('updateToolConfig 首次插入两值相等；更新时 updated_at 变、created_at 不变', async () => {
    updateToolConfig('tstool', 'openai', null);
    const first = listToolConfigs().find((t: any) => t.tool === 'tstool')!;
    expect(first.created_at).toBeGreaterThan(0);
    expect(first.updated_at).toBe(first.created_at);
    await new Promise(r => setTimeout(r, 5));
    updateToolConfig('tstool', 'openai', 'gpt-5');
    const second = listToolConfigs().find((t: any) => t.tool === 'tstool')!;
    expect(second.updated_at).toBeGreaterThan(first.updated_at);
    expect(second.created_at).toBe(first.created_at);
  });

  it('replaceProviderModels 插入两值相等；更新时 updated_at 变、created_at 不变', () => {
    const t1 = Date.now();
    replaceProviderModels('ts-prov', ['ts-model'], new Map([['ts-model', { input_price: 1, cache_input_price: 0.5, output_price: 2 }]]), t1);
    let row = listProviderModels().find(r => r.provider === 'ts-prov' && r.model === 'ts-model')!;
    expect(row.created_at).toBe(t1);
    expect(row.updated_at).toBe(t1);
    // 再次同步（覆盖）：updated_at 更新、created_at 不变
    const t2 = t1 + 1000;
    replaceProviderModels('ts-prov', ['ts-model'], new Map([['ts-model', { input_price: 3, cache_input_price: 1.5, output_price: 6 }]]), t2);
    row = listProviderModels().find(r => r.provider === 'ts-prov' && r.model === 'ts-model')!;
    expect(row.created_at).toBe(t1);
    expect(row.updated_at).toBe(t2);
  });
});
