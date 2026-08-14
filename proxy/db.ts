/**
 * SQLite 数据库模块 — 基于 sql.js (纯 WASM，无需编译)
 *
 * sql.js 的数据库完全在内存中运行，写入后需调用 saveDb() 持久化到磁盘。
 * 采用单例模式，所有模块共享同一个数据库实例。
 */

import { readFileSync, existsSync, rmSync } from 'node:fs';
import { ensureDataDir, DB_PATH } from './config.js';
import { deleteSessionBodies, moveSessionBodies, clearAllBodies, bodyFilePath } from './db-body.js';
import type { CallRecord } from '../shared/types.js';
import { initSqlJsCore, setDb, getSql, setCurrentDbPath, getDb, saveDb, closeDb, queryAll, queryOne, execute, executeInsert, startSaveSafetyNet } from './db-core.js';
import { runMigrations, migrateToolCanonicalNames, migrateLowercaseNames } from './db-migrations.js';
import { normalizeToolName, normalizeProviderName, getToolConfig } from './db-config.js';

// 兼容旧引用：统一从 db-core / db-migrations / db-config re-export（router/recorder/测试 import 路径不变）
export { getDb, saveDb, closeDb, queryAll, queryOne } from './db-core.js';
export { BUILTIN_PROVIDERS, migrateToolCanonicalNames, migrateLowercaseNames, runMigrations } from './db-migrations.js';
// 兼容旧引用：配置 CRUD 与名称归一化统一从 db-config re-export
export { normalizeToolName, normalizeProviderName, listToolConfigs, getToolConfig, updateToolConfig,
  listPricing, upsertPricing, deletePricing, listProviderConfigs, getProviderConfig, updateProviderConfig,
  addProviderConfig, deleteProviderConfig, getSetting, setSetting } from './db-config.js';

// ── 初始化 ──

/** 初始化 sql.js + 数据库，建表。调用一次即可。 */
export async function initDb(dbPath?: string): Promise<void> {
  // 已初始化则直接返回（SQL/db 实例状态由 db-core 持有，幂等检查语义不变）
  try {
    getSql(); getDb();
    return;
  } catch {
    // 未初始化 → 继续执行初始化
  }

  ensureDataDir();
  const path = dbPath ?? DB_PATH;
  setCurrentDbPath(path); // 记录当前数据库路径，供后续 saveDb() 使用

  await initSqlJsCore();
  const SQL = getSql(); // 获取 sql.js 静态实例（构造 Database 用）

  // 如果文件已存在，从磁盘加载；否则创建空库
  if (existsSync(path)) {
    const buffer = readFileSync(path);
    try {
      setDb(new SQL.Database(buffer));
    } catch {
      // 文件损坏（如 tsx watch kill 时保存中断），尝试从备份恢复
      console.warn('数据库文件损坏，尝试从备份恢复…');
      const backupPath = path + '.bak';
      if (existsSync(backupPath)) {
        setDb(new SQL.Database(readFileSync(backupPath)));
        console.log('已从备份恢复数据库');
      } else {
        setDb(new SQL.Database());
        console.log('无可用备份，使用空数据库');
      }
    }
  } else {
    setDb(new SQL.Database());
  }
  const db = getDb(); // 绑定当前数据库实例，后续建表/迁移/种子代码复用

  db.run('PRAGMA journal_mode = WAL;');

  // 创建 metadata 表（最先，用于 schema 版本检查）
  db.run(`CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT)`);

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
      tool         TEXT,
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
      created_at        INTEGER NOT NULL DEFAULT 0,
      updated_at        INTEGER NOT NULL DEFAULT 0,
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
      enabled    INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0
    )
  `);

  // 初始化内置 provider 的默认配置（存储不变量：供应商名小写）
  const defaults: string[] = ['anthropic', 'openai'];
  for (const p of defaults) {
    db.run('INSERT OR IGNORE INTO provider_config (provider, base_url, api_key, enabled) VALUES (?, ?, ?, 1)', [p, '', '']);
  }

  // hourly_stats 统计表 — 纯 UTC 小时毫秒主键，写入端零时区；天级/小时级标签在查询端按 tzOffset 重算
  db.run(`
    CREATE TABLE IF NOT EXISTS hourly_stats (
      hour_ms    INTEGER NOT NULL,
      provider   TEXT    NOT NULL,
      model      TEXT    NOT NULL,
      tool       TEXT    NOT NULL,
      call_count INTEGER NOT NULL DEFAULT 0,
      total_cost REAL    NOT NULL DEFAULT 0,
      prompt_tokens     INTEGER NOT NULL DEFAULT 0,
      output_tokens     INTEGER NOT NULL DEFAULT 0,
      uncached_input    INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (hour_ms, provider, model, tool)
    )
  `);

  // 索引
  const indexes = [
    'CREATE INDEX IF NOT EXISTS idx_calls_session ON calls(session_id)',
    'CREATE INDEX IF NOT EXISTS idx_calls_created ON calls(created_at)',
    'CREATE INDEX IF NOT EXISTS idx_calls_model ON calls(model)',
    'CREATE INDEX IF NOT EXISTS idx_calls_fingerprint ON calls(fingerprint)',
    'CREATE INDEX IF NOT EXISTS idx_calls_tool ON calls(tool)',
    'CREATE INDEX IF NOT EXISTS idx_sessions_tool ON sessions(tool)',
    'CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status)',
    'CREATE INDEX IF NOT EXISTS idx_hourly_provider ON hourly_stats(provider)',
  ];
  for (const idx of indexes) {
    db.run(idx);
  }

  // 兼容已有库：添加 upstream_provider 列（列已存在则忽略错误）
  try { db.run(`ALTER TABLE sessions ADD COLUMN upstream_provider TEXT`); } catch {}
  try { db.run(`ALTER TABLE sessions ADD COLUMN upstream_model TEXT`); } catch {}
  // 兼容已有库：添加 base_url_anthropic 列
  try { db.run(`ALTER TABLE provider_config ADD COLUMN base_url_anthropic TEXT`); } catch {}
  // 兼容已有库：添加配置表时间戳列（存量行回填 0 = 未知）
  try { db.run(`ALTER TABLE provider_config ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0`); } catch {}
  try { db.run(`ALTER TABLE provider_config ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0`); } catch {}
  try { db.run(`ALTER TABLE tool_config ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0`); } catch {}
  try { db.run(`ALTER TABLE tool_config ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0`); } catch {}
  try { db.run(`ALTER TABLE pricing ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0`); } catch {}
  try { db.run(`ALTER TABLE pricing ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0`); } catch {}
  // 兼容已有库：添加 is_default 列
  try { db.run(`ALTER TABLE pricing ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0`); } catch {}
  // 兼容已有库：添加 target_url、source_ip 列
  try { db.run(`ALTER TABLE calls ADD COLUMN target_url TEXT`); } catch {}
  try { db.run(`ALTER TABLE calls ADD COLUMN source_ip TEXT`); } catch {}
  // 兼容已有库：添加 tool 列
  try { db.run(`ALTER TABLE calls ADD COLUMN tool TEXT`); } catch {}
  try { db.run(`ALTER TABLE calls ADD COLUMN downstream_url TEXT`); } catch {}

  // 工具级上游配置（claudecode / codex 等的默认供应商和模型覆盖）
  db.run(`
    CREATE TABLE IF NOT EXISTS tool_config (
      tool              TEXT PRIMARY KEY,
      upstream_provider TEXT,
      upstream_model    TEXT,
      created_at        INTEGER NOT NULL DEFAULT 0,
      updated_at        INTEGER NOT NULL DEFAULT 0
    )
  `);

  // 类别颜色：色板静态数据表（改颜色只改此表，不动代码；theme 为未来主题预留）
  db.run(`
    CREATE TABLE IF NOT EXISTS color_palette (
      theme TEXT NOT NULL,
      idx   INTEGER NOT NULL,
      color TEXT NOT NULL,
      PRIMARY KEY (theme, idx)
    )
  `);

  // 类别颜色：工具/供应商色位注册表（两池独立注册，可同色位；注册后永久不变）
  db.run(`
    CREATE TABLE IF NOT EXISTS category_colors (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      kind       TEXT    NOT NULL,
      name       TEXT    NOT NULL,
      color_idx  INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE (kind, name)
    )
  `);

  // 历史数据工具名归一化迁移（claudeCode→ClaudeCode、codex/chatGPT→Codex 等，单次执行）
  // 失败时内部已回滚；此处降级为警告并继续启动（门控未设置，下次启动自动重试），避免迁移异常导致整个代理不可用
  try {
    migrateToolCanonicalNames();
  } catch (err) {
    console.error(`[db] ⚠ 历史数据归一化迁移失败（已回滚，不影响启动，下次启动重试）: ${(err as Error).message}`);
  }

  // 历史数据小写迁移（名称字段统一小写，单次执行；失败降级警告，下次启动重试）
  try {
    migrateLowercaseNames();
  } catch (err) {
    console.error(`[db] ⚠ 小写迁移失败（已回滚，不影响启动，下次启动重试）: ${(err as Error).message}`);
  }

  // 迁移：读当前版本（无版本号视为 v1），依次执行未应用的迁移
  const storedVersion = (() => {
    try {
      const r = db.exec("SELECT value FROM metadata WHERE key = 'schema_version'");
      if (r.length > 0 && r[0].values.length > 0) return parseInt(r[0].values[0][0] as string);
    } catch {}
    return 1;
  })();
  runMigrations(storedVersion);

  // 类别颜色：色板种子 + 注册迁移（动态 import 避免与 colors.ts 循环依赖；失败降级警告，不影响启动）
  try {
    const colorsMod = await import('./colors.js');
    colorsMod.seedPalette();
    colorsMod.migrateCategoryColors();
  } catch (err) {
    console.error(`[db] ⚠ 颜色注册初始化失败（不影响启动）: ${(err as Error).message}`);
  }

  saveDb();
  startSaveSafetyNet();
}

// ── Calls CRUD ──

/** 插入调用记录，返回新 id（工具名 / 供应商名 / 模型名写入前归一化为小写） */
export function insertCall(r: CallRecord): number {
  if (r.tool) r.tool = normalizeToolName(r.tool);
  if (r.provider) r.provider = normalizeProviderName(r.provider);
  if (r.model) r.model = r.model.toLowerCase();
  return executeInsert(
    `INSERT INTO calls (session_id, provider, model, endpoint, method,
      target_url, downstream_url, source_ip,
      status_code, error_message, duration_ms, prompt_tokens, output_tokens,
      cache_read_tokens, cache_write_tokens, uncached_input, input_cost,
      output_cost, total_cost, cache_savings, request_body, response_body,
      fingerprint, source_port, tool, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?) RETURNING id`,
    [
      r.session_id, r.provider, r.model, r.endpoint, r.method,
      r.target_url, r.downstream_url, r.source_ip,
      r.status_code, r.error_message, r.duration_ms, r.prompt_tokens, r.output_tokens,
      r.cache_read_tokens, r.cache_write_tokens, r.uncached_input, r.input_cost,
      r.output_cost, r.total_cost, r.cache_savings,
      r.fingerprint, r.source_port, r.tool, r.created_at ?? Date.now(),
    ],
  );
}

/** 列出调用记录（tool 过滤按 calls.tool 直查，v4 迁移已回填历史 NULL） */
export function listCalls(sessionId?: number, provider?: string, tool?: string, limit = 50, offset = 0): Record<string, any>[] {
  let sql = 'SELECT c.* FROM calls c';
  const conditions: string[] = [];
  const params: any[] = [];
  if (tool) { conditions.push('c.tool = ?'); params.push(normalizeToolName(tool)); }
  if (sessionId != null) { conditions.push('c.session_id = ?'); params.push(sessionId); }
  if (provider) { conditions.push('c.provider = ?'); params.push(normalizeProviderName(provider)); }
  if (conditions.length > 0) sql += ' WHERE ' + conditions.join(' AND ');
  sql += ' ORDER BY c.created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);
  return queryAll(sql, params);
}

/** 统计符合条件的调用总数（与 listCalls 相同的过滤条件，供分页展示「共 N 条」） */
export function countCalls(sessionId?: number, provider?: string, tool?: string): number {
  let sql = 'SELECT COUNT(*) AS cnt FROM calls c';
  const conditions: string[] = [];
  const params: any[] = [];
  if (tool) { conditions.push('c.tool = ?'); params.push(normalizeToolName(tool)); }
  if (sessionId != null) { conditions.push('c.session_id = ?'); params.push(sessionId); }
  if (provider) { conditions.push('c.provider = ?'); params.push(normalizeProviderName(provider)); }
  if (conditions.length > 0) sql += ' WHERE ' + conditions.join(' AND ');
  return Number(queryOne(sql, params)?.cnt) || 0;
}

/** 会话 Token 分项统计（输出 / 未命中缓存输入 / 命中缓存）— 全量聚合，不受时间线分页影响 */
export function getSessionTokenStats(sessionId: number): { output_tokens: number; uncached_input: number; cache_read_tokens: number } {
  const row = queryOne(
    `SELECT COALESCE(SUM(output_tokens), 0) AS output_tokens,
            COALESCE(SUM(uncached_input), 0) AS uncached_input,
            COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens
     FROM calls WHERE session_id = ?`,
    [sessionId],
  );
  return {
    output_tokens: Number(row?.output_tokens) || 0,
    uncached_input: Number(row?.uncached_input) || 0,
    cache_read_tokens: Number(row?.cache_read_tokens) || 0,
  };
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
export function upsertSession(fullFp: string, tool: string, endpoint: string, label?: string | null): number {
  const now = Date.now();
  tool = normalizeToolName(tool);

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

  // 从工具级配置继承上游供应商和模型（供应商名归一化为小写）
  const tc = getToolConfig(tool);
  const tcProvider = tc?.upstream_provider ? normalizeProviderName(tc.upstream_provider) : null;
  const tcModel = tc?.upstream_model || null;

  // 2. 查找同工具最近的 pending 会话 → 升级
  const pending = queryOne(
    "SELECT id FROM sessions WHERE tool = ? AND status = 'pending' ORDER BY last_call_at DESC LIMIT 1",
    [tool],
  );
  if (pending) {
    execute(
      "UPDATE sessions SET fingerprint = ?, status = 'active', last_call_at = ?, first_endpoint = ?, upstream_provider = ?, upstream_model = ?, label = COALESCE(?, label) WHERE id = ?",
      [fullFp, now, endpoint, tcProvider, tcModel, label || null, pending.id],  // 与新建分支一致：空字符串视为无标签
    );
    return Number(pending.id);
  }

  // 3. 新建会话
  return executeInsert(
    `INSERT INTO sessions (tool, label, fingerprint, status, first_call_at, last_call_at, first_endpoint, created_at, upstream_provider, upstream_model)
     VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?) RETURNING id`,
    [tool, label || null, fullFp, now, now, endpoint, now, tcProvider, tcModel],
  );
}

/** 创建 pending 会话（由包装脚本在 CLI 启动时调用） */
// pending session 计数器，防止同毫秒内创建多个 session 时指纹碰撞
let pendingCounter = 0;

export function createPendingSession(tool: string): number {
  const now = Date.now();
  tool = normalizeToolName(tool);
  const fp = `pending:${tool}:${now}:${pendingCounter++}`;
  const tc = getToolConfig(tool);
  const tcProvider = tc?.upstream_provider ? normalizeProviderName(tc.upstream_provider) : null;
  return executeInsert(
    `INSERT INTO sessions (tool, fingerprint, status, first_call_at, last_call_at, first_endpoint, created_at, upstream_provider, upstream_model)
     VALUES (?, ?, 'pending', ?, ?, '/_startup_', ?, ?, ?) RETURNING id`,
    [tool, fp, now, now, now, tcProvider, tc?.upstream_model || null],
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
  if (tool) { sql += ' AND tool = ?'; params.push(normalizeToolName(tool)); }  // 入参归一化后等值比较（可走索引）
  if (status) { sql += ' AND status = ?'; params.push(status); }
  sql += ' ORDER BY last_call_at DESC LIMIT ?';
  params.push(limit);
  return queryAll(sql, params);
}

/** 获取单条会话 */
export function getSession(sessionId: number): Record<string, any> | null {
  return queryOne('SELECT * FROM sessions WHERE id = ?', [sessionId]);
}

/** 激活已有会话（更新状态和时间） */
export function activateSession(sessionId: number): void {
  execute("UPDATE sessions SET status = 'active', last_call_at = ? WHERE id = ?", [Date.now(), sessionId]);
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
  moveSessionBodies(sourceId, targetId);   // 先 DB 后文件：把源会话 body 文件移入目标会话
  saveDb();
}

/** 设置会话的上游覆盖（供应商名归一化为小写存储） */
export function updateSessionUpstream(sessionId: number, upstreamProvider: string | null): void {
  const normalized = upstreamProvider ? normalizeProviderName(upstreamProvider) : upstreamProvider;
  execute('UPDATE sessions SET upstream_provider = ? WHERE id = ?', [normalized, sessionId]);
}

export function updateSessionModel(sessionId: number, model: string | null): void {
  execute('UPDATE sessions SET upstream_model = ? WHERE id = ?', [model ? model.toLowerCase() : model, sessionId]);
}

/** 删除会话及其所有关联调用 */
export function deleteSession(sessionId: number): void {
  execute('DELETE FROM calls WHERE session_id = ?', [sessionId]);
  execute('DELETE FROM sessions WHERE id = ?', [sessionId]);
  deleteSessionBodies(sessionId);   // 先 DB 后文件：附属清理失败不影响主数据
}

// ── Stats ──

/** 格式化模型显示名：去日期后缀 + 版本号用点分隔（如 -4-6 → -4.6） */
function formatModelName(model: string): string {
  return model
    .replace(/-\d{8}$/, '')
    .replace(/-(\d+)-(\d+)$/, '-$1.$2');
}

/** 聚合统计（从 hourly_stats 上卷，不受删除操作影响） */
export function getStats(groupBy: string, provider?: string, tool?: string): Record<string, any>[] {
  const aggs = `SUM(call_count) as count,
     SUM(total_cost) as total_cost,
     SUM(prompt_tokens) as total_input_tokens,
     SUM(output_tokens) as total_output_tokens,
     SUM(cache_read_tokens) as total_cache_read_tokens,
     SUM(uncached_input) as total_uncached_input`;

  // hourly_stats 自带 tool 列，无需 JOIN sessions
  const validCols: Record<string, string> = { provider: 'provider', model: 'model', tool: 'tool' };
  const col = validCols[groupBy] || 'provider';
  let sql = `SELECT ${col} as key, ${aggs}
     FROM hourly_stats`;
  const conditions: string[] = [];
  const params: any[] = [];
  if (provider) { conditions.push('provider = ?'); params.push(normalizeProviderName(provider)); }  // 入参归一化后等值比较
  if (tool) { conditions.push('tool = ?'); params.push(normalizeToolName(tool)); }
  if (conditions.length > 0) sql += ' WHERE ' + conditions.join(' AND ');
  sql += ` GROUP BY ${col} ORDER BY total_cost DESC`;
  const results = queryAll(sql, params);
  // 按模型分组时，去除日期后缀合并统计（大小写变体也归入同一条目，显示名取首个出现的形态）
  if (col === 'model') {
    const merged = new Map<string, Record<string, any>>();
    for (const row of results) {
      const stripped = formatModelName(row.key);
      const mergeKey = stripped.toLowerCase();
      if (merged.has(mergeKey)) {
        const m = merged.get(mergeKey)!;
        m.count += row.count;
        m.total_cost += row.total_cost;
        m.total_input_tokens += row.total_input_tokens;
        m.total_output_tokens += row.total_output_tokens;
        m.total_cache_read_tokens += row.total_cache_read_tokens;
        m.total_uncached_input += row.total_uncached_input;
      } else {
        merged.set(mergeKey, { ...row, key: stripped });
      }
    }
    return [...merged.values()].sort((a, b) => b.total_cost - a.total_cost);
  }
  return results;
}

/**
 * 时间统计：按范围 + 粒度聚合（从 hourly_stats 上卷，不受删除操作影响）。
 * range: '7d'|'14d'|'30d'|'60d' → 按天，最近 N 天
 *        'today'|'yesterday'      → 按小时（date 标签 'YYYY-MM-DD HH:00'）
 *        'thisMonth'|'lastMonth'|'thisQuarter'|'lastQuarter'|'thisYear'|'lastYear' → 按天
 * tzOffset: 时区偏移小时数（默认 8 = UTC+8）；hour_ms 为纯 UTC 小时边界，标签在查询端重算
 * 返回结构与旧版一致：date 为标签文本，分组时附带 category 列
 */
export function getDailyStats(range: string, provider?: string, tool?: string, groupBy?: string, tzOffset = 8): Record<string, any>[] {
  const now = new Date();
  let startMs: number;
  let endMs: number | null = null;
  const utcNow = new Date(now.getTime() + now.getTimezoneOffset() * 60000 + tzOffset * 3600000);
  const tzMidnightMs = (daysOffset = 0) => Date.UTC(utcNow.getFullYear(), utcNow.getMonth(), utcNow.getDate() + daysOffset);

  switch (range) {
    case 'today':
      startMs = tzMidnightMs();
      break;
    case 'yesterday':
      startMs = tzMidnightMs(-1);
      endMs = tzMidnightMs();
      break;
    case '7d':
    case '14d':
    case '30d':
    case '60d':
      startMs = tzMidnightMs(-(parseInt(range) - 1));
      break;
    case 'thisMonth':
      startMs = Date.UTC(utcNow.getFullYear(), utcNow.getMonth(), 1);
      break;
    case 'lastMonth':
      startMs = Date.UTC(utcNow.getFullYear(), utcNow.getMonth() - 1, 1);
      endMs = Date.UTC(utcNow.getFullYear(), utcNow.getMonth(), 1);
      break;
    case 'thisQuarter':
      startMs = Date.UTC(utcNow.getFullYear(), Math.floor(utcNow.getMonth() / 3) * 3, 1);
      break;
    case 'lastQuarter': {
      const quarterStartMonth = Math.floor(utcNow.getMonth() / 3) * 3;
      startMs = Date.UTC(utcNow.getFullYear(), quarterStartMonth - 3, 1);
      endMs = Date.UTC(utcNow.getFullYear(), quarterStartMonth, 1);
      break;
    }
    case 'thisYear':
      startMs = Date.UTC(utcNow.getFullYear(), 0, 1);
      break;
    case 'lastYear':
      startMs = Date.UTC(utcNow.getFullYear() - 1, 0, 1);
      endMs = Date.UTC(utcNow.getFullYear(), 0, 1);
      break;
    default:
      startMs = tzMidnightMs(-30);
  }

  const aggs = `SUM(call_count) as count,
     SUM(total_cost) as total_cost,
     SUM(output_tokens) as total_output_tokens,
     SUM(uncached_input) as total_uncached_input,
     SUM(cache_read_tokens) as total_cache_read_tokens`;

  const isHourly = range === 'today' || range === 'yesterday';
  const tzSeconds = tzOffset * 3600;
  // 标签在查询端按 tzOffset 重算：小时级 'YYYY-MM-DD HH:00'，天级 'YYYY-MM-DD'
  const labelExpr = isHourly
    ? `strftime('%Y-%m-%d %H:00', (hour_ms / 1000) + ${tzSeconds}, 'unixepoch')`
    : `strftime('%Y-%m-%d', (hour_ms / 1000) + ${tzSeconds}, 'unixepoch')`;

  let groupCol = '';
  if (groupBy === 'tool') groupCol = 'tool as category,';
  else if (groupBy === 'provider') groupCol = 'provider as category,';
  else if (groupBy === 'model') groupCol = 'model as category,';

  let sql = `SELECT ${groupCol} ${labelExpr} as date, ${aggs}
     FROM hourly_stats`;
  const conditions: string[] = [];
  const params: any[] = [];
  // hour_ms 为纯 UTC 小时边界，startMs/endMs 均为整点毫秒，直接数值比较
  if (endMs != null) {
    conditions.push('hour_ms >= ? AND hour_ms < ?');
    params.push(startMs, endMs);
  } else {
    conditions.push('hour_ms >= ?');
    params.push(startMs);
  }
  if (provider) { conditions.push('provider = ?'); params.push(normalizeProviderName(provider)); }
  if (tool) { conditions.push('tool = ?'); params.push(normalizeToolName(tool)); }
  sql += ' WHERE ' + conditions.join(' AND ');
  const groupParts = ['date'];
  if (groupBy === 'tool' || groupBy === 'provider' || groupBy === 'model') groupParts.push('category');
  sql += ' GROUP BY ' + groupParts.join(', ');
  sql += ' ORDER BY date ASC';
  return queryAll(sql, params);
}

/** 累加小时统计（upsert），独立于 calls 表，删除操作不影响。
 *  hour_ms 由 createdAtMs 纯整数运算得出（UTC 小时边界），写入端零时区。 */
export function upsertHourlyStat(
  provider: string, model: string, tool: string | null,
  cost: number, promptTokens: number, outputTokens: number,
  uncachedInput: number, cacheReadTokens: number,
  createdAtMs: number = Date.now(),
): void {
  const hourMs = Math.floor(createdAtMs / 3600000) * 3600000;
  const now = Date.now();
  const d = getDb();
  d.run(
    `INSERT INTO hourly_stats (hour_ms, provider, model, tool, call_count, total_cost, prompt_tokens, output_tokens, uncached_input, cache_read_tokens, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(hour_ms, provider, model, tool) DO UPDATE SET
       call_count = call_count + 1,
       total_cost = total_cost + excluded.total_cost,
       prompt_tokens = prompt_tokens + excluded.prompt_tokens,
       output_tokens = output_tokens + excluded.output_tokens,
       uncached_input = uncached_input + excluded.uncached_input,
       cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
       created_at = CASE WHEN created_at = 0 THEN excluded.created_at ELSE created_at END,
       updated_at = excluded.updated_at`,
    [hourMs, normalizeProviderName(provider), model ? model.toLowerCase() : 'unknown', tool ? normalizeToolName(tool) : 'unknown',
     cost, promptTokens, outputTokens, uncachedInput, cacheReadTokens, createdAtMs, now],
  );
  saveDb();
}

// ── Data Management ──

/** 清理旧数据（days 天前的调用记录及其 body 文件） */
export function cleanupOldCalls(days: number): number {
  const d = getDb();
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const rows = queryAll('SELECT id, session_id, created_at FROM calls WHERE created_at < ?', [cutoff]);
  d.run('DELETE FROM calls WHERE created_at < ?', [cutoff]);
  const modified = d.getRowsModified();
  saveDb();
  // 先 DB 后文件：逐个删除过期 body 文件（文件缺失静默忽略）
  for (const r of rows) {
    try {
      rmSync(bodyFilePath(Number(r.session_id), Number(r.id), Number(r.created_at)));
    } catch {}
  }
  return modified;
}

/** 清空所有调用、会话、定价和供应商配置 */
export function clearAllData(): void {
  const d = getDb();
  d.run('DELETE FROM calls');
  d.run('DELETE FROM sessions');
  d.run('DELETE FROM pricing');
  d.run('DELETE FROM provider_config');
  d.run('DELETE FROM hourly_stats');
  d.run("DELETE FROM sqlite_sequence WHERE name IN ('calls','sessions','pricing','provider_config','hourly_stats')");
  clearAllBodies();   // 先 DB 后文件：清空 body 目录
  saveDb();
}

/** 删除所有第三方供应商（保留内置 anthropic 和 openai） */
export function deleteAllThirdPartyProviders(): number {
  const d = getDb();
  d.run("DELETE FROM provider_config WHERE LOWER(provider) NOT IN ('anthropic', 'openai')");
  const count = d.getRowsModified();
  saveDb();
  return count;
}

/** 清空所有会话及其关联调用 + 重置 AUTOINCREMENT */
export function deleteAllSessions(): number {
  const d = getDb();
  d.run('DELETE FROM calls');
  const count = d.getRowsModified();
  d.run('DELETE FROM sessions');
  // 重置 AUTOINCREMENT 计数器（与 clearAllData 同法，避免 DDL 重建导致约束漂移）
  d.run("DELETE FROM sqlite_sequence WHERE name IN ('calls', 'sessions')");
  clearAllBodies();   // 先 DB 后文件：清空 body 目录
  saveDb();
  return count;
}

/** 初始化内置供应商（仅当不存在时，存储不变量：供应商名小写） */
export function initDefaultProviders(): void {
  const defaults: string[] = ['anthropic', 'openai'];
  for (const p of defaults) {
    execute(
      'INSERT OR IGNORE INTO provider_config (provider, base_url, api_key, enabled) VALUES (?, ?, ?, 1)',
      [p, '', ''],
    );
  }
}

