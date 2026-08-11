/**
 * SQLite 数据库模块 — 基于 sql.js (纯 WASM，无需编译)
 *
 * sql.js 的数据库完全在内存中运行，写入后需调用 saveDb() 持久化到磁盘。
 * 采用单例模式，所有模块共享同一个数据库实例。
 */

import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js';
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { ensureDataDir, DB_PATH } from './config.js';
import type { CallRecord } from '../shared/types.js';

// ── 模块级状态 ──

let SQL: SqlJsStatic | null = null;
let db: Database | null = null;
let currentDbPath: string = DB_PATH;

// ── 初始化 ──

/** 初始化 sql.js + 数据库，建表。调用一次即可。 */
export async function initDb(dbPath?: string): Promise<void> {
  if (SQL && db) return;

  ensureDataDir();
  const path = dbPath ?? DB_PATH;
  currentDbPath = path; // 记录当前数据库路径，供后续 saveDb() 使用

  SQL = await initSqlJs();

  // 如果文件已存在，从磁盘加载；否则创建空库
  if (existsSync(path)) {
    const buffer = readFileSync(path);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

  db.run('PRAGMA journal_mode = WAL;');

  // 创建 metadata 表（最先，用于 schema 版本检查）
  db.run(`CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT)`);

  // 仅在 schema 版本变更时重建表
  const currentVersion = 2;
  const storedVersion = (() => {
    try {
      const r = db.exec("SELECT value FROM metadata WHERE key = 'schema_version'");
      if (r.length > 0 && r[0].values.length > 0) return parseInt(r[0].values[0][0] as string);
    } catch {}
    return 1; // 无版本号视为 v1（旧 TEXT 时间格式）
  })();

  if (storedVersion < currentVersion) {
    // 迁移前备份：复制数据库文件以防数据丢失
    const backupPath = path.replace(/\.db$/, `.v${storedVersion}-backup.db`);
    try {
      if (existsSync(path)) {
        saveDb();
        copyFileSync(path, backupPath);
        console.log(`数据库升级前已备份到: ${backupPath}`);
      }
    } catch (e) {
      console.warn('数据库备份失败，仍将执行迁移:', e);
    }
    db.run('DROP TABLE IF EXISTS calls');
    db.run('DROP TABLE IF EXISTS sessions');
    db.run("INSERT OR REPLACE INTO metadata (key, value) VALUES ('schema_version', ?)", [String(currentVersion)]);
    console.log(`数据库已升级到 schema v${currentVersion}（时间戳格式），旧数据已备份`);
  }

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
      created_at INTEGER NOT NULL
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
      first_call_at INTEGER,
      last_call_at  INTEGER,
      first_endpoint TEXT,
      status        TEXT    NOT NULL DEFAULT 'active',
      created_at    INTEGER NOT NULL,
      upstream_provider TEXT
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
      currency          TEXT    NOT NULL DEFAULT 'CNY',
      effective_from    TEXT,
      UNIQUE(provider, model, effective_from)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS provider_config (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      provider   TEXT    NOT NULL UNIQUE,
      base_url   TEXT    NOT NULL DEFAULT '',
      base_url_anthropic TEXT NOT NULL DEFAULT '',
      api_key    TEXT    NOT NULL DEFAULT '',
      api_format TEXT    NOT NULL DEFAULT '',
      enabled    INTEGER NOT NULL DEFAULT 1
    )
  `);

  // 初始化四个 provider 的默认配置
  const defaults: [string, string][] = [
    ['Anthropic', 'anthropic'], ['OpenAI', 'openai'],
  ];
  for (const [p, fmt] of defaults) {
    db.run('INSERT OR IGNORE INTO provider_config (provider, base_url, api_key, api_format, enabled) VALUES (?, ?, ?, ?, 1)', [p, '', '', fmt]);
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

  // 兼容已有库：添加 upstream_provider 列（列已存在则忽略错误）
  try { db.run(`ALTER TABLE sessions ADD COLUMN upstream_provider TEXT`); } catch {}
  try { db.run(`ALTER TABLE sessions ADD COLUMN upstream_model TEXT`); } catch {}
  // 兼容已有库：添加 base_url_anthropic 列
  try { db.run(`ALTER TABLE provider_config ADD COLUMN base_url_anthropic TEXT`); } catch {}
  // 兼容已有库：添加 is_default 列
  try { db.run(`ALTER TABLE pricing ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0`); } catch {}
  // 兼容已有库：添加 target_url、source_ip 列
  try { db.run(`ALTER TABLE calls ADD COLUMN target_url TEXT`); } catch {}
  try { db.run(`ALTER TABLE calls ADD COLUMN source_ip TEXT`); } catch {}
  try { db.run(`ALTER TABLE calls ADD COLUMN downstream_url TEXT`); } catch {}

  saveDb();
}

/** 获取数据库实例（必须先在 initDb 之后调用） */
export function getDb(): Database {
  if (!db) throw new Error('数据库未初始化，请先调用 initDb()');
  return db;
}

/** 将内存中的数据库持久化到磁盘 */
export function saveDb(dbPath?: string): void {
  if (!db) return;
  const path = dbPath ?? currentDbPath;
  const data = db.export();
  const buffer = Buffer.from(data);
  writeFileSync(path, buffer);
}

/** 关闭数据库（先保存） */
export function closeDb(): void {
  if (db) {
    saveDb();
    db.close();
    db = null;
  }
  SQL = null;
  currentDbPath = DB_PATH;
}

// ── 辅助 ──

/** 将 sql.js 的 Statement 结果行转为对象 */
function rowToDict(columns: string[], row: any[]): Record<string, any> {
  const obj: Record<string, any> = {};
  for (let i = 0; i < columns.length; i++) {
    obj[columns[i]] = row[i];
  }
  return obj;
}

/** 执行 SELECT 查询，返回对象数组 */
function queryAll(sql: string, params?: any[]): Record<string, any>[] {
  const d = getDb();
  const stmt = d.prepare(sql);
  if (params) stmt.bind(params);
  const results: Record<string, any>[] = [];
  while (stmt.step()) {
    const row = stmt.getAsObject();
    results.push(row);
  }
  stmt.free();
  return results;
}

/** 执行 SELECT 查询，返回第一行 */
function queryOne(sql: string, params?: any[]): Record<string, any> | null {
  const d = getDb();
  const stmt = d.prepare(sql);
  if (params) stmt.bind(params);
  let result: Record<string, any> | null = null;
  if (stmt.step()) {
    result = stmt.getAsObject();
  }
  stmt.free();
  return result;
}

/** 执行 INSERT 并返回新行的 id（使用 RETURNING 子句） */
function executeInsert(sql: string, params?: any[]): number {
  const d = getDb();
  const stmt = d.prepare(sql);
  if (params) stmt.bind(params);
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
function execute(sql: string, params?: any[]): number {
  const d = getDb();
  d.run(sql, params);
  saveDb();
  return d.getRowsModified();
}

// ── Calls CRUD ──

/** 插入调用记录，返回新 id */
export function insertCall(r: CallRecord): number {
  return executeInsert(
    `INSERT INTO calls (session_id, provider, model, endpoint, method,
      target_url, downstream_url, source_ip,
      status_code, error_message, duration_ms, prompt_tokens, output_tokens,
      cache_read_tokens, cache_write_tokens, uncached_input, input_cost,
      output_cost, total_cost, cache_savings, request_body, response_body,
      fingerprint, source_port, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    [
      r.session_id, r.provider, r.model, r.endpoint, r.method,
      r.target_url, r.downstream_url, r.source_ip,
      r.status_code, r.error_message, r.duration_ms, r.prompt_tokens, r.output_tokens,
      r.cache_read_tokens, r.cache_write_tokens, r.uncached_input, r.input_cost,
      r.output_cost, r.total_cost, r.cache_savings, r.request_body, r.response_body,
      r.fingerprint, r.source_port, Date.now(),
    ],
  );
}

/** 列出调用记录 */
export function listCalls(sessionId?: number, provider?: string, tool?: string, limit = 50, offset = 0): Record<string, any>[] {
  let sql = 'SELECT c.* FROM calls c';
  const joins: string[] = [];
  const conditions: string[] = [];
  const params: any[] = [];

  if (tool) {
    joins.push('JOIN sessions s ON c.session_id = s.id');
    conditions.push('s.tool = ?');
    params.push(tool);
  }
  if (sessionId != null) { conditions.push('c.session_id = ?'); params.push(sessionId); }
  if (provider) { conditions.push('c.provider = ?'); params.push(provider); }

  if (conditions.length > 0) sql += ' WHERE ' + conditions.join(' AND ');
  sql += ' ORDER BY c.created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);
  return queryAll(sql, params);
}

/** 获取单条调用 */
export function getCall(callId: number): Record<string, any> | null {
  return queryOne('SELECT * FROM calls WHERE id = ?', [callId]);
}

// ── Sessions CRUD ──

/**
 * 查找或创建会话，返回 session id。
 * 支持 pending→active 自动升级：
 * 1. 用 fullFp 精确匹配 → 命中则复用
 * 2. 查找同 tool 的 pending 会话 → 命中则「升级」为完整指纹
 * 3. 都不命中 → 新建会话
 * 会话不会自动过期。 */
export function upsertSession(fullFp: string, tool: string, endpoint: string): number {
  const now = Date.now();

  // 1. 完整指纹精确匹配
  const fullMatch = queryOne(
    'SELECT id FROM sessions WHERE fingerprint = ? ORDER BY last_call_at DESC LIMIT 1',
    [fullFp],
  );
  if (fullMatch) {
    execute(
      "UPDATE sessions SET status = 'active', last_call_at = ? WHERE id = ?",
      [now, fullMatch.id],
    );
    return Number(fullMatch.id);
  }

  // 2. 查找同工具最近的 pending 会话 → 升级
  const pending = queryOne(
    "SELECT id FROM sessions WHERE tool = ? AND status = 'pending' ORDER BY last_call_at DESC LIMIT 1",
    [tool],
  );
  if (pending) {
    execute(
      "UPDATE sessions SET fingerprint = ?, status = 'active', last_call_at = ?, first_endpoint = ? WHERE id = ?",
      [fullFp, now, endpoint, pending.id],
    );
    return Number(pending.id);
  }

  // 3. 新建会话
  return executeInsert(
    `INSERT INTO sessions (tool, fingerprint, status, first_call_at, last_call_at, first_endpoint, created_at)
     VALUES (?, ?, 'active', ?, ?, ?, ?) RETURNING id`,
    [tool, fullFp, now, now, endpoint, now],
  );
}

/** 创建 pending 会话（由包装脚本在 CLI 启动时调用） */
export function createPendingSession(tool: string): number {
  const now = Date.now();
  const fp = `pending:${tool}:${now}`;
  return executeInsert(
    `INSERT INTO sessions (tool, fingerprint, status, first_call_at, last_call_at, first_endpoint, created_at)
     VALUES (?, ?, 'pending', ?, ?, '/_startup_', ?) RETURNING id`,
    [tool, fp, now, now, now],
  );
}

/** 更新会话统计 */
export function updateSessionStats(sessionId: number, cost: number, tokens: number): void {
  execute(
    `UPDATE sessions SET request_count = request_count + 1,
     total_cost = total_cost + ?, total_tokens = total_tokens + ?,
     last_call_at = ? WHERE id = ?`,
    [cost, tokens, Date.now(), sessionId],
  );
}

/** 列出会话 */
export function listSessions(tool?: string, status?: string, limit = 100): Record<string, any>[] {
  let sql = 'SELECT * FROM sessions WHERE 1=1';
  const params: any[] = [];
  if (tool) { sql += ' AND tool = ?'; params.push(tool); }
  if (status) { sql += ' AND status = ?'; params.push(status); }
  sql += ' ORDER BY last_call_at DESC LIMIT ?';
  params.push(limit);
  return queryAll(sql, params);
}

/** 获取单条会话 */
export function getSession(sessionId: number): Record<string, any> | null {
  return queryOne('SELECT * FROM sessions WHERE id = ?', [sessionId]);
}

/** 重命名会话 */
export function updateSessionLabel(sessionId: number, label: string): void {
  execute('UPDATE sessions SET label = ? WHERE id = ?', [label, sessionId]);
}

/** 合并两个会话 */
export function mergeSessions(sourceId: number, targetId: number): void {
  const d = getDb();
  d.run('UPDATE calls SET session_id = ? WHERE session_id = ?', [targetId, sourceId]);
  // 重新计算 target 统计
  const row = queryOne(
    'SELECT COUNT(*) as cnt, SUM(total_cost) as cost, SUM(prompt_tokens + output_tokens) as tokens FROM calls WHERE session_id = ?',
    [targetId],
  );
  d.run('UPDATE sessions SET request_count = ?, total_cost = ?, total_tokens = ? WHERE id = ?',
    [row?.cnt || 0, row?.cost || 0, row?.tokens || 0, targetId],
  );
  d.run('DELETE FROM sessions WHERE id = ?', [sourceId]);
  saveDb();
}

/** 设置会话的上游覆盖 */
export function updateSessionUpstream(sessionId: number, upstreamProvider: string | null): void {
  execute('UPDATE sessions SET upstream_provider = ? WHERE id = ?', [upstreamProvider, sessionId]);
}

export function updateSessionModel(sessionId: number, model: string | null): void {
  execute('UPDATE sessions SET upstream_model = ? WHERE id = ?', [model, sessionId]);
}

/** 删除会话及其所有关联调用 */
export function deleteSession(sessionId: number): void {
  execute('DELETE FROM calls WHERE session_id = ?', [sessionId]);
  execute('DELETE FROM sessions WHERE id = ?', [sessionId]);
}

// ── Stats ──

/** 格式化模型显示名：去日期后缀 + 版本号用点分隔（如 -4-6 → -4.6） */
function formatModelName(model: string): string {
  return model
    .replace(/-\d{8}$/, '')
    .replace(/-(\d+)-(\d+)$/, '-$1.$2');
}

/** 聚合统计 */
export function getStats(groupBy: string, provider?: string, tool?: string): Record<string, any>[] {
  const aggs = `COUNT(*) as count,
     SUM(total_cost) as total_cost,
     SUM(prompt_tokens) as total_input_tokens,
     SUM(output_tokens) as total_output_tokens,
     SUM(cache_read_tokens) as total_cache_read_tokens`;

  // 带 c. 前缀的版本，用于 JOIN 场景
  const aggsC = `COUNT(*) as count,
     SUM(c.total_cost) as total_cost,
     SUM(c.prompt_tokens) as total_input_tokens,
     SUM(c.output_tokens) as total_output_tokens,
     SUM(c.cache_read_tokens) as total_cache_read_tokens`;

  if (groupBy === 'tool') {
    let sql = `SELECT s.tool as key, ${aggsC}
       FROM calls c JOIN sessions s ON c.session_id = s.id`;
    const conditions: string[] = [];
    const params: any[] = [];
    if (provider) { conditions.push('c.provider = ?'); params.push(provider); }
    if (tool) { conditions.push('s.tool = ?'); params.push(tool); }
    if (conditions.length > 0) sql += ' WHERE ' + conditions.join(' AND ');
    sql += ' GROUP BY s.tool ORDER BY total_cost DESC';
    return queryAll(sql, params);
  }
  const validCols: Record<string, string> = { provider: 'provider', model: 'model' };
  const col = validCols[groupBy] || 'provider';
  let sql = `SELECT ${col} as key, ${aggs}
     FROM calls`;
  const conditions: string[] = [];
  const params: any[] = [];
  if (provider) { conditions.push('provider = ?'); params.push(provider); }
  if (tool) {
    sql = `SELECT c.${col} as key, ${aggsC}
     FROM calls c JOIN sessions s ON c.session_id = s.id`;
    conditions.push('s.tool = ?');
    params.push(tool);
  }
  if (conditions.length > 0) sql += ' WHERE ' + conditions.join(' AND ');
  sql += ` GROUP BY ${col} ORDER BY total_cost DESC`;
  const results = queryAll(sql, params);
  // 按模型分组时，去除日期后缀合并统计
  if (col === 'model') {
    const merged = new Map<string, Record<string, any>>();
    for (const row of results) {
      const stripped = formatModelName(row.key);
      if (merged.has(stripped)) {
        const m = merged.get(stripped)!;
        m.count += row.count;
        m.total_cost += row.total_cost;
        m.total_input_tokens += row.total_input_tokens;
        m.total_output_tokens += row.total_output_tokens;
        m.total_cache_read_tokens += row.total_cache_read_tokens;
      } else {
        merged.set(stripped, { ...row, key: stripped });
      }
    }
    return [...merged.values()].sort((a, b) => b.total_cost - a.total_cost);
  }
  return results;
}

// ── Data Management ──

/** 清理旧数据（days 天前的调用记录） */
export function cleanupOldCalls(days: number): number {
  const d = getDb();
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  d.run('DELETE FROM calls WHERE created_at < ?', [cutoff]);
  const modified = d.getRowsModified();
  saveDb();
  return modified;
}

/** 清空所有调用、会话、定价和供应商配置 */
export function clearAllData(): void {
  const d = getDb();
  d.run('DELETE FROM calls');
  d.run('DELETE FROM sessions');
  d.run('DELETE FROM pricing');
  d.run('DELETE FROM provider_config');
  d.run("DELETE FROM sqlite_sequence WHERE name IN ('calls','sessions','pricing','provider_config')");
  saveDb();
}

/** 删除所有第三方供应商（保留内置 Anthropic 和 OpenAI） */
export function deleteAllThirdPartyProviders(): number {
  const d = getDb();
  d.run("DELETE FROM provider_config WHERE LOWER(provider) NOT IN ('anthropic', 'openai')");
  const count = d.getRowsModified();
  saveDb();
  return count;
}

/** 清空所有会话及其关联调用 */
export function deleteAllSessions(): number {
  const d = getDb();
  d.run('DELETE FROM calls');
  const count = d.getRowsModified();
  d.run('DELETE FROM sessions');
  d.run("DELETE FROM sqlite_sequence WHERE name IN ('calls','sessions')");
  saveDb();
  return count;
}

/** 初始化内置供应商（仅当不存在时） */
export function initDefaultProviders(): void {
  const defaults: [string, string][] = [
    ['Anthropic', 'anthropic'], ['OpenAI', 'openai'],
  ];
  for (const [p, fmt] of defaults) {
    execute(
      'INSERT OR IGNORE INTO provider_config (provider, base_url, api_key, api_format, enabled) VALUES (?, ?, ?, ?, 1)',
      [p, '', '', fmt],
    );
  }
}

// ── Pricing CRUD ──

/** 列出定价 */
export function listPricing(): Record<string, any>[] {
  return queryAll('SELECT * FROM pricing ORDER BY id');
}

/** 新增或更新定价 */
export function upsertPricing(
  provider: string, model: string,
  inputPrice: number, cacheInputPrice: number, outputPrice: number,
  currency?: string,
  isDefault?: boolean,
): number {
  const cur = currency || 'CNY';
  const def = isDefault ? 1 : 0;
  // sql.js 不支持 ON CONFLICT，用先查再插入/更新的方式
  const existing = queryOne(
    'SELECT id, is_default FROM pricing WHERE provider = ? AND model = ? AND effective_from IS NULL',
    [provider, model],
  );
  if (existing) {
    // 默认条目只更新价格和币种，不覆盖 is_default 标记
    const keepDefault = existing.is_default ? 1 : def;
    execute(
      'UPDATE pricing SET input_price = ?, cache_input_price = ?, output_price = ?, currency = ?, is_default = ? WHERE id = ?',
      [inputPrice, cacheInputPrice, outputPrice, cur, keepDefault, existing.id],
    );
    return Number(existing.id);
  }
  return executeInsert(
    'INSERT INTO pricing (provider, model, input_price, cache_input_price, output_price, currency, is_default) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id',
    [provider, model, inputPrice, cacheInputPrice, outputPrice, cur, def],
  );
}

/** 删除定价（默认条目不可删除） */
export function deletePricing(pricingId: number): { ok: boolean; error?: string } {
  const row = queryOne('SELECT is_default FROM pricing WHERE id = ?', [pricingId]);
  if (!row) return { ok: false, error: '定价不存在' };
  if (row.is_default) return { ok: false, error: '默认定价不可删除' };
  execute('DELETE FROM pricing WHERE id = ?', [pricingId]);
  return { ok: true };
}

// ── Provider Config CRUD ──

const OFFICIAL_URLS: Record<string, string> = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com',
};
const OFFICIAL_ANTHROPIC_URLS: Record<string, string> = {
  anthropic: 'https://api.anthropic.com',
};

/** 内置供应商名称集合（不可删除、不可停用） */
export const BUILTIN_PROVIDERS = new Set(['Anthropic', 'OpenAI']);

/** 列出所有 provider 配置（内置供应商兜底官方 URL） */
export function listProviderConfigs(): Record<string, any>[] {
  const rows = queryAll('SELECT * FROM provider_config ORDER BY provider');
  return rows.map(row => ({
    ...row,
    base_url: row.base_url || OFFICIAL_URLS[row.provider] || '',
    base_url_anthropic: row.base_url_anthropic || OFFICIAL_ANTHROPIC_URLS[row.provider] || '',
  }));
}

/** 获取单个 provider 的配置（大小写不敏感，base_url 为空时返回官方地址） */
export function getProviderConfig(provider: string): { provider: string; base_url: string; base_url_anthropic: string; api_key: string; api_format: string; enabled: boolean } | null {
  // 先精确匹配，再大小写不敏感匹配
  let row = queryOne('SELECT * FROM provider_config WHERE provider = ?', [provider]);
  if (!row) {
    row = queryOne('SELECT * FROM provider_config WHERE LOWER(provider) = LOWER(?)', [provider]);
  }
  if (!row) return null;
  const resolved = row.provider || provider;
  const defaultUrl = OFFICIAL_URLS[resolved] || OFFICIAL_URLS[resolved.toLowerCase()] || '';
  return {
    provider: resolved,
    base_url: row.base_url || defaultUrl,
    base_url_anthropic: row.base_url_anthropic || '',
    api_key: row.api_key || '',
    api_format: row.api_format || '',
    enabled: row.enabled === 1,
  };
}

/** 内置供应商检查（大小写不敏感） */
function isBuiltinProvider(provider: string): boolean {
  return [...BUILTIN_PROVIDERS].some(b => b.toLowerCase() === provider.toLowerCase());
}

/** 更新 provider 配置（内置供应商不允许停用） */
export function updateProviderConfig(provider: string, data: { enabled?: boolean; api_format?: string; api_key?: string; base_url?: string; base_url_anthropic?: string }): { ok: boolean; error?: string } {
  // 内置供应商不允许停用（大小写不敏感）
  if (data.enabled === false && isBuiltinProvider(provider)) {
    return { ok: false, error: `内置供应商 "${provider}" 不可停用` };
  }
  const sets: string[] = [];
  const vals: any[] = [];
  if (data.api_format !== undefined) { sets.push('api_format = ?'); vals.push(data.api_format); }
  if (data.enabled !== undefined) { sets.push('enabled = ?'); vals.push(data.enabled ? 1 : 0); }
  if (data.api_key !== undefined) { sets.push('api_key = ?'); vals.push(data.api_key); }
  if (data.base_url !== undefined) { sets.push('base_url = ?'); vals.push(data.base_url); }
  if (data.base_url_anthropic !== undefined) { sets.push('base_url_anthropic = ?'); vals.push(data.base_url_anthropic); }
  if (sets.length === 0) return { ok: true };
  vals.push(provider);
  execute(`UPDATE provider_config SET ${sets.join(', ')} WHERE provider = ?`, vals);
  // 停用时自动清除所有引用该供应商的会话上游覆写（provider + model）
  if (data.enabled === false) {
    const cleared = execute('UPDATE sessions SET upstream_provider = NULL, upstream_model = NULL WHERE upstream_provider = ?', [provider]);
    if (cleared > 0) {
      console.log(`已清除 ${cleared} 个会话的 "${provider}" 上游覆写`);
    }
  }
  return { ok: true };
}

/** 新增自定义 provider */
export function addProviderConfig(provider: string, baseUrl: string, baseUrlAnthropic: string, apiKey: string, apiFormat: string): number {
  return executeInsert(
    'INSERT INTO provider_config (provider, base_url, base_url_anthropic, api_key, api_format, enabled) VALUES (?, ?, ?, ?, ?, 1) RETURNING id',
    [provider, baseUrl, baseUrlAnthropic, apiKey, apiFormat],
  );
}

/** 删除 provider 配置（内置供应商不可删除） */
export function deleteProviderConfig(provider: string): { ok: boolean; error?: string } {
  if (isBuiltinProvider(provider)) {
    return { ok: false, error: `内置供应商 "${provider}" 不可删除` };
  }
  execute('DELETE FROM provider_config WHERE provider = ?', [provider]);
  // 同时清除引用该供应商的会话上游覆写
  const cleared = execute('UPDATE sessions SET upstream_provider = NULL, upstream_model = NULL WHERE upstream_provider = ?', [provider]);
  if (cleared > 0) {
    console.log(`已清除 ${cleared} 个会话的 "${provider}" 上游覆写`);
  }
  return { ok: true };
}

// ── Settings ──

export function getSetting(key: string): string | null {
  const row = queryOne('SELECT value FROM metadata WHERE key = ?', [key]);
  return row?.value ?? null;
}

export function setSetting(key: string, value: string): void {
  const existing = queryOne('SELECT key FROM metadata WHERE key = ?', [key]);
  if (existing) {
    execute('UPDATE metadata SET value = ? WHERE key = ?', [value, key]);
  } else {
    execute('INSERT INTO metadata (key, value) VALUES (?, ?)', [key, value]);
  }
}
