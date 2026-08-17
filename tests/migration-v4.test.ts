/** v4 迁移测试 — 构造 v3 老库（含 daily_stats 与历史 calls），initDb 后验证升级结果 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import initSqlJs from 'sql.js';
import { writeFileSync } from 'node:fs';
import { initDb, closeDb, queryAll, insertCall, upsertHourlyStat } from '../proxy/db.js';
import { createTempDb } from './setup.js';

const tmp = createTempDb();

async function buildV3Db(): Promise<void> {
  const SQL = await initSqlJs();
  const d = new SQL.Database();
  d.run(`CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT)`);
  d.run(`CREATE TABLE sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, tool TEXT NOT NULL, label TEXT, fingerprint TEXT NOT NULL UNIQUE, request_count INTEGER NOT NULL DEFAULT 0, total_cost REAL NOT NULL DEFAULT 0, total_tokens INTEGER NOT NULL DEFAULT 0, first_call_at INTEGER, last_call_at INTEGER, first_endpoint TEXT, status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL, upstream_provider TEXT, upstream_model TEXT)`);
  d.run(`CREATE TABLE calls (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id INTEGER NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, endpoint TEXT NOT NULL, method TEXT NOT NULL, status_code INTEGER, error_message TEXT, duration_ms INTEGER NOT NULL, prompt_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER, uncached_input INTEGER, input_cost REAL DEFAULT 0.0, output_cost REAL DEFAULT 0.0, total_cost REAL DEFAULT 0.0, cache_savings REAL DEFAULT 0.0, request_body TEXT, response_body TEXT, fingerprint TEXT NOT NULL, source_port INTEGER, tool TEXT, created_at INTEGER NOT NULL)`);
  d.run(`CREATE TABLE daily_stats (date TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, tool TEXT NOT NULL, call_count INTEGER NOT NULL DEFAULT 0, total_cost REAL NOT NULL DEFAULT 0, prompt_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, uncached_input INTEGER NOT NULL DEFAULT 0, cache_read_tokens INTEGER NOT NULL DEFAULT 0, created_at_ms INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (date, provider, model, tool))`);
  d.run(`INSERT INTO sessions (tool, fingerprint, status, created_at) VALUES ('codex', 'fp_v4_1', 'active', 1)`);
  d.run(`INSERT INTO calls (session_id, provider, model, endpoint, method, status_code, duration_ms, prompt_tokens, output_tokens, total_cost, request_body, response_body, fingerprint, tool, created_at)
         VALUES (1, 'openai', 'gpt-4o', '/v1/x', 'POST', 200, 10, 100, 50, 0.05, '{"m":"a"}', '{"ok":1}', 'fp_v4_1', NULL, 1786600800000)`);
  d.run(`INSERT INTO calls (session_id, provider, model, endpoint, method, status_code, duration_ms, prompt_tokens, output_tokens, total_cost, request_body, response_body, fingerprint, tool, created_at)
         VALUES (1, 'openai', 'gpt-4o-mini', '/v1/x', 'POST', 200, 10, 20, 10, 0.01, NULL, NULL, 'fp_v4_2', NULL, 1786600801000)`);
  d.run(`INSERT INTO daily_stats (date, provider, model, tool, call_count, total_cost, created_at_ms) VALUES ('2026-08-12', 'openai', 'gpt-4o', 'codex', 1, 0.05, 1786600800000)`);
  d.run("INSERT INTO metadata (key, value) VALUES ('schema_version', '3')");
  writeFileSync(tmp.dbPath, Buffer.from(d.export()));
  d.close();
}

beforeAll(async () => {
  await buildV3Db();
  await initDb(tmp.dbPath);
});
afterAll(() => { closeDb(); tmp.cleanup(); });

describe('v4 迁移', () => {
  it('schema_version 升到 4，daily_stats 表被删除', () => {
    const v = queryAll("SELECT value FROM metadata WHERE key = 'schema_version'")[0];
    expect(v.value).toBe('4');
    const tables = queryAll("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'daily_stats'");
    expect(tables).toHaveLength(0);
  });

  it('hourly_stats 从 calls 回填（同小时两模型两行，聚合正确）', () => {
    const rows = queryAll("SELECT * FROM hourly_stats WHERE hour_ms = 1786600800000");
    expect(rows).toHaveLength(2);
    const gpt4 = rows.find((r: any) => r.model === 'gpt-4o')!;
    expect(gpt4.call_count).toBe(1);
    expect(gpt4.created_at).toBe(1786600800000);
    expect(gpt4.updated_at).toBe(1786600800000);
  });

  it('calls.tool 历史 NULL 已从 sessions 回填', () => {
    const rows = queryAll("SELECT DISTINCT tool FROM calls WHERE fingerprint IN ('fp_v4_1', 'fp_v4_2')");
    expect(rows).toHaveLength(1);
    expect(rows[0].tool).toBe('codex');
  });

  it('v4 后旧名称迁移函数门控已置位', () => {
    const g = queryAll("SELECT value FROM metadata WHERE key = 'lowercase_migrated'")[0];
    expect(g.value).toBe('1');
  });

  it('calls/sessions 索引齐全（老库升级路径不被迁移重建丢失）', () => {
    const callsNames = queryAll("SELECT name FROM pragma_index_list('calls')").map((r: any) => r.name);
    for (const idx of ['idx_calls_session', 'idx_calls_created', 'idx_calls_model', 'idx_calls_fingerprint', 'idx_calls_tool']) {
      expect(callsNames).toContain(idx);
    }
    const sessionsNames = queryAll("SELECT name FROM pragma_index_list('sessions')").map((r: any) => r.name);
    expect(sessionsNames).toContain('idx_sessions_tool');
    expect(sessionsNames).toContain('idx_sessions_status');
  });

  it('v4 升级后 insertCall 与 upsertHourlyStat 正常执行（迁移完成后继续写入）', () => {
    const newId = insertCall({
      provider: 'openai', model: 'gpt-4o', tool: 'codex', endpoint: '/v1/x', method: 'POST',
      target_url: null, downstream_url: null, source_ip: null, status_code: 200, error_message: null,
      duration_ms: 10, prompt_tokens: 1, output_tokens: 1, cache_read_tokens: null, cache_write_tokens: null,
      uncached_input: null, input_cost: 0, output_cost: 0, total_cost: 0, cache_savings: 0,
      request_body: null, response_body: null, fingerprint: 'fp_v4_new', source_port: null, session_id: 1, created_at: Date.now(),
    });
    expect(newId).toBeGreaterThan(2);   // 老库已有 2 行，新行 id 递增
    // upsertHourlyStat 正常累加（写入端零时区，hour_ms 由 createdAtMs 整数运算得出）
    upsertHourlyStat('openai', 'gpt-4o', 'codex', 0.05, 1, 50, 80, 20);
    upsertHourlyStat('openai', 'gpt-4o', 'codex', 0.05, 1, 50, 80, 20);
    const hourMs = Math.floor(Date.now() / 3600000) * 3600000;
    const rows = queryAll('SELECT call_count, total_cost FROM hourly_stats WHERE hour_ms = ? AND provider = ? AND model = ? AND tool = ?',
      [hourMs, 'openai', 'gpt-4o', 'codex']);
    expect(rows).toHaveLength(1);
    expect(rows[0].call_count).toBe(2);
    expect(rows[0].total_cost).toBeCloseTo(0.1);
  });
});
