/** 数据库 CRUD 测试 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { initDb, insertCall, upsertSession, listCalls, getCall, listSessions, getSession, updateSessionStats, getStats, getDailyStats, mergeSessions, upsertPricing, listPricing, deletePricing, clearAllData, closeDb, queryAll, upsertDailyStat } from '../proxy/db.js';
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

  it('getStats 聚合统计（从 daily_stats 读取）', () => {
    // stats 已改为从 daily_stats 表聚合，需先通过 upsertDailyStat 写入数据
    // 写入侧供应商名归一化：'anthropic' → 小写存储 'anthropic'
    upsertDailyStat('2026-08-12', 'anthropic', 'claude-sonnet-5', 'ClaudeCode', 0.03, 100, 50, 100, 0);
    const stats = getStats('provider');
    const anthropic = stats.find((s: any) => s.key === 'anthropic');
    expect(anthropic).toBeDefined();
    expect(anthropic!.count).toBeGreaterThanOrEqual(1);
  });

  it('getDailyStats 按天聚合（today 范围，日期动态计算避免依赖具体日期）', () => {
    // 与后端窗口边界同法计算目标时区（UTC+8）的"今天"日期文本
    const now = new Date();
    const utcNow = new Date(now.getTime() + now.getTimezoneOffset() * 60000 + 8 * 3600000);
    const pad = (n: number) => String(n).padStart(2, '0');
    const todayText = `${utcNow.getFullYear()}-${pad(utcNow.getMonth() + 1)}-${pad(utcNow.getDate())}`;
    upsertDailyStat(todayText, 'OpenAI', 'gpt-4o-daily', 'codex', 0.05, 100, 50, 80, 20);
    const rows = getDailyStats('today', 'OpenAI');
    const row = rows.find((r: any) => r.date === todayText);
    expect(row).toBeDefined();
    expect(row!.count).toBe(1);
    expect(row!.total_cost).toBeCloseTo(0.05);
    // 分组查询：返回 category 列（与旧返回格式一致，前端零改动）
    const grouped = getDailyStats('today', 'OpenAI', undefined, 'model');
    const gRow = grouped.find((r: any) => r.date === todayText && r.category === 'gpt-4o-daily');
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

  it('pricing CRUD', () => {
    const id = upsertPricing('test', 'test-model', 1.0, 0.5, 2.0);
    expect(id).toBeGreaterThan(0);
    const list = listPricing();
    expect(list.some((p: any) => p.id === id)).toBe(true);
    deletePricing(id);
    const after = listPricing();
    expect(after.some((p: any) => p.id === id)).toBe(false);
  });

  it('upsertDailyStat 新增记录', () => {
    upsertDailyStat('2026-08-12', 'OpenAI', 'gpt-4o', 'codex', 0.05, 100, 50, 80, 20);
    // 按完整主键查询，避免同日期其他用例（getStats/getDailyStats 写入）干扰行数断言
    // upsertDailyStat 会归一化工具名 / 供应商名：任意大小写 → 小写存储
    const rows = queryAll("SELECT * FROM daily_stats WHERE date = '2026-08-12' AND provider = 'openai' AND model = 'gpt-4o' AND tool = 'codex'");
    expect(rows).toHaveLength(1);
    expect(rows[0].call_count).toBe(1);
    expect(rows[0].total_cost).toBeCloseTo(0.05);
    expect(rows[0].prompt_tokens).toBe(100);
    expect(rows[0].output_tokens).toBe(50);
    expect(rows[0].uncached_input).toBe(80);
    expect(rows[0].cache_read_tokens).toBe(20);
  });

  // 日期用 2026-08-13，与上一条用例（2026-08-12 同键）隔离，避免共享数据库中的累加干扰断言
  it('upsertDailyStat 重复键累加', () => {
    upsertDailyStat('2026-08-13', 'OpenAI', 'gpt-4o', 'codex', 0.03, 50, 30, 40, 10);
    upsertDailyStat('2026-08-13', 'OpenAI', 'gpt-4o', 'codex', 0.02, 30, 20, 20, 5);
    const rows = queryAll("SELECT * FROM daily_stats WHERE date = '2026-08-13' AND provider = 'openai' AND model = 'gpt-4o' AND tool = 'codex'");
    expect(rows).toHaveLength(1);
    expect(rows[0].call_count).toBe(2);
    expect(rows[0].total_cost).toBeCloseTo(0.05);
    expect(rows[0].prompt_tokens).toBe(80);
    expect(rows[0].output_tokens).toBe(50);
  });

  it('upsertDailyStat model 为空值时回退 unknown 不抛错', () => {
    upsertDailyStat('2026-08-13', 'OpenAI', null as any, 'codex', 0.01, 10, 5, 8, 2);
    const rows = queryAll("SELECT * FROM daily_stats WHERE date = '2026-08-13' AND provider = 'openai' AND model = 'unknown' AND tool = 'codex'");
    expect(rows).toHaveLength(1);
  });
});
