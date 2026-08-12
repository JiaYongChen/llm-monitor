/** 数据库 CRUD 测试 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { initDb, insertCall, upsertSession, listCalls, getCall, listSessions, getSession, updateSessionStats, getStats, mergeSessions, upsertPricing, listPricing, deletePricing, clearAllData, closeDb, queryAll } from '../proxy/db.js';
import { createTempDb } from './setup.js';
import { upsertDailyStat } from '../proxy/db.js';
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
    expect(session!.tool).toBe('ClaudeCode');
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

  it('getStats 聚合统计', () => {
    const sid = upsertSession('fp_aggr', 'ClaudeCode', '/v1/messages');
    const rec: CallRecord = {
      provider: 'anthropic', model: 'claude-sonnet-5', tool: 'ClaudeCode', endpoint: '/v1/messages',
      method: 'POST', target_url: 'https://api.anthropic.com/v1/messages', downstream_url: 'http://localhost:9400/anthropic/v1/messages', source_ip: '127.0.0.1',
      status_code: 200, error_message: null, duration_ms: 100,
      prompt_tokens: 100, output_tokens: 50, cache_read_tokens: null,
      cache_write_tokens: null, uncached_input: 100,
      input_cost: 0.01, output_cost: 0.02, total_cost: 0.03, cache_savings: 0,
      request_body: null, response_body: null,
      fingerprint: 'fp_aggr', source_port: 2222, session_id: sid,
    };
    insertCall(rec);
    const stats = getStats('provider');
    const anthropic = stats.find((s: any) => s.key === 'anthropic');
    expect(anthropic).toBeDefined();
    expect(anthropic!.count).toBeGreaterThanOrEqual(1);
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
    const rows = queryAll("SELECT * FROM daily_stats WHERE date = '2026-08-12'");
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
    const rows = queryAll("SELECT * FROM daily_stats WHERE date = '2026-08-13'");
    expect(rows).toHaveLength(1);
    expect(rows[0].call_count).toBe(2);
    expect(rows[0].total_cost).toBeCloseTo(0.05);
    expect(rows[0].prompt_tokens).toBe(80);
    expect(rows[0].output_tokens).toBe(50);
  });
});
