import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { initDb, closeDb, upsertSession, replaceProviderModels, listCalls, addProviderConfig, queryAll } from '../proxy/db.js';
import { enqueueRecord, startRecorder, stopRecorder } from '../proxy/recorder.js';
import { readBody } from '../proxy/db-body.js';
import { createTempDb } from './setup.js';
import type { CallRecord } from '../shared/types.js';

const tmp = createTempDb();

beforeAll(async () => {
  await initDb(tmp.dbPath);
  replaceProviderModels('anthropic', ['claude-sonnet-5'], new Map([['claude-sonnet-5', { input_price: 3.0, cache_input_price: 0.3, output_price: 15.0 }]]), Date.now());
  replaceProviderModels('deepseek', ['deepseek-chat'], new Map([['deepseek-chat', { input_price: 1.0, cache_input_price: 0, output_price: 2.0 }]]), Date.now());
  // 添加 DeepSeek 供应商（格式由上游 URL 自动检测）
  addProviderConfig('DeepSeek', 'https://api.deepseek.com', '', '');
  startRecorder();
});
afterAll(() => { stopRecorder(); closeDb(); tmp.cleanup(); });

describe('recorder', () => {
  it('消费记录：归一化 → 定价 → 写库', async () => {
    const sid = upsertSession('fp_rec', 'ClaudeCode', '/v1/messages');
    const record: CallRecord = {
      provider: 'anthropic', model: 'claude-sonnet-5-20260101', tool: 'ClaudeCode',
      endpoint: '/v1/messages', method: 'POST',
      target_url: 'https://api.anthropic.com/v1/messages', downstream_url: 'http://localhost:9400/anthropic/v1/messages', source_ip: '127.0.0.1',
      status_code: 200, error_message: null, duration_ms: 1200,
      request_body: null,
      response_body: JSON.stringify({
        model: 'claude-sonnet-5',
        usage: { input_tokens: 500, output_tokens: 300, cache_creation_input_tokens: 100, cache_read_input_tokens: 200 },
      }),
      fingerprint: 'fp_rec', source_port: 54321, session_id: sid,
      prompt_tokens: null, output_tokens: null, cache_read_tokens: null,
      cache_write_tokens: null, uncached_input: null,
      input_cost: 0, output_cost: 0, total_cost: 0, cache_savings: 0,
    };
    enqueueRecord(record);
    await new Promise(r => setTimeout(r, 300));

    const calls = listCalls(sid);
    expect(calls.length).toBe(1);
    expect(calls[0].total_cost).toBeGreaterThan(0);
    expect(calls[0].prompt_tokens).toBe(500);
    expect(calls[0].cache_read_tokens).toBe(200);

    // 验证 hourly_stats 通过 recorder 真实路径累加（供应商名写入时小写存储 'anthropic'）
    const stats = queryAll("SELECT * FROM hourly_stats WHERE provider = 'anthropic'");
    expect(stats.length).toBe(1);
    expect(stats[0].call_count).toBe(1);
    expect(stats[0].hour_ms).toBeDefined();  // hour_ms 由 createdAtMs 整数运算得出（UTC 小时边界）
    expect(stats[0].output_tokens).toBe(300);
    expect(stats[0].uncached_input).toBe(400);  // prompt_tokens(500) - cache_write(100)
    expect(stats[0].cache_read_tokens).toBe(200);

    // body 已外置为文件（先 DB 后文件）：calls 表 body 列为 NULL，内容可经 readBody 读回
    const row = queryAll("SELECT * FROM calls WHERE fingerprint = 'fp_rec'")[0];
    expect(row.request_body).toBeNull();
    expect(row.response_body).toBeNull();
    const body = readBody(row.session_id, row.id, row.created_at);
    expect(body?.response).toBe(record.response_body);
  });

  it('★ 通过上游 URL 检测格式：非 anthropic 一律按 OpenAI 归一化', async () => {
    const sid = upsertSession('fp_deepseek', 'codex', '/v1/chat/completions');
    const record: CallRecord = {
      provider: 'DeepSeek', model: 'deepseek-chat', tool: 'DeepSeek',
      endpoint: '/v1/chat/completions', method: 'POST',
      target_url: 'https://api.deepseek.com/v1/chat/completions', downstream_url: 'http://localhost:9400/DeepSeek/v1/chat/completions', source_ip: '127.0.0.1',
      status_code: 200, error_message: null, duration_ms: 800,
      request_body: null,
      response_body: JSON.stringify({
        model: 'deepseek-chat',
        usage: { prompt_tokens: 200, completion_tokens: 100 },
      }),
      fingerprint: 'fp_deepseek', source_port: 54322, session_id: sid,
      prompt_tokens: null, output_tokens: null, cache_read_tokens: null,
      cache_write_tokens: null, uncached_input: null,
      input_cost: 0, output_cost: 0, total_cost: 0, cache_savings: 0,
    };
    enqueueRecord(record);
    await new Promise(r => setTimeout(r, 300));

    const calls = listCalls(sid);
    expect(calls.length).toBe(1);
    // provider 不是 'anthropic' → 按 OpenAI 格式归一化
    expect(calls[0].prompt_tokens).toBe(200);
    expect(calls[0].output_tokens).toBe(100);
    expect(calls[0].total_cost).toBeGreaterThan(0);

    // 验证 hourly_stats 通过 recorder 真实路径累加（供应商名小写存储 'deepseek'）
    const stats = queryAll("SELECT * FROM hourly_stats WHERE provider = 'deepseek'");
    expect(stats.length).toBe(1);
    expect(stats[0].call_count).toBe(1);
    expect(stats[0].output_tokens).toBe(100);
  });

  it('★ hourly_stats tool 归一化：空 tool 自动兜底 unknown', async () => {
    // 构造 tool 为空字符串的记录，验证 upsertHourlyStat 内部归一化
    const record: CallRecord = {
      provider: 'anthropic', model: 'claude-sonnet-5', tool: '',  // 空 tool
      endpoint: '/v1/messages', method: 'POST',
      target_url: 'https://api.anthropic.com/v1/messages', downstream_url: 'http://localhost:9400/anthropic/v1/messages', source_ip: '127.0.0.1',
      status_code: 200, error_message: null, duration_ms: 500,
      request_body: null,
      response_body: JSON.stringify({
        model: 'claude-sonnet-5',
        usage: { input_tokens: 100, output_tokens: 50 },
      }),
      fingerprint: 'fp_tool_norm', source_port: 54323, session_id: 1,
      prompt_tokens: null, output_tokens: null, cache_read_tokens: null,
      cache_write_tokens: null, uncached_input: null,
      input_cost: 0, output_cost: 0, total_cost: 0, cache_savings: 0,
    };
    enqueueRecord(record);
    await new Promise(r => setTimeout(r, 300));

    const stats = queryAll("SELECT * FROM hourly_stats WHERE tool = 'unknown'");
    expect(stats.length).toBe(1);
    expect(stats[0].call_count).toBe(1);
    expect(stats[0].hour_ms).toBeDefined();
    // tool 为 NULL 的行不应存在
    const nullStats = queryAll('SELECT * FROM hourly_stats WHERE tool IS NULL');
    expect(nullStats.length).toBe(0);
  });
});
