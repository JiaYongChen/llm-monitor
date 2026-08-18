/** body 外置读写测试 — 落库后外置写文件可读回的完整路径（原渐进迁移用例已随迁移机制删除，读写行为用例保留） */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { initDb, closeDb, getDb, queryAll, insertCall } from '../proxy/db.js';
import { readBody, writeBody } from '../proxy/db-body.js';
import { createTempDb } from './setup.js';

const tmp = createTempDb();

beforeAll(async () => {
  await initDb(tmp.dbPath);
});
afterAll(() => { closeDb(); tmp.cleanup(); });

describe('body 外置读写', () => {
  it('insertCall 落库后 body 外置写文件可读回（与 recorder.ts 路径一致）', () => {
    const now = Date.now();
    const newId = insertCall({
      provider: 'openai', model: 'gpt-4o', tool: 'codex', endpoint: '/v1/x', method: 'POST',
      target_url: null, downstream_url: null, source_ip: null, status_code: 200, error_message: null,
      duration_ms: 10, prompt_tokens: 1, output_tokens: 1, cache_read_tokens: null, cache_write_tokens: null,
      uncached_input: null, input_cost: 0, output_cost: 0, total_cost: 0, cache_savings: 0,
      request_body: null, response_body: null, fingerprint: 'fp_body_rw', source_port: null, session_id: 1, created_at: now,
    });
    // DB 落库后 body 外置写文件，详情接口 readBody 读回
    writeBody(1, newId, now, '{"m":"new"}', '{"ok":1}');
    const body = readBody(1, newId, now);
    expect(body?.request).toBe('{"m":"new"}');
    expect(body?.response).toBe('{"ok":1}');
    // 落库行存在且与文件路径参数一致（session_id/created_at 对齐）
    const row = getDb().exec(`SELECT session_id, created_at FROM calls WHERE id = ${newId}`)[0]?.values[0];
    expect(Number(row[0])).toBe(1);
    expect(Number(row[1])).toBe(now);
  });

  it('writeBody 写文件后 readBody 精确读回，同会话多调用按 callId 隔离', () => {
    writeBody(1, 100, 1786600800000, '{"m":"a"}', '{"ok":1}');
    writeBody(1, 101, 1786600800001, '{"m":"b"}', '{"ok":2}');
    expect(readBody(1, 100, 1786600800000)?.request).toBe('{"m":"a"}');
    expect(readBody(1, 101, 1786600800001)?.request).toBe('{"m":"b"}');
    expect(readBody(1, 102, 1786600800002)).toBeNull();   // 未写过的调用读回 null
  });

  it('response 为 null 时读回 request 保持非空', () => {
    writeBody(1, 103, 1786600800003, '{"m":"c"}', null);
    const body = readBody(1, 103, 1786600800003);
    expect(body?.request).toBe('{"m":"c"}');
    expect(body?.response).toBeNull();
  });
});
