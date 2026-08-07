/**
 * SQLite 数据库模块 — 基于 sql.js (纯 WASM，无需编译)
 *
 * sql.js 的数据库完全在内存中运行，写入后需调用 saveDb() 持久化到磁盘。
 * 采用单例模式，所有模块共享同一个数据库实例。
 */
import initSqlJs from 'sql.js';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { ensureDataDir, DB_PATH } from './config.js';
// ── 模块级状态 ──
let SQL = null;
let db = null;
// ── 初始化 ──
/** 初始化 sql.js + 数据库，建表。调用一次即可。 */
export async function initDb(dbPath) {
    if (SQL && db)
        return;
    ensureDataDir();
    const path = dbPath ?? DB_PATH;
    SQL = await initSqlJs();
    // 如果文件已存在，从磁盘加载；否则创建空库
    if (existsSync(path)) {
        const buffer = readFileSync(path);
        db = new SQL.Database(buffer);
    }
    else {
        db = new SQL.Database();
    }
    db.run('PRAGMA journal_mode = WAL;');
    db.run(`
    CREATE TABLE IF NOT EXISTS calls (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id      INTEGER NOT NULL REFERENCES sessions(id),
      provider        TEXT    NOT NULL,
      model           TEXT    NOT NULL,
      endpoint        TEXT    NOT NULL,
      method          TEXT    NOT NULL,
      status_code     INTEGER,
      error_message   TEXT,
      duration_ms     INTEGER NOT NULL,
      prompt_tokens       INTEGER,
      output_tokens       INTEGER,
      cache_read_tokens   INTEGER,
      cache_write_tokens  INTEGER,
      uncached_input      INTEGER,
      input_cost    REAL DEFAULT 0.0,
      output_cost   REAL DEFAULT 0.0,
      total_cost    REAL DEFAULT 0.0,
      cache_savings REAL DEFAULT 0.0,
      request_body   TEXT,
      response_body  TEXT,
      fingerprint  TEXT NOT NULL,
      source_port  INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
    db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      tool          TEXT    NOT NULL,
      label         TEXT,
      fingerprint   TEXT    NOT NULL UNIQUE,
      request_count INTEGER NOT NULL DEFAULT 0,
      total_cost    REAL    NOT NULL DEFAULT 0,
      total_tokens  INTEGER NOT NULL DEFAULT 0,
      first_call_at TEXT,
      last_call_at  TEXT,
      first_endpoint TEXT,
      status        TEXT    NOT NULL DEFAULT 'active',
      created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
    )
  `);
    db.run(`
    CREATE TABLE IF NOT EXISTS pricing (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      provider          TEXT    NOT NULL,
      model             TEXT    NOT NULL,
      input_price       REAL    NOT NULL,
      cache_input_price REAL    NOT NULL,
      output_price      REAL    NOT NULL,
      unit              TEXT    NOT NULL DEFAULT 'per_1M_tokens',
      currency          TEXT    NOT NULL DEFAULT 'USD',
      effective_from    TEXT,
      UNIQUE(provider, model, effective_from)
    )
  `);
    db.run(`
    CREATE TABLE IF NOT EXISTS metadata (
      key   TEXT PRIMARY KEY,
      value TEXT
    )
  `);
    db.run(`
    CREATE TABLE IF NOT EXISTS provider_config (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT    NOT NULL UNIQUE,
      base_url TEXT    NOT NULL DEFAULT '',
      api_key  TEXT    NOT NULL DEFAULT '',
      enabled  INTEGER NOT NULL DEFAULT 1
    )
  `);
    // 初始化四个 provider 的默认配置（空 base_url = 使用官方地址）
    const providers = ['anthropic', 'openai', 'deepseek', 'qwen'];
    for (const p of providers) {
        db.run('INSERT OR IGNORE INTO provider_config (provider, base_url, api_key, enabled) VALUES (?, ?, ?, 1)', [p, '', '']);
    }
    // 索引
    const indexes = [
        'CREATE INDEX IF NOT EXISTS idx_calls_session ON calls(session_id)',
        'CREATE INDEX IF NOT EXISTS idx_calls_created ON calls(created_at)',
        'CREATE INDEX IF NOT EXISTS idx_calls_model ON calls(model)',
        'CREATE INDEX IF NOT EXISTS idx_calls_fingerprint ON calls(fingerprint)',
        'CREATE INDEX IF NOT EXISTS idx_sessions_tool ON sessions(tool)',
        'CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status)',
    ];
    for (const idx of indexes) {
        db.run(idx);
    }
    saveDb();
}
/** 获取数据库实例（必须先在 initDb 之后调用） */
export function getDb() {
    if (!db)
        throw new Error('数据库未初始化，请先调用 initDb()');
    return db;
}
/** 将内存中的数据库持久化到磁盘 */
export function saveDb(dbPath) {
    if (!db)
        return;
    const path = dbPath ?? DB_PATH;
    const data = db.export();
    const buffer = Buffer.from(data);
    writeFileSync(path, buffer);
}
/** 关闭数据库（先保存） */
export function closeDb() {
    if (db) {
        saveDb();
        db.close();
        db = null;
    }
}
// ── 辅助 ──
/** 将 sql.js 的 Statement 结果行转为对象 */
function rowToDict(columns, row) {
    const obj = {};
    for (let i = 0; i < columns.length; i++) {
        obj[columns[i]] = row[i];
    }
    return obj;
}
/** 执行 SELECT 查询，返回对象数组 */
function queryAll(sql, params) {
    const d = getDb();
    const stmt = d.prepare(sql);
    if (params)
        stmt.bind(params);
    const results = [];
    while (stmt.step()) {
        const row = stmt.getAsObject();
        results.push(row);
    }
    stmt.free();
    return results;
}
/** 执行 SELECT 查询，返回第一行 */
function queryOne(sql, params) {
    const d = getDb();
    const stmt = d.prepare(sql);
    if (params)
        stmt.bind(params);
    let result = null;
    if (stmt.step()) {
        result = stmt.getAsObject();
    }
    stmt.free();
    return result;
}
/** 执行 INSERT 并返回新行的 id（使用 RETURNING 子句） */
function executeInsert(sql, params) {
    const d = getDb();
    const stmt = d.prepare(sql);
    if (params)
        stmt.bind(params);
    if (stmt.step()) {
        const vals = stmt.get();
        stmt.free();
        saveDb();
        return vals && vals.length > 0 ? Number(vals[0]) : 0;
    }
    stmt.free();
    saveDb();
    return 0;
}
/** 执行 UPDATE/DELETE，返回影响行数 */
function execute(sql, params) {
    const d = getDb();
    d.run(sql, params);
    saveDb();
    return d.getRowsModified();
}
// ── Calls CRUD ──
/** 插入调用记录，返回新 id */
export function insertCall(r) {
    return executeInsert(`INSERT INTO calls (session_id, provider, model, endpoint, method,
      status_code, error_message, duration_ms, prompt_tokens, output_tokens,
      cache_read_tokens, cache_write_tokens, uncached_input, input_cost,
      output_cost, total_cost, cache_savings, request_body, response_body,
      fingerprint, source_port)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`, [
        r.session_id, r.provider, r.model, r.endpoint, r.method,
        r.status_code, r.error_message, r.duration_ms, r.prompt_tokens, r.output_tokens,
        r.cache_read_tokens, r.cache_write_tokens, r.uncached_input, r.input_cost,
        r.output_cost, r.total_cost, r.cache_savings, r.request_body, r.response_body,
        r.fingerprint, r.source_port,
    ]);
}
/** 列出调用记录 */
export function listCalls(sessionId, limit = 50, offset = 0) {
    if (sessionId != null) {
        return queryAll('SELECT * FROM calls WHERE session_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?', [sessionId, limit, offset]);
    }
    return queryAll('SELECT * FROM calls ORDER BY created_at DESC LIMIT ? OFFSET ?', [limit, offset]);
}
/** 获取单条调用 */
export function getCall(callId) {
    return queryOne('SELECT * FROM calls WHERE id = ?', [callId]);
}
// ── Sessions CRUD ──
/** 查找或创建会话，返回 session id */
export function upsertSession(fingerprint, tool, endpoint) {
    const existing = queryOne('SELECT id FROM sessions WHERE fingerprint = ?', [fingerprint]);
    if (existing) {
        execute("UPDATE sessions SET status = 'active', last_call_at = datetime('now') WHERE id = ?", [existing.id]);
        return Number(existing.id);
    }
    return executeInsert(`INSERT INTO sessions (tool, fingerprint, status, first_call_at, last_call_at, first_endpoint)
     VALUES (?, ?, 'active', datetime('now'), datetime('now'), ?) RETURNING id`, [tool, fingerprint, endpoint]);
}
/** 更新会话统计 */
export function updateSessionStats(sessionId, cost, tokens) {
    execute(`UPDATE sessions SET request_count = request_count + 1,
     total_cost = total_cost + ?, total_tokens = total_tokens + ?,
     last_call_at = datetime('now') WHERE id = ?`, [cost, tokens, sessionId]);
}
/** 列出会话 */
export function listSessions(tool, status, limit = 100) {
    let sql = 'SELECT * FROM sessions WHERE 1=1';
    const params = [];
    if (tool) {
        sql += ' AND tool = ?';
        params.push(tool);
    }
    if (status) {
        sql += ' AND status = ?';
        params.push(status);
    }
    sql += ' ORDER BY last_call_at DESC LIMIT ?';
    params.push(limit);
    return queryAll(sql, params);
}
/** 获取单条会话 */
export function getSession(sessionId) {
    return queryOne('SELECT * FROM sessions WHERE id = ?', [sessionId]);
}
/** 重命名会话 */
export function updateSessionLabel(sessionId, label) {
    execute('UPDATE sessions SET label = ? WHERE id = ?', [label, sessionId]);
}
/** 合并两个会话 */
export function mergeSessions(sourceId, targetId) {
    const d = getDb();
    d.run('UPDATE calls SET session_id = ? WHERE session_id = ?', [targetId, sourceId]);
    // 重新计算 target 统计
    const row = queryOne('SELECT COUNT(*) as cnt, SUM(total_cost) as cost, SUM(prompt_tokens + output_tokens) as tokens FROM calls WHERE session_id = ?', [targetId]);
    d.run('UPDATE sessions SET request_count = ?, total_cost = ?, total_tokens = ? WHERE id = ?', [row?.cnt || 0, row?.cost || 0, row?.tokens || 0, targetId]);
    d.run('DELETE FROM sessions WHERE id = ?', [sourceId]);
    saveDb();
}
// ── Stats ──
/** 聚合统计 */
export function getStats(groupBy) {
    if (groupBy === 'tool') {
        return queryAll(`SELECT s.tool as key, COUNT(*) as count, SUM(c.total_cost) as total_cost,
       SUM(c.prompt_tokens + c.output_tokens) as total_tokens
       FROM calls c JOIN sessions s ON c.session_id = s.id
       GROUP BY s.tool ORDER BY total_cost DESC`);
    }
    const validCols = { provider: 'provider', model: 'model' };
    const col = validCols[groupBy] || 'provider';
    return queryAll(`SELECT ${col} as key, COUNT(*) as count, SUM(total_cost) as total_cost,
     SUM(prompt_tokens + output_tokens) as total_tokens
     FROM calls GROUP BY ${col} ORDER BY total_cost DESC`);
}
// ── Data Management ──
/** 清理旧数据 */
export function cleanupOldCalls(days) {
    const d = getDb();
    d.run("DELETE FROM calls WHERE created_at < datetime('now', ?)", [`-${days} days`]);
    const modified = d.getRowsModified();
    saveDb();
    return modified;
}
/** 清空所有调用和会话 */
export function clearAllCalls() {
    const d = getDb();
    d.run('DELETE FROM calls');
    d.run('DELETE FROM sessions');
    saveDb();
}
// ── Pricing CRUD ──
/** 列出定价 */
export function listPricing() {
    return queryAll('SELECT * FROM pricing ORDER BY provider, model');
}
/** 新增或更新定价 */
export function upsertPricing(provider, model, inputPrice, cacheInputPrice, outputPrice) {
    // sql.js 不支持 ON CONFLICT，用先查再插入/更新的方式
    const existing = queryOne('SELECT id FROM pricing WHERE provider = ? AND model = ? AND effective_from IS NULL', [provider, model]);
    if (existing) {
        execute('UPDATE pricing SET input_price = ?, cache_input_price = ?, output_price = ? WHERE id = ?', [inputPrice, cacheInputPrice, outputPrice, existing.id]);
        return Number(existing.id);
    }
    return executeInsert('INSERT INTO pricing (provider, model, input_price, cache_input_price, output_price) VALUES (?, ?, ?, ?, ?) RETURNING id', [provider, model, inputPrice, cacheInputPrice, outputPrice]);
}
/** 删除定价 */
export function deletePricing(pricingId) {
    execute('DELETE FROM pricing WHERE id = ?', [pricingId]);
}
// ── Provider Config CRUD ──
const OFFICIAL_URLS = {
    anthropic: 'https://api.anthropic.com',
    openai: 'https://api.openai.com',
    deepseek: 'https://api.deepseek.com',
    qwen: 'https://dashscope.aliyuncs.com',
};
/** 列出所有 provider 配置 */
export function listProviderConfigs() {
    return queryAll('SELECT * FROM provider_config ORDER BY provider');
}
/** 获取单个 provider 的配置（base_url 为空时返回官方地址） */
export function getProviderConfig(provider) {
    const row = queryOne('SELECT * FROM provider_config WHERE provider = ?', [provider]);
    if (!row)
        return null;
    return {
        base_url: row.base_url || OFFICIAL_URLS[provider] || '',
        api_key: row.api_key || '',
        enabled: row.enabled === 1,
    };
}
/** 更新 provider 配置 */
export function updateProviderConfig(provider, baseUrl, apiKey, enabled) {
    execute('UPDATE provider_config SET base_url = ?, api_key = ?, enabled = ? WHERE provider = ?', [baseUrl, apiKey, enabled ? 1 : 0, provider]);
}
/** 新增自定义 provider */
export function addProviderConfig(provider, baseUrl, apiKey) {
    return executeInsert('INSERT INTO provider_config (provider, base_url, api_key, enabled) VALUES (?, ?, ?, 1) RETURNING id', [provider, baseUrl, apiKey]);
}
/** 删除 provider 配置 */
export function deleteProviderConfig(provider) {
    execute('DELETE FROM provider_config WHERE provider = ?', [provider]);
}
//# sourceMappingURL=db.js.map