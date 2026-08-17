import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { initDb, closeDb } from '../proxy/db.js';
import { createTempDb } from './setup.js';
import {
  listProviderModels, replaceProviderModels, setModelEnabled, deleteProviderModels,
  addProviderConfig, deleteProviderConfig, createPendingSession,
  updateSessionUpstream, updateSessionModel, getSession,
} from '../proxy/db.js';

let tmp: ReturnType<typeof createTempDb>;

beforeAll(async () => {
  tmp = createTempDb();
  await initDb(tmp.dbPath);
});
afterAll(() => {
  closeDb();
  tmp.cleanup();
});

describe('provider_models', () => {
  it('新增模型行（available=1 enabled=1 含时间戳）', () => {
    const now = Date.now();
    replaceProviderModels('openai', ['gpt-5.6-sol', 'gpt-5.6-luna'], now);
    const rows = listProviderModels();
    expect(rows).toHaveLength(2);
    const row = rows.find(r => r.model === 'gpt-5.6-sol');
    expect(row.enabled).toBe(1);
    expect(row.available).toBe(1);
    expect(row.created_at).toBe(now);
    expect(row.updated_at).toBe(now);
  });

  it('探测不到的存量模型置灰不删除，用户 enabled 状态不重置', () => {
    deleteProviderModels('openai'); // 隔离前一用例的同名模型行，保证 created_at 从本次插入起算
    const now = Date.now();
    replaceProviderModels('openai', ['gpt-5.6-sol', 'gpt-5.6-luna'], now);
    setModelEnabled('openai', 'gpt-5.6-luna', false); // 用户手动关闭
    replaceProviderModels('openai', ['gpt-5.6-sol'], now + 1000); // luna 不再探测到
    const rows = listProviderModels().filter(r => r.provider === 'openai');
    expect(rows).toHaveLength(2); // 不删除
    const sol = rows.find(r => r.model === 'gpt-5.6-sol');
    const luna = rows.find(r => r.model === 'gpt-5.6-luna');
    expect(sol.available).toBe(1);
    expect(luna.available).toBe(0);   // 置灰
    expect(luna.enabled).toBe(0);     // 用户关闭状态保持
    expect(luna.created_at).toBe(now); // 创建时间不变
    expect(luna.updated_at).toBe(now + 1000); // 置灰时更新
  });

  it('重新探测到置灰模型后 available 恢复 1（enabled 保持关闭）', () => {
    replaceProviderModels('openai', ['gpt-5.6-sol', 'gpt-5.6-luna'], Date.now());
    const luna = listProviderModels().find(r => r.provider === 'openai' && r.model === 'gpt-5.6-luna');
    expect(luna.available).toBe(1);
    expect(luna.enabled).toBe(0);
  });

  it('关闭模型时清理 sessions.upstream_model 引用（同供应商）', () => {
    const sid = createPendingSession('codex');
    updateSessionUpstream(sid, 'openai');
    updateSessionModel(sid, 'gpt-5.6-sol');
    setModelEnabled('openai', 'gpt-5.6-sol', false);
    const s = getSession(sid);
    expect(s?.upstream_model).toBeNull();
    expect(s?.upstream_provider).toBe('openai'); // provider 引用保留
  });

  it('删除供应商联动删除模型行', () => {
    addProviderConfig('custom-prov', 'https://example.com', '', 'sk-x');
    replaceProviderModels('custom-prov', ['m1'], Date.now());
    expect(deleteProviderConfig('custom-prov').ok).toBe(true);
    expect(listProviderModels().filter(r => r.provider === 'custom-prov')).toHaveLength(0);
  });
});
