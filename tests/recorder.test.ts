import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { initDb, closeDb, upsertSession, upsertPricing, listCalls, addProviderConfig } from '../proxy/db.js';
import { enqueueRecord, startRecorder, stopRecorder } from '../proxy/recorder.js';
import { createTempDb } from './setup.js';
import type { CallRecord } from '../shared/types.js';

const tmp = createTempDb();

beforeAll(async () => {
  await initDb(tmp.dbPath);
  upsertPricing('anthropic', 'claude-sonnet-5', 3.0, 0.3, 15.0);
  upsertPricing('DeepSeek', 'deepseek-chat', 1.0, 0, 2.0, 'CNY');
  // 添加 DeepSeek 供应商（格式由上游 URL 自动检测）
  addProviderConfig('DeepSeek', 'https://api.deepseek.com', '', '');
  startRecorder();
});
afterAll(() => { stopRecorder(); closeDb(); tmp.cleanup(); });

describe('recorder', () => {
  it('消费记录：归一化 → 定价 → 写库', async () => {
    const sid = upsertSession('fp_rec', 'ClaudeCode', '/v1/messages');
    const record: CallRecord = {
      provider: 'anthropic', model: 'claude-sonnet-5-20260101',
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
  });

  it('★ 通过上游 URL 检测格式：非 anthropic 一律按 OpenAI 归一化', async () => {
    const sid = upsertSession('fp_deepseek', 'codex', '/v1/chat/completions');
    const record: CallRecord = {
      provider: 'DeepSeek', model: 'deepseek-chat',
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
    // provider 不是 'Anthropic' → 按 OpenAI 格式归一化
    expect(calls[0].prompt_tokens).toBe(200);
    expect(calls[0].output_tokens).toBe(100);
    expect(calls[0].total_cost).toBeGreaterThan(0);
  });
});
