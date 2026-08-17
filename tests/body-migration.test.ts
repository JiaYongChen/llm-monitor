/** body 渐进迁移测试 — 构造带 body 列的老库，验证分片迁移、幂等续跑与 DROP COLUMN */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { initDb, closeDb, getDb, queryAll, insertCall } from '../proxy/db.js';
import { migrateLegacyBodies, finishBodyMigration, readBody, writeBody } from '../proxy/db-body.js';
import { createTempDb } from './setup.js';

const tmp = createTempDb();

beforeAll(async () => {
  await initDb(tmp.dbPath);
  const d = getDb();
  // 构造带 body 列的老库状态：新库 schema 仍保留 body 列（迁移期列保留，Task 4 起新写入恒 NULL），
  // 直接插入带 body 内容的历史行模拟"迁移完成前"的存量数据
  d.run(`INSERT INTO calls (session_id, provider, model, endpoint, method, duration_ms, fingerprint, tool, created_at, request_body, response_body)
         VALUES (1, 'openai', 'gpt-4o', '/v1/x', 'POST', 10, 'fp_bm_1', 'codex', 1786600800000, '{"m":"a"}', '{"ok":1}')`);
  d.run(`INSERT INTO calls (session_id, provider, model, endpoint, method, duration_ms, fingerprint, tool, created_at, request_body, response_body)
         VALUES (1, 'openai', 'gpt-4o', '/v1/x', 'POST', 10, 'fp_bm_2', 'codex', 1786600800001, NULL, NULL)`);
  d.run(`INSERT INTO calls (session_id, provider, model, endpoint, method, duration_ms, fingerprint, tool, created_at, request_body, response_body)
         VALUES (1, 'openai', 'gpt-4o', '/v1/x', 'POST', 10, 'fp_bm_3', 'codex', 1786600800002, '{"m":"c"}', NULL)`);
  d.run(`INSERT INTO calls (session_id, provider, model, endpoint, method, duration_ms, fingerprint, tool, created_at, request_body, response_body)
         VALUES (1, 'openai', 'gpt-4o', '/v1/x', 'POST', 10, 'fp_bm_4', 'codex', 1786600800003, '{"m":"d"}', '{"ok":4}')`);
});
afterAll(() => { closeDb(); tmp.cleanup(); });

describe('body 渐进迁移', () => {
  it('migrateLegacyBodies 分批迁移并返回剩余数', () => {
    expect(migrateLegacyBodies(2)).toBe(1);   // 3 行带 body（NULL 行跳过）→ 处理 2 剩 1
    expect(migrateLegacyBodies(2)).toBe(0);   // 处理最后 1 行
    const row = queryAll("SELECT id, session_id, created_at, request_body, response_body FROM calls WHERE fingerprint = 'fp_bm_1'")[0];
    expect(row.request_body).toBeNull();
    expect(row.response_body).toBeNull();
    const body = readBody(row.session_id, row.id, row.created_at);
    expect(body?.request).toBe('{"m":"a"}');
    expect(body?.response).toBe('{"ok":1}');
  });

  it('幂等：无剩余时返回 0', () => {
    expect(migrateLegacyBodies(2)).toBe(0);
  });

  it('finishBodyMigration 删除 body 列并置门控', () => {
    finishBodyMigration();
    const cols = queryAll("SELECT name FROM pragma_table_info('calls') WHERE name IN ('request_body', 'response_body')");
    expect(cols).toHaveLength(0);
    const g = queryAll("SELECT value FROM metadata WHERE key = 'bodies_migrated'")[0];
    expect(g.value).toBe('1');
  });

  it('finishBodyMigration 后 insertCall 正常（列已删除，recorder 路径写 body 文件可读回）', () => {
    const now = Date.now();
    const newId = insertCall({
      provider: 'openai', model: 'gpt-4o', tool: 'codex', endpoint: '/v1/x', method: 'POST',
      target_url: null, downstream_url: null, source_ip: null, status_code: 200, error_message: null,
      duration_ms: 10, prompt_tokens: 1, output_tokens: 1, cache_read_tokens: null, cache_write_tokens: null,
      uncached_input: null, input_cost: 0, output_cost: 0, total_cost: 0, cache_savings: 0,
      request_body: null, response_body: null, fingerprint: 'fp_bm_after', source_port: null, session_id: 1, created_at: now,
    });
    expect(newId).toBeGreaterThan(4);   // 迁移前已插入 4 行，新行 id 递增
    // 与 recorder.ts 一致：DB 落库后 body 外置写文件，详情接口 readBody 读回
    writeBody(1, newId, now, '{"m":"new"}', '{"ok":1}');
    const body = readBody(1, newId, now);
    expect(body?.request).toBe('{"m":"new"}');
    expect(body?.response).toBe('{"ok":1}');
  });
});
