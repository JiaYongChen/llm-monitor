/** Provider Config 持久化测试 — 验证供应商配置在数据库重启后不丢失 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  initDb, closeDb,
  listProviderConfigs, addProviderConfig, updateProviderConfig, deleteProviderConfig,
} from '../proxy/db.js';
import { createTempDb } from './setup.js';

const tmp = createTempDb();

// ⚠️ 不使用 beforeAll 统一初始化 — 每个场景独立控制 initDb/closeDb 生命周期

describe('provider_config 持久化', () => {
  it('默认初始化后应有 Anthropic 和 OpenAI', async () => {
    await initDb(tmp.dbPath);
    const configs = listProviderConfigs();
    const names = configs.map(c => c.provider);
    expect(names).toContain('Anthropic');
    expect(names).toContain('OpenAI');
  });

  it('添加自定义供应商后应能列出且字段完整', () => {
    const id = addProviderConfig('TestCustom', 'https://custom.example.com', 'https://custom-anthropic.example.com', 'sk-test-key', 'custom');
    expect(id).toBeGreaterThan(0);

    const configs = listProviderConfigs();
    const tp = configs.find(c => c.provider === 'TestCustom');
    expect(tp).toBeDefined();
    expect(tp!.base_url).toBe('https://custom.example.com');
    expect(tp!.base_url_anthropic).toBe('https://custom-anthropic.example.com');
    expect(tp!.api_key).toBe('sk-test-key');
    expect(tp!.api_format).toBe('custom');
    expect(tp!.enabled).toBe(1);
  });

  it('★ 关闭数据库再重新打开后，自定义供应商仍存在（核心场景）', async () => {
    // 先确认当前数据
    const before = listProviderConfigs();
    expect(before.find(c => c.provider === 'TestCustom')).toBeDefined();

    // 模拟重启：关闭 → 重新初始化
    closeDb();

    // 重新打开同一个数据库文件
    await initDb(tmp.dbPath);

    // 验证自定义供应商仍存在
    const after = listProviderConfigs();
    expect(after.find(c => c.provider === 'Anthropic')).toBeDefined();
    expect(after.find(c => c.provider === 'OpenAI')).toBeDefined();
    const tp = after.find(c => c.provider === 'TestCustom');
    expect(tp).toBeDefined();
    expect(tp!.base_url).toBe('https://custom.example.com');
    expect(tp!.api_key).toBe('sk-test-key');
    expect(tp!.api_format).toBe('custom');
    expect(tp!.enabled).toBe(1);
  });

  it('更新供应商配置后持久化', () => {
    updateProviderConfig('TestCustom', { api_key: 'sk-updated', base_url: 'https://updated.example.com' });
    const configs = listProviderConfigs();
    const tp = configs.find(c => c.provider === 'TestCustom');
    expect(tp).toBeDefined();
    expect(tp!.api_key).toBe('sk-updated');
    expect(tp!.base_url).toBe('https://updated.example.com');
  });

  it('关闭再打开后更新也持久化', async () => {
    closeDb();
    await initDb(tmp.dbPath);

    const configs = listProviderConfigs();
    const tp = configs.find(c => c.provider === 'TestCustom');
    expect(tp).toBeDefined();
    expect(tp!.api_key).toBe('sk-updated');
  });

  it('删除自定义供应商', () => {
    deleteProviderConfig('TestCustom');
    const configs = listProviderConfigs();
    expect(configs.find(c => c.provider === 'TestCustom')).toBeUndefined();
  });

  it('关闭再打开后删除也持久化', async () => {
    closeDb();
    await initDb(tmp.dbPath);

    const configs = listProviderConfigs();
    expect(configs.find(c => c.provider === 'TestCustom')).toBeUndefined();
  });
});

// 最终清理
afterAll(() => {
  try { closeDb(); } catch {}
  tmp.cleanup();
});
