/** 大小写不敏感测试 — 工具 / 供应商 / 模型名匹配不区分大小写，存储为规范名 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  initDb, closeDb, createPendingSession, upsertSession, getSession,
  getToolConfig, updateToolConfig, listToolConfigs, listSessions, listCalls,
  getStats, getDailyStats, upsertPricing, listPricing, addProviderConfig,
  listProviderConfigs, updateSessionUpstream, normalizeToolName, insertCall,
  upsertDailyStat, getDb, updateProviderConfig,
  deleteProviderConfig, getProviderConfig, canonicalProviderName,
} from '../proxy/db.js';
import { toolFromProvider } from '../proxy/session.js';
import { createTempDb } from './setup.js';
import type { CallRecord } from '../shared/types.js';

const tmp = createTempDb();
beforeAll(async () => { await initDb(tmp.dbPath); });
afterAll(() => { closeDb(); tmp.cleanup(); });

describe('normalizeToolName', () => {
  it('内置工具名大小写归一化', () => {
    expect(normalizeToolName('claudeCode')).toBe('ClaudeCode');
    expect(normalizeToolName('CLAUDECODE')).toBe('ClaudeCode');
    expect(normalizeToolName('claude')).toBe('ClaudeCode');
    expect(normalizeToolName('CodeX')).toBe('Codex');
    expect(normalizeToolName('CODEX')).toBe('Codex');
  });

  it('chatGPT 归一化为 Codex', () => {
    expect(normalizeToolName('chatGPT')).toBe('Codex');
    expect(normalizeToolName('chatgpt')).toBe('Codex');
    expect(normalizeToolName('CHATGPT')).toBe('Codex');
  });

  it('未知工具保持原样', () => {
    expect(normalizeToolName('mytool')).toBe('mytool');
  });

  it('未注册工具以首次出现的大小写为准，后续变体收敛', () => {
    const sid = createPendingSession('newtool');
    expect(getSession(sid)!.tool).toBe('newtool');
    // 后续请求使用不同大小写 → 收敛到首次出现的名字（复用 pending 会话）
    const sid2 = upsertSession('fp_newtool_variant', 'NEWTOOL', '/v1/x');
    expect(sid2).toBe(sid);
    expect(getSession(sid2)!.tool).toBe('newtool');
  });

  it('自定义工具大小写不敏感匹配 tool_config，返回库中规范名', () => {
    updateToolConfig('cursor', 'OpenAI', null);
    expect(normalizeToolName('CURSOR')).toBe('cursor');
    expect(normalizeToolName('Cursor')).toBe('cursor');
  });
});

describe('会话存储规范工具名', () => {
  it('createPendingSession 归一化工具名', () => {
    const id1 = createPendingSession('claudeCode');
    expect(getSession(id1)!.tool).toBe('ClaudeCode');
    const id2 = createPendingSession('CODEX');
    expect(getSession(id2)!.tool).toBe('Codex');
    const id3 = createPendingSession('chatgpt');
    expect(getSession(id3)!.tool).toBe('Codex');
  });

  it('createPendingSession 自定义工具继承 tool_config（大小写不敏感）', () => {
    updateToolConfig('cursor', 'OpenAI', 'gpt-test');
    const id = createPendingSession('CURSOR');
    const s = getSession(id)!;
    expect(s.tool).toBe('cursor');
    expect(s.upstream_provider).toBe('OpenAI');
    expect(s.upstream_model).toBe('gpt-test');
  });

  it('upsertSession 归一化工具名', () => {
    const sid = upsertSession('fp_ci_upsert', 'claudecode', '/v1/messages');
    expect(getSession(sid)!.tool).toBe('ClaudeCode');
  });

  it('toolFromProvider 大小写不敏感', () => {
    expect(toolFromProvider('Anthropic')).toBe('ClaudeCode');
    expect(toolFromProvider('OPENAI')).toBe('Codex');
  });
});

describe('tool_config 大小写不敏感', () => {
  it('getToolConfig 大小写不敏感查找', () => {
    updateToolConfig('ClaudeCode', 'Qwen', 'qwen-test');
    const tc = getToolConfig('CLAUDECODE');
    expect(tc).not.toBeNull();
    expect(tc!.tool).toBe('ClaudeCode');
    expect(tc!.upstream_provider).toBe('Qwen');
  });

  it('updateToolConfig 大小写不同视为同一工具，不产生重复行', () => {
    updateToolConfig('windsurf', 'OpenAI', null);
    updateToolConfig('WINDSURF', 'Anthropic', null);
    const rows = listToolConfigs().filter((r: any) => r.tool.toLowerCase() === 'windsurf');
    expect(rows).toHaveLength(1);
    expect(rows[0].upstream_provider).toBe('Anthropic');
  });
});

describe('供应商大小写不敏感', () => {
  it('addProviderConfig 大小写不同视为同一供应商，不产生重复行', () => {
    const id1 = addProviderConfig('qwen', 'https://qwen.example.com', '', 'k1');
    const id2 = addProviderConfig('QWEN', 'https://qwen2.example.com', '', 'k2');
    expect(id2).toBe(id1);
    const rows = listProviderConfigs().filter((r: any) => r.provider.toLowerCase() === 'qwen');
    expect(rows).toHaveLength(1);
    expect(rows[0].base_url).toBe('https://qwen2.example.com');
  });

  it('updateSessionUpstream 存储供应商规范名', () => {
    const sid = upsertSession('fp_ci_upstream', 'ClaudeCode', '/v1/messages');
    updateSessionUpstream(sid, 'anthropic');
    expect(getSession(sid)!.upstream_provider).toBe('Anthropic');
  });
});

describe('addProviderConfig 边界', () => {
  it('与内置供应商仅大小写不同 → 提示已存在，不插入新行、不覆写内置行', () => {
    expect(() => addProviderConfig('openai', 'https://my-gateway.example', '', 'gw-key')).toThrow(/已存在/);
    const rows = listProviderConfigs().filter((r: any) => r.provider.toLowerCase() === 'openai');
    expect(rows.length).toBe(1);
    expect(rows[0].provider).toBe('OpenAI');
    // 内置行不被污染（api_key 保持空）
    expect(rows[0].api_key).toBe('');
  });

  it('更新已停用的既有供应商时不强制启用', () => {
    addProviderConfig('zhipu', 'https://zhipu.example', '', 'k1');
    updateProviderConfig('zhipu', { enabled: false });
    addProviderConfig('ZHIPU', 'https://zhipu2.example', '', 'k2');
    const row = listProviderConfigs().find((r: any) => r.provider.toLowerCase() === 'zhipu')!;
    expect(row.base_url).toBe('https://zhipu2.example');
    expect(row.enabled).toBe(0);
  });
});

describe('归一化缓存失效', () => {
  it('供应商增删后解析结果即时更新', () => {
    addProviderConfig('cacheprov', 'https://c.example', '', '');
    expect(canonicalProviderName('CACHEPROV')).toBe('cacheprov');
    deleteProviderConfig('cacheprov');
    // 已删除 → 无规范名可解析，原样返回
    expect(canonicalProviderName('CACHEPROV')).toBe('CACHEPROV');
  });

  it('工具配置更新后解析结果即时更新', () => {
    updateToolConfig('CacheTool', 'OpenAI', null);
    expect(normalizeToolName('cachetool')).toBe('CacheTool');
  });
});

describe('上游供应商归一化对称性', () => {
  it('updateToolConfig 归一化 upstream_provider 为规范名', () => {
    updateToolConfig('windsurf', 'ANTHROPIC', null);
    expect(getToolConfig('windsurf')!.upstream_provider).toBe('Anthropic');
  });

  it('会话继承 tool_config 时 upstream_provider 已归一化', () => {
    // 直接 SQL 构造带变体供应商名的工具配置（绕过 updateToolConfig 归一化）
    getDb().run(`INSERT INTO tool_config (tool, upstream_provider) VALUES ('legacytool', 'anthropic')`);
    const sid1 = createPendingSession('legacytool');
    expect(getSession(sid1)!.upstream_provider).toBe('Anthropic');
    const sid2 = upsertSession('fp_ci_inherit', 'legacytool', '/v1/x');
    expect(getSession(sid2)!.upstream_provider).toBe('Anthropic');
  });
});

describe('供应商 CRUD 大小写不敏感解析', () => {
  it('updateProviderConfig 大小写不同仍定位规范行', () => {
    addProviderConfig('moonshot', 'https://moon.example', '', 'k1');
    const r = updateProviderConfig('MOONSHOT', { api_key: 'k2' });
    expect(r.ok).toBe(true);
    expect(getProviderConfig('moonshot')!.api_key).toBe('k2');
    expect(listProviderConfigs().filter((p: any) => p.provider.toLowerCase() === 'moonshot')).toHaveLength(1);
  });

  it('停用供应商时级联清除用规范名匹配会话覆写', () => {
    const sid = upsertSession('fp_ci_disable', 'ClaudeCode', '/v1/x');
    updateSessionUpstream(sid, 'moonshot');
    expect(getSession(sid)!.upstream_provider).toBe('moonshot');
    updateProviderConfig('MOONSHOT', { enabled: false });
    expect(getSession(sid)!.upstream_provider).toBeNull();
  });

  it('deleteProviderConfig 大小写不敏感删除并级联清理', () => {
    addProviderConfig('stepfun', 'https://step.example', '', '');
    const sid = upsertSession('fp_ci_delete', 'ClaudeCode', '/v1/x');
    updateSessionUpstream(sid, 'stepfun');
    const r = deleteProviderConfig('STEPFUN');
    expect(r.ok).toBe(true);
    expect(getProviderConfig('stepfun')).toBeNull();
    expect(getSession(sid)!.upstream_provider).toBeNull();
  });
});

describe('定价模型大小写不敏感', () => {
  it('upsertPricing provider+model 大小写不同视为同一条目', () => {
    const id1 = upsertPricing('Qwen', 'qwen3-max', 1, 0.5, 2);
    const id2 = upsertPricing('QWEN', 'QWEN3-MAX', 3, 1.5, 6);
    expect(id2).toBe(id1);
    const rows = listPricing().filter((p: any) => p.model.toLowerCase() === 'qwen3-max');
    expect(rows).toHaveLength(1);
    expect(rows[0].input_price).toBe(3);
  });
});

// 迁移测试已迁至 tests/migration.test.ts（独立临时库，避免共享库污染）

describe('查询过滤大小写不敏感', () => {
  it('listSessions 按 tool 过滤大小写不敏感', () => {
    upsertSession('fp_ci_filter', 'ClaudeCode', '/v1/messages');
    const sessions = listSessions('claudecode');
    expect(sessions.some((s: any) => s.fingerprint === 'fp_ci_filter')).toBe(true);
  });

  it('listCalls 按 tool / provider 过滤大小写不敏感', () => {
    const sid = upsertSession('fp_ci_calls', 'ClaudeCode', '/v1/messages');
    const rec: CallRecord = {
      provider: 'Anthropic', model: 'claude-sonnet-5', tool: 'ClaudeCode', endpoint: '/v1/messages',
      method: 'POST', target_url: 'https://api.anthropic.com/v1/messages', downstream_url: null, source_ip: '127.0.0.1',
      status_code: 200, error_message: null, duration_ms: 100,
      prompt_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_write_tokens: 0, uncached_input: 10,
      input_cost: 0, output_cost: 0, total_cost: 0, cache_savings: 0,
      request_body: null, response_body: null, fingerprint: 'fp_ci_calls', source_port: 0, session_id: sid,
    };
    insertCall(rec);
    expect(listCalls(undefined, 'anthropic', 'CLAUDECODE').length).toBeGreaterThan(0);
  });

  it('getStats 按 model 分组时大小写变体合并为同一条目', () => {
    upsertDailyStat('2026-08-13', 'Zhipu', 'GLM-4-Air', 'ClaudeCode', 0.1, 10, 5, 8, 2);
    upsertDailyStat('2026-08-13', 'Zhipu', 'glm-4-air', 'ClaudeCode', 0.2, 20, 10, 16, 4);
    const stats = getStats('model', 'Zhipu');
    const glm = stats.filter((s: any) => s.key.toLowerCase() === 'glm-4-air');
    expect(glm).toHaveLength(1);
    expect(glm[0].count).toBe(2);
  });

  it('getStats / getDailyStats 按 tool 过滤大小写不敏感', () => {
    upsertDailyStat('2026-08-13', 'Anthropic', 'claude-sonnet-5', 'ClaudeCode', 0.1, 100, 50, 80, 20);
    const stats = getStats('tool', undefined, 'CLAUDECODE');
    expect(stats.length).toBeGreaterThan(0);
    const daily = getDailyStats('30d', undefined, 'claudecode');
    expect(daily.length).toBeGreaterThan(0);
  });
});
