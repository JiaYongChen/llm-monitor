/** 数据库 CRUD 测试 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { initDb, insertCall, upsertSession, listCalls, countCalls, getCall, listSessions, getSession, updateSessionStats, getStats, getDailyStats, mergeSessions, replaceProviderModels, listProviderModels, seedProviderModels, clearAllData, closeDb, queryAll, getDb, saveDb, upsertHourlyStat } from '../proxy/db.js';
import { createTempDb } from './setup.js';
import type { CallRecord } from '../shared/types.js';

const tmp = createTempDb();

beforeAll(async () => { await initDb(tmp.dbPath); });
afterAll(() => { closeDb(); tmp.cleanup(); });

describe('db', () => {
  it('initDb 建表后会话表为空', () => {
    const sessions = listSessions();
    expect(sessions).toEqual([]);
  });

  it('upsertSession 创建新会话', () => {
    const sid = upsertSession('fp_test_123', 'ClaudeCode', '/v1/models');
    expect(sid).toBeGreaterThan(0);
    const session = getSession(sid);
    expect(session).not.toBeNull();
    expect(session!.fingerprint).toBe('fp_test_123');
    expect(session!.tool).toBe('claudecode');
    expect(session!.status).toBe('active');
  });

  it('upsertSession 复用已有会话', () => {
    const sid1 = upsertSession('fp_reuse', 'codex', '/v1/chat/completions');
    const sid2 = upsertSession('fp_reuse', 'codex', '/v1/chat/completions');
    expect(sid1).toBe(sid2);
  });

  it('insertCall 插入并查询', () => {
    const sid = upsertSession('fp_calls', 'ClaudeCode', '/v1/messages');
    const rec: CallRecord = {
      provider: 'anthropic', model: 'claude-sonnet-5', tool: 'ClaudeCode', endpoint: '/v1/messages',
      method: 'POST', target_url: 'https://api.anthropic.com/v1/messages', downstream_url: 'http://localhost:9400/anthropic/v1/messages', source_ip: '127.0.0.1',
      status_code: 200, error_message: null, duration_ms: 1200,
      prompt_tokens: 500, output_tokens: 300, cache_read_tokens: 200,
      cache_write_tokens: 100, uncached_input: 400,
      input_cost: 0.005, output_cost: 0.003, total_cost: 0.008, cache_savings: 0.002,
      request_body: '{"model":"c"}', response_body: '{"ok":true}',
      fingerprint: 'fp_calls', source_port: 54321, session_id: sid,
    };
    const callId = insertCall(rec);
    expect(callId).toBeGreaterThan(0);

    const calls = listCalls(sid);
    expect(calls).toHaveLength(1);
    expect(calls[0].total_cost).toBe(0.008);

    const call = getCall(callId);
    expect(call).not.toBeNull();
    expect(call!.model).toBe('claude-sonnet-5');
    // body 已外置：calls 表列写入 NULL，文件由 recorder 路径写入
    expect(call!.request_body).toBeNull();
    expect(call!.response_body).toBeNull();
  });

  it('insertCall 模型名写入前小写化', () => {
    const sid = upsertSession('fp_model_case', 'codex', '/v1/responses');
    const rec: CallRecord = {
      provider: 'openai', model: 'GPT-5-Mini', tool: 'codex', endpoint: '/v1/responses',
      method: 'POST', target_url: 'https://api.openai.com/v1/responses', downstream_url: 'http://localhost:9400/codex/v1/responses', source_ip: '127.0.0.1',
      status_code: 200, error_message: null, duration_ms: 100,
      prompt_tokens: null, output_tokens: null, cache_read_tokens: null,
      cache_write_tokens: null, uncached_input: null,
      input_cost: 0, output_cost: 0, total_cost: 0, cache_savings: 0,
      request_body: null, response_body: null,
      fingerprint: 'fp_model_case', source_port: 1112, session_id: sid,
    };
    const callId = insertCall(rec);
    expect(getCall(callId)!.model).toBe('gpt-5-mini');
  });

  it('listCalls 分页', () => {
    const sid = upsertSession('fp_page', 'codex', '/v1/chat/completions');
    for (let i = 0; i < 5; i++) {
      const rec: CallRecord = {
        provider: 'openai', model: 'gpt-4o', tool: 'codex', endpoint: '/v1/chat/completions',
        method: 'POST', target_url: 'https://api.openai.com/v1/chat/completions', downstream_url: 'http://localhost:9400/openai/v1/chat/completions', source_ip: '127.0.0.1',
        status_code: 200, error_message: null, duration_ms: 100,
        prompt_tokens: null, output_tokens: null, cache_read_tokens: null,
        cache_write_tokens: null, uncached_input: null,
        input_cost: 0, output_cost: 0, total_cost: 0, cache_savings: 0,
        request_body: null, response_body: null,
        fingerprint: 'fp_page', source_port: 1111, session_id: sid,
      };
      insertCall(rec);
    }
    const calls = listCalls(sid, undefined, undefined, 3, 0);
    expect(calls).toHaveLength(3);
    expect(countCalls(sid)).toBe(5);  // 总数不受分页限制
  });

  it('countCalls 过滤条件与 listCalls 一致', () => {
    const sid = upsertSession('fp_count', 'codex', '/v1/chat/completions');
    const rec: CallRecord = {
      provider: 'openai', model: 'gpt-4o', tool: 'codex', endpoint: '/v1/chat/completions',
      method: 'POST', target_url: 'https://api.openai.com/v1/chat/completions', downstream_url: 'http://localhost:9400/openai/v1/chat/completions', source_ip: '127.0.0.1',
      status_code: 200, error_message: null, duration_ms: 100,
      prompt_tokens: null, output_tokens: null, cache_read_tokens: null,
      cache_write_tokens: null, uncached_input: null,
      input_cost: 0, output_cost: 0, total_cost: 0, cache_savings: 0,
      request_body: null, response_body: null,
      fingerprint: 'fp_count', source_port: 1112, session_id: sid,
    };
    insertCall(rec);
    expect(countCalls(sid)).toBe(1);
    expect(countCalls(sid, 'openai')).toBe(1);
    expect(countCalls(sid, 'anthropic')).toBe(0);
    expect(countCalls()).toBeGreaterThanOrEqual(1);  // 无过滤 = 全表
  });

  it('updateSessionStats 更新会话统计', () => {
    const sid = upsertSession('fp_stats', 'ClaudeCode', '/v1/messages');
    updateSessionStats(sid, 0.05, 200);
    updateSessionStats(sid, 0.03, 150);
    const session = getSession(sid);
    expect(session!.request_count).toBe(2);
    expect(session!.total_cost).toBeCloseTo(0.08, 4);
    expect(session!.total_tokens).toBe(350);
  });

  it('getStats 聚合统计（从 hourly_stats 读取）', () => {
    // stats 已改为从 hourly_stats 表聚合，需先通过 upsertHourlyStat 写入数据
    // 写入侧供应商名归一化：'anthropic' → 小写存储 'anthropic'
    upsertHourlyStat('anthropic', 'claude-sonnet-5', 'ClaudeCode', 0.03, 100, 50, 100, 0, Date.UTC(2026, 7, 12, 4));
    const stats = getStats('provider');
    const anthropic = stats.find((s: any) => s.key === 'anthropic');
    expect(anthropic).toBeDefined();
    expect(anthropic!.count).toBeGreaterThanOrEqual(1);
  });

  it('getDailyStats 按小时聚合（today 范围，日期动态计算避免依赖具体日期）', () => {
    // today 范围返回小时标签（'YYYY-MM-DD HH:00'）；行用默认 createdAtMs（Date.now()，必落在 today 窗口内）
    upsertHourlyStat('OpenAI', 'gpt-4o-daily', 'codex', 0.05, 100, 50, 80, 20);
    const rows = getDailyStats('today', 'OpenAI');
    const row = rows.find((r: any) => /^\d{4}-\d{2}-\d{2} \d{2}:00$/.test(r.date));
    expect(row).toBeDefined();
    expect(row!.count).toBe(1);
    expect(row!.total_cost).toBeCloseTo(0.05);
    // 分组查询：返回 category 列（与旧返回格式一致，前端零改动）
    const grouped = getDailyStats('today', 'OpenAI', undefined, 'model');
    const gRow = grouped.find((r: any) => /^\d{4}-\d{2}-\d{2} \d{2}:00$/.test(r.date) && r.category === 'gpt-4o-daily');
    expect(gRow).toBeDefined();
    expect(gRow!.count).toBe(1);
  });

  it('mergeSessions 合并', () => {
    const sid1 = upsertSession('fp_merge_a', 'ClaudeCode', '/v1/messages');
    const sid2 = upsertSession('fp_merge_b', 'ClaudeCode', '/v1/messages');
    const rec: CallRecord = {
      provider: 'anthropic', model: 'c', tool: 'ClaudeCode', endpoint: '/e', method: 'POST',
      target_url: 'https://api.anthropic.com/e', downstream_url: 'http://localhost:9400/e', source_ip: '127.0.0.1',
      status_code: 200, error_message: null, duration_ms: 100,
      fingerprint: 'fp_merge_b', session_id: sid2,
      prompt_tokens: null, output_tokens: null, cache_read_tokens: null,
      cache_write_tokens: null, uncached_input: null,
      input_cost: 0, output_cost: 0, total_cost: 0.10, cache_savings: 0,
      request_body: null, response_body: null, source_port: 3333,
    };
    insertCall(rec);
    mergeSessions(sid2, sid1);
    const calls = listCalls(sid1);
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(getSession(sid2)).toBeNull();
  });

  it('provider_models 价格写入与覆盖', () => {
    replaceProviderModels('test', ['test-model'], new Map([['test-model', { input_price: 1, cache_input_price: 0.5, output_price: 2 }]]), Date.now());
    let row = listProviderModels().find(r => r.provider === 'test' && r.model === 'test-model')!;
    expect(row.input_price).toBe(1);
    expect(row.cache_input_price).toBe(0.5);
    expect(row.output_price).toBe(2);
    expect(row.currency).toBe('USD');
    // 覆盖写入
    replaceProviderModels('test', ['test-model'], new Map([['test-model', { input_price: 3, cache_input_price: 1.5, output_price: 6 }]]), Date.now());
    row = listProviderModels().find(r => r.provider === 'test' && r.model === 'test-model')!;
    expect(row.input_price).toBe(3);
    // 价格 null：价格列不动
    replaceProviderModels('test', ['test-model'], null, Date.now());
    row = listProviderModels().find(r => r.provider === 'test' && r.model === 'test-model')!;
    expect(row.input_price).toBe(3);
  });

  it('upsertHourlyStat 新增记录', () => {
    upsertHourlyStat('OpenAI', 'gpt-4o', 'codex', 0.05, 100, 50, 80, 20, 1786604160000);
    // hour_ms = floor(1786604160000 / 3600000) * 3600000 = 1786600800000（UTC 小时边界下取整）
    // 按完整主键查询，避免同时段其他用例（getStats/getDailyStats 写入）干扰行数断言
    // upsertHourlyStat 会归一化工具名 / 供应商名：任意大小写 → 小写存储
    const rows = queryAll("SELECT * FROM hourly_stats WHERE hour_ms = 1786600800000 AND provider = 'openai' AND model = 'gpt-4o' AND tool = 'codex'");
    expect(rows).toHaveLength(1);
    expect(rows[0].call_count).toBe(1);
    expect(rows[0].total_cost).toBeCloseTo(0.05);
    expect(rows[0].prompt_tokens).toBe(100);
    expect(rows[0].output_tokens).toBe(50);
    expect(rows[0].uncached_input).toBe(80);
    expect(rows[0].cache_read_tokens).toBe(20);
    expect(rows[0].created_at).toBe(1786604160000);
  });

  // createdAtMs 用下一小时内两个时刻（1786607760000 / 1786607760100，hour_ms 下取整为 1786604400000），
  // 与上一条用例（同 provider/model/tool、hour_ms=1786600800000）隔离，避免共享数据库中的累加干扰断言
  it('upsertHourlyStat 重复键累加且 created_at 不变 updated_at 刷新', () => {
    upsertHourlyStat('OpenAI', 'gpt-4o', 'codex', 0.03, 50, 30, 40, 10, 1786607760000);
    upsertHourlyStat('OpenAI', 'gpt-4o', 'codex', 0.02, 30, 20, 20, 5, 1786607760100);
    const rows = queryAll("SELECT * FROM hourly_stats WHERE hour_ms = 1786604400000 AND provider = 'openai' AND model = 'gpt-4o' AND tool = 'codex'");
    expect(rows).toHaveLength(1);
    expect(rows[0].call_count).toBe(2);
    expect(rows[0].total_cost).toBeCloseTo(0.05);
    expect(rows[0].created_at).toBe(1786607760000);   // 首次创建不变
    // updated_at 为写入时的墙钟时间（Date.now()，非 createdAtMs），断言刷新为更新的值
    expect(rows[0].updated_at).toBeGreaterThan(rows[0].created_at);
  });

  it('upsertHourlyStat model 为空值时回退 unknown 不抛错', () => {
    upsertHourlyStat('OpenAI', null as any, 'codex', 0.01, 10, 5, 8, 2, 1786604160000);
    const rows = queryAll("SELECT * FROM hourly_stats WHERE hour_ms = 1786600800000 AND provider = 'openai' AND model = 'unknown' AND tool = 'codex'");
    expect(rows).toHaveLength(1);
  });
});

describe('老库 pricing 表直删', () => {
  // 独立临时库 + 本用例位于文件末尾（用例内会 closeDb 切换单例，之后无其他用例依赖共享库；afterAll closeDb 幂等）
  it('老库含 pricing 表：initDb 后 pricing 被 DROP，不迁移历史定价', async () => {
    // 模拟老库：先关闭 beforeAll 打开的共享库，让 initDb 真正切换到独立库
    const old = createTempDb();
    closeDb();
    await initDb(old.dbPath);
    // 用 raw SQL 模拟老库 pricing 存量（当前 initDb 已不建 pricing，需手动建后再重启验证 DROP）
    const d = getDb();
    d.run(`CREATE TABLE IF NOT EXISTS pricing (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL, model TEXT NOT NULL,
      input_price REAL NOT NULL, cache_input_price REAL NOT NULL, output_price REAL NOT NULL,
      unit TEXT NOT NULL DEFAULT 'per_1M_tokens', currency TEXT NOT NULL DEFAULT 'CNY',
      effective_from TEXT, created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0,
      UNIQUE(provider, model, effective_from)
    )`);
    d.run(`INSERT INTO pricing (provider, model, input_price, cache_input_price, output_price) VALUES ('legacy-prov', 'legacy-model', 1, 0.5, 2)`);
    saveDb();
    closeDb();
    // 重新打开（当前版本 initDb）：pricing 应被 DROP
    await initDb(old.dbPath);
    const rows = queryAll("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'pricing'");
    expect(rows).toHaveLength(0);
    // provider_models 不含迁移数据（不迁移历史定价）
    expect(listProviderModels().filter(r => r.provider === 'legacy-prov')).toHaveLength(0);
    closeDb();
    old.cleanup();
  });
});
