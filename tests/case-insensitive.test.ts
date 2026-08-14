/** 大小写不敏感测试 — 工具 / 供应商 / 模型名匹配不区分大小写，存储为小写 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  initDb, closeDb, createPendingSession, upsertSession, getSession,
  getToolConfig, updateToolConfig, listToolConfigs, listSessions, listCalls,
  getStats, getDailyStats, upsertPricing, listPricing, addProviderConfig,
  listProviderConfigs, updateSessionUpstream, normalizeToolName, insertCall,
  upsertHourlyStat, getDb, updateProviderConfig,
  deleteProviderConfig, getProviderConfig, normalizeProviderName,
} from '../proxy/db.js';
import { toolFromProvider } from '../proxy/session.js';
import { createTempDb } from './setup.js';
import type { CallRecord } from '../shared/types.js';

const tmp = createTempDb();
beforeAll(async () => { await initDb(tmp.dbPath); });
afterAll(() => { closeDb(); tmp.cleanup(); });

describe('normalizeToolName', () => {
  it('内置工具名大小写归一化为小写', () => {
    expect(normalizeToolName('claudeCode')).toBe('claudecode');
    expect(normalizeToolName('CLAUDECODE')).toBe('claudecode');
    expect(normalizeToolName('claude')).toBe('claudecode');
    expect(normalizeToolName('CodeX')).toBe('codex');
    expect(normalizeToolName('CODEX')).toBe('codex');
  });

  it('chatGPT 归一化为 codex', () => {
    expect(normalizeToolName('chatGPT')).toBe('codex');
    expect(normalizeToolName('chatgpt')).toBe('codex');
    expect(normalizeToolName('CHATGPT')).toBe('codex');
  });

  it('未注册工具转小写', () => {
    expect(normalizeToolName('MyTool')).toBe('mytool');
  });

  it('未注册工具大小写变体统一收敛为小写', () => {
    const sid = createPendingSession('newtool');
    expect(getSession(sid)!.tool).toBe('newtool');
    const sid2 = upsertSession('fp_newtool_variant', 'NEWTOOL', '/v1/x');
    expect(sid2).toBe(sid);
    expect(getSession(sid2)!.tool).toBe('newtool');
  });

  it('自定义工具大小写不敏感匹配 tool_config，返回小写名', () => {
    updateToolConfig('cursor', 'OpenAI', null);
    expect(normalizeToolName('CURSOR')).toBe('cursor');
    expect(normalizeToolName('Cursor')).toBe('cursor');
  });
});

describe('会话存储规范工具名', () => {
  it('createPendingSession 归一化工具名', () => {
    const id1 = createPendingSession('claudeCode');
    expect(getSession(id1)!.tool).toBe('claudecode');
    const id2 = createPendingSession('CODEX');
    expect(getSession(id2)!.tool).toBe('codex');
    const id3 = createPendingSession('chatgpt');
    expect(getSession(id3)!.tool).toBe('codex');
  });

  it('createPendingSession 自定义工具继承 tool_config（大小写不敏感）', () => {
    updateToolConfig('cursor', 'OpenAI', 'gpt-test');
    const id = createPendingSession('CURSOR');
    const s = getSession(id)!;
    expect(s.tool).toBe('cursor');
    expect(s.upstream_provider).toBe('openai');
    expect(s.upstream_model).toBe('gpt-test');
  });

  it('upsertSession 归一化工具名', () => {
    const sid = upsertSession('fp_ci_upsert', 'claudecode', '/v1/messages');
    expect(getSession(sid)!.tool).toBe('claudecode');
  });

  it('toolFromProvider 大小写不敏感', () => {
    expect(toolFromProvider('Anthropic')).toBe('claudecode');
    expect(toolFromProvider('OPENAI')).toBe('codex');
  });
});

describe('tool_config 大小写不敏感', () => {
  it('getToolConfig 大小写不敏感查找', () => {
    updateToolConfig('ClaudeCode', 'Qwen', 'qwen-test');
    const tc = getToolConfig('CLAUDECODE');
    expect(tc).not.toBeNull();
    expect(tc!.tool).toBe('claudecode');
    expect(tc!.upstream_provider).toBe('qwen');
  });

  it('updateToolConfig 大小写不同视为同一工具，不产生重复行', () => {
    updateToolConfig('windsurf', 'OpenAI', null);
    updateToolConfig('WINDSURF', 'Anthropic', null);
    const rows = listToolConfigs().filter((r: any) => r.tool.toLowerCase() === 'windsurf');
    expect(rows).toHaveLength(1);
    expect(rows[0].upstream_provider).toBe('anthropic');
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

  it('updateSessionUpstream 存储供应商小写名', () => {
    const sid = upsertSession('fp_ci_upstream', 'ClaudeCode', '/v1/messages');
    updateSessionUpstream(sid, 'anthropic');
    expect(getSession(sid)!.upstream_provider).toBe('anthropic');
  });
});

describe('addProviderConfig 边界', () => {
  it('与内置供应商仅大小写不同 → 提示已存在，不插入新行、不覆写内置行', () => {
    expect(() => addProviderConfig('openai', 'https://my-gateway.example', '', 'gw-key')).toThrow(/已存在/);
    const rows = listProviderConfigs().filter((r: any) => r.provider.toLowerCase() === 'openai');
    expect(rows.length).toBe(1);
    expect(rows[0].provider).toBe('openai');
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

describe('归一化为纯小写函数（无查表依赖）', () => {
  it('未注册供应商名直接转小写', () => {
    expect(normalizeProviderName('CACHEPROV')).toBe('cacheprov');
    expect(normalizeProviderName('MiXeD')).toBe('mixed');
  });

  it('工具名纯函数小写化', () => {
    expect(normalizeToolName('CacheTool')).toBe('cachetool');
    expect(normalizeToolName('cACHETOOL')).toBe('cachetool');
  });
});

describe('上游供应商归一化对称性', () => {
  it('updateToolConfig 归一化 upstream_provider 为小写', () => {
    updateToolConfig('windsurf', 'ANTHROPIC', null);
    expect(getToolConfig('windsurf')!.upstream_provider).toBe('anthropic');
  });

  it('会话继承 tool_config 时 upstream_provider 已归一化', () => {
    // 直接 SQL 插入历史数据（绕过 updateToolConfig 归一化，模拟大小写变体）
    getDb().run(`INSERT INTO tool_config (tool, upstream_provider) VALUES ('legacytool', 'anthropic')`);
    const sid1 = createPendingSession('legacytool');
    expect(getSession(sid1)!.upstream_provider).toBe('anthropic');
    const sid2 = upsertSession('fp_ci_inherit', 'legacytool', '/v1/x');
    expect(getSession(sid2)!.upstream_provider).toBe('anthropic');
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
    // 同一 hour_ms 内两次调用（模型大小写变体归一化后合并为同一行）
    upsertHourlyStat('Zhipu', 'GLM-4-Air', 'ClaudeCode', 0.1, 10, 5, 8, 2, Date.UTC(2026, 7, 13, 4));
    upsertHourlyStat('Zhipu', 'glm-4-air', 'ClaudeCode', 0.2, 20, 10, 16, 4, Date.UTC(2026, 7, 13, 4));
    const stats = getStats('model', 'Zhipu');
    const glm = stats.filter((s: any) => s.key.toLowerCase() === 'glm-4-air');
    expect(glm).toHaveLength(1);
    expect(glm[0].count).toBe(2);
  });

  it('getStats / getDailyStats 按 tool 过滤大小写不敏感', () => {
    upsertHourlyStat('Anthropic', 'claude-sonnet-5', 'ClaudeCode', 0.1, 100, 50, 80, 20, Date.UTC(2026, 7, 13, 4));
    const stats = getStats('tool', undefined, 'CLAUDECODE');
    expect(stats.length).toBeGreaterThan(0);
    const daily = getDailyStats('30d', undefined, 'claudecode');
    expect(daily.length).toBeGreaterThan(0);
  });
});
