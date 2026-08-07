import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { initDb, closeDb, upsertSession, upsertPricing, listCalls } from '../proxy/db.js';
import { enqueueRecord, startRecorder, stopRecorder } from '../proxy/recorder.js';
import { createTempDb } from './setup.js';
import type { CallRecord } from '../shared/types.js';

const tmp = createTempDb();

beforeAll(async () => {
  await initDb(tmp.dbPath);
  upsertPricing('anthropic', 'claude-sonnet-5', 3.0, 0.3, 15.0);
  startRecorder();
});
afterAll(() => { stopRecorder(); closeDb(); tmp.cleanup(); });

describe('recorder', () => {
  it('消费记录：归一化 → 定价 → 写库', async () => {
    const sid = upsertSession('fp_rec', 'ClaudeCode', '/v1/messages');
    const record: CallRecord = {
      provider: 'anthropic', model: 'claude-sonnet-5-20260101',
      endpoint: '/v1/messages', method: 'POST', status_code: 200,
      error_message: null, duration_ms: 1200,
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
});
