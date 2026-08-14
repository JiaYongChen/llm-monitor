/**
 * SQLite 数据库模块 — 基于 sql.js (纯 WASM，无需编译)
 *
 * sql.js 的数据库完全在内存中运行，写入后需调用 saveDb() 持久化到磁盘。
 * 采用单例模式，所有模块共享同一个数据库实例。
 */

import { readFileSync, existsSync, copyFileSync } from 'node:fs';
import { ensureDataDir, DB_PATH } from './config.js';
import type { CallRecord } from '../shared/types.js';
import { initSqlJsCore, setDb, getSql, setCurrentDbPath, getDb, saveDb, closeDb, queryAll, queryOne, execute, executeInsert, runRaw, startSaveSafetyNet } from './db-core.js';

// 兼容旧引用：统一从 db-core re-export（router/recorder/测试 import 路径不变）
export { getDb, saveDb, closeDb, queryAll, queryOne } from './db-core.js';

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

  // 仅在 schema 版本变更时重建表
  const currentVersion = 3;
  const storedVersion = (() => {
    try {
      const r = db.exec("SELECT value FROM metadata WHERE key = 'schema_version'");
      if (r.length > 0 && r[0].values.length > 0) return parseInt(r[0].values[0][0] as string);
    } catch {}
    return 1; // 无版本号视为 v1（旧 TEXT 时间格式）
  })();

  // 仅 v1 → v2（时间戳格式变更）需要重建表；v2 → v3 为增量迁移（见 initDb 末尾 daily_stats 块），不能删表
  if (storedVersion < 2) {
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

  // v2 → v3：从 calls 表回填已有数据到 daily_stats（仅首次升级执行）
  // 使用 INSERT OR IGNORE + 事务包装确保幂等：升级中断后重启不会触发主键冲突
  // 临时措施：daily_stats 已由 hourly_stats 替换，全新库此块会因表不存在报错 → 整体 try-catch 包裹（Task 6 迁移机制化时移除）
  if (storedVersion < 3) {
    try {
      db.run('BEGIN');
      try {
        db.run(`
          INSERT OR IGNORE INTO daily_stats (date, provider, model, tool, call_count, total_cost, prompt_tokens, output_tokens, uncached_input, cache_read_tokens, created_at_ms)
          SELECT
            strftime('%Y-%m-%d', (created_at + 28800000) / 1000, 'unixepoch') as date,  -- UTC+8 与 recorder 一致
            provider, model, COALESCE(tool, 'unknown') as tool,
            COUNT(*) as call_count,
            SUM(total_cost) as total_cost,
            SUM(COALESCE(prompt_tokens, 0)) as prompt_tokens,
            SUM(COALESCE(output_tokens, 0)) as output_tokens,
            SUM(COALESCE(uncached_input, 0)) as uncached_input,
            SUM(COALESCE(cache_read_tokens, 0)) as cache_read_tokens,
            MIN(created_at) as created_at_ms
          FROM calls
          GROUP BY date, provider, model, tool
        `);

        db.run("INSERT OR REPLACE INTO metadata (key, value) VALUES ('schema_version', ?)", ['3']);
        db.run('COMMIT');
        console.log('数据库已升级到 schema v3（新增 daily_stats 统计表，已回填历史数据）');
      } catch (err) {
        db.run('ROLLBACK');
        throw err;
      }
    } catch {
      // 全新库无 daily_stats 表：回填块跳过（Task 6 迁移机制化后移除本层包裹）
    }
  }

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

/** 列出调用记录 */
export function listCalls(sessionId?: number, provider?: string, tool?: string, limit = 50, offset = 0): Record<string, any>[] {
  let sql = 'SELECT c.* FROM calls c';
  const conditions: string[] = [];
  const params: any[] = [];

  if (tool) {
    sql = 'SELECT c.* FROM calls c JOIN sessions s ON c.session_id = s.id';
    conditions.push('s.tool = ?');  // 入参归一化后等值比较（可走索引）
    params.push(normalizeToolName(tool));
  }
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
  if (tool) {
    sql = 'SELECT COUNT(*) AS cnt FROM calls c JOIN sessions s ON c.session_id = s.id';
    conditions.push('s.tool = ?');
    params.push(normalizeToolName(tool));
  }
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
}

// ── Tool Config ──

/** 工具名别名（小写 → 小写规范名）：仅处理内置别名，其余工具名小写即规范 */
const TOOL_ALIASES: Record<string, string> = {
  claude: 'claudecode',
  chatgpt: 'codex',
};

/** 旧迁移 migrateToolCanonicalNames 专用的历史规范名映射（保留 CamelCase 目标，
 *  旧迁移产出中间态规范名，随后由 migrateLowercaseNames 统一转小写） */
const LEGACY_CANONICAL_TOOLS: Record<string, string> = {
  claudecode: 'ClaudeCode',
  claude: 'ClaudeCode',
  codex: 'Codex',
  chatgpt: 'Codex',
};

/** 工具名归一化：小写 + 内置别名（claude→claudecode、chatgpt→codex）。
 *  存储不变量：库中所有工具名为小写，因此无需查表。 */
export function normalizeToolName(tool: string): string {
  if (!tool) return tool;
  const lower = tool.toLowerCase();
  return TOOL_ALIASES[lower] ?? lower;
}

/** 供应商名归一化：统一小写（存储不变量：库中所有供应商名为小写） */
export function normalizeProviderName(provider: string): string {
  if (!provider) return provider;
  return provider.toLowerCase();
}

/** 迁移历史数据：把各表中的旧工具名/供应商名归一化为规范名。
 *  单次执行（metadata 门控），全程事务包裹，失败回滚不留中间状态。
 *  - 工具维度：内置别名（claudecode/claude→ClaudeCode、codex→Codex；chatgpt 为新增别名，
 *    不迁移历史数据以避免劫持同名自定义工具）+ 自定义工具大小写变体（归一到 tool_config 精确名）
 *  - 供应商维度：provider_config 中各供应商名的大小写变体（calls / sessions / tool_config / daily_stats）
 *  - tool_config 主键为 tool：多变体一轮收敛为一行，合并各变体的上游配置
 *  - daily_stats 复合主键 (date, provider, model, tool)：冲突时把旧行累加合并进规范行，否则直接改名 */
export function migrateToolCanonicalNames(): void {
  if (getSetting('tool_canonical_migrated') === '1') return;  // 已迁移 → 跳过
  const d = getDb();
  d.run('BEGIN');
  try {
    // ── 供应商维度第一步：收敛 provider_config 自身的大小写变体行 ──
    // （旧版精确匹配插入可能遗留变体；先收敛可避免后续逐行改名互相覆盖）
    mergeProviderConfigVariants();
    // ── 工具维度：内置别名 ──
    for (const [lower, canonical] of Object.entries(LEGACY_CANONICAL_TOOLS)) {
      if (lower === 'chatgpt') continue;  // 新增别名：历史 'chatgpt' 数据可能是自定义工具，不迁移
      runRaw('UPDATE sessions SET tool = ? WHERE LOWER(tool) = ? AND tool != ?', [canonical, lower, canonical]);
      runRaw('UPDATE calls SET tool = ? WHERE LOWER(tool) = ? AND tool != ?', [canonical, lower, canonical]);
      mergeToolConfigVariants(lower, canonical);
      mergeDailyStatsVariants('tool', lower, canonical);
    }
    // ── 工具维度：自定义工具 — 先收敛 tool_config 变体（确定性取首行），再按收敛后的名字归一各表 ──
    const seenTools = new Set<string>();
    for (const tc of queryAll('SELECT tool FROM tool_config')) {
      const lower = (tc.tool as string).toLowerCase();
      if (LEGACY_CANONICAL_TOOLS[lower] || seenTools.has(lower)) continue;  // 内置别名/已处理的变体跳过
      seenTools.add(lower);
      mergeToolConfigVariants(lower);
      const canonical = queryOne('SELECT tool FROM tool_config WHERE LOWER(tool) = ?', [lower])!.tool as string;
      runRaw('UPDATE sessions SET tool = ? WHERE LOWER(tool) = ? AND tool != ?', [canonical, lower, canonical]);
      runRaw('UPDATE calls SET tool = ? WHERE LOWER(tool) = ? AND tool != ?', [canonical, lower, canonical]);
      mergeDailyStatsVariants('tool', lower, canonical);
    }
    // ── 供应商维度第二步：各表变体归一到 provider_config 精确名 ──
    for (const p of queryAll('SELECT provider FROM provider_config')) {
      const canonical = p.provider as string;
      const lower = canonical.toLowerCase();
      runRaw('UPDATE calls SET provider = ? WHERE LOWER(provider) = ? AND provider != ?', [canonical, lower, canonical]);
      runRaw('UPDATE sessions SET upstream_provider = ? WHERE LOWER(upstream_provider) = ? AND upstream_provider != ?', [canonical, lower, canonical]);
      runRaw('UPDATE tool_config SET upstream_provider = ? WHERE LOWER(upstream_provider) = ? AND upstream_provider != ?', [canonical, lower, canonical]);
      mergePricingProviderVariants(lower, canonical);
      mergeDailyStatsVariants('provider', lower, canonical);
    }
    runRaw("INSERT OR REPLACE INTO metadata (key, value) VALUES ('tool_canonical_migrated', '1')");
    d.run('COMMIT');
    saveDb();
  } catch (err) {
    d.run('ROLLBACK');
    throw err;
  }
}

/** 小写迁移：历史数据全部名称字段（工具/供应商/模型）统一转小写。
 *  单次执行（metadata 门控 lowercase_migrated），事务包裹，失败回滚。
 *  顺序：先合并变体行（各表有 UNIQUE/主键约束，直接 LOWER 可能冲突），再纯小写化。 */
export function migrateLowercaseNames(): void {
  if (getSetting('lowercase_migrated') === '1') return;
  const d = getDb();
  d.run('BEGIN');
  try {
    // ── 1. 变体合并：逐表把仅大小写不同的行收敛为一行 ──
    mergeProviderConfigVariants();
    // tool_config：按小写分组，每组收敛为一行（未命中内置别名时 survivor 取首行）
    const seenTools = new Set<string>();
    for (const tc of queryAll('SELECT tool FROM tool_config')) {
      const lower = (tc.tool as string).toLowerCase();
      if (seenTools.has(lower)) continue;
      seenTools.add(lower);
      mergeToolConfigVariants(lower);
    }
    // pricing：先供应商维度、后模型维度
    for (const p of queryAll('SELECT DISTINCT LOWER(provider) AS lower FROM pricing')) {
      mergePricingProviderVariants(p.lower as string, p.lower as string);
    }
    mergePricingModelVariants();
    // daily_stats：工具 → 供应商 → 模型（后序阶段依赖前序阶段已收敛的行名定位冲突）
    for (const r of queryAll('SELECT DISTINCT LOWER(tool) AS lower FROM daily_stats')) {
      mergeDailyStatsVariants('tool', r.lower as string, r.lower as string);
    }
    for (const r of queryAll('SELECT DISTINCT LOWER(provider) AS lower FROM daily_stats')) {
      mergeDailyStatsVariants('provider', r.lower as string, r.lower as string);
    }
    mergeDailyStatsModelVariants();

    // ── 2. 纯小写化：合并后各约束维度每组只剩一行，改名无冲突 ──
    const updates: Array<[string, string]> = [
      ['provider_config', 'provider'],
      ['tool_config', 'tool'], ['tool_config', 'upstream_provider'], ['tool_config', 'upstream_model'],
      ['sessions', 'tool'], ['sessions', 'upstream_provider'], ['sessions', 'upstream_model'],
      ['calls', 'provider'], ['calls', 'model'], ['calls', 'tool'],
      ['pricing', 'provider'], ['pricing', 'model'],
      ['daily_stats', 'provider'], ['daily_stats', 'model'], ['daily_stats', 'tool'],
    ];
    for (const [table, col] of updates) {
      runRaw(`UPDATE ${table} SET ${col} = LOWER(${col}) WHERE ${col} != LOWER(${col})`);
    }

    runRaw("INSERT OR REPLACE INTO metadata (key, value) VALUES ('lowercase_migrated', '1')");
    d.run('COMMIT');
    saveDb();
  } catch (err) {
    d.run('ROLLBACK');
    throw err;
  }
}

/** provider_config 变体收敛：同一供应商名（大小写不敏感）的多行合并为一行。
 *  规范行选择：内置供应商精确名优先，否则取首行（rowid 最小）；
 *  base_url / base_url_anthropic / api_key 空字段按 rowid 顺序由变体行补齐，enabled 跟随规范行。 */
function mergeProviderConfigVariants(): void {
  const rows = queryAll('SELECT rowid AS rid, provider, base_url, base_url_anthropic, api_key, created_at, updated_at FROM provider_config ORDER BY rowid');
  const groups = new Map<string, Record<string, any>[]>();
  for (const r of rows) {
    const k = (r.provider as string).toLowerCase();
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(r);
  }
  for (const group of groups.values()) {
    if (group.length <= 1) continue;
    const survivor = group.find(r => BUILTIN_PROVIDERS.has(String(r.provider).toLowerCase())) ?? group[0];
    let baseUrl = (survivor.base_url as string) || '';
    let baseUrlAnthropic = (survivor.base_url_anthropic as string) || '';
    let apiKey = (survivor.api_key as string) || '';
    for (const r of group) {
      if (r === survivor) continue;
      baseUrl = baseUrl || (r.base_url as string) || '';
      baseUrlAnthropic = baseUrlAnthropic || (r.base_url_anthropic as string) || '';
      apiKey = apiKey || (r.api_key as string) || '';
    }
    // 时间戳折叠：created_at 取组内最小非零值，updated_at 取组内最大值（全零组回填 0 = 未知）
    const created = Math.min(...group.map(r => Number(r.created_at) || 0).filter(v => v > 0).concat(Infinity));
    const updated = Math.max(...group.map(r => Number(r.updated_at) || 0));
    runRaw('UPDATE provider_config SET base_url = ?, base_url_anthropic = ?, api_key = ?, created_at = ?, updated_at = ? WHERE rowid = ?',
      [baseUrl, baseUrlAnthropic, apiKey, created === Infinity ? 0 : created, updated, survivor.rid]);
    for (const r of group) {
      if (r !== survivor) runRaw('DELETE FROM provider_config WHERE rowid = ?', [r.rid]);
    }
  }
}

/** tool_config 变体收敛：tool 仅大小写不同的多行合并为一行。
 *  规范行选择：preferredCanonical（内置规范名，若存在）优先，否则取首行（rowid 最小）；
 *  upstream_provider / upstream_model 空字段按 rowid 顺序由变体行补齐。
 *  单行且与内置规范名不一致时也改名（历史 'codex' 行 → 'Codex'）。 */
function mergeToolConfigVariants(lower: string, preferredCanonical?: string): void {
  const variants = queryAll('SELECT rowid AS rid, tool, upstream_provider, upstream_model, created_at, updated_at FROM tool_config WHERE LOWER(tool) = ? ORDER BY rowid', [lower]);
  if (variants.length === 0) return;
  if (variants.length === 1) {
    if (preferredCanonical && variants[0].tool !== preferredCanonical) {
      runRaw('UPDATE tool_config SET tool = ? WHERE rowid = ?', [preferredCanonical, variants[0].rid]);
    }
    return;
  }
  const survivor = (preferredCanonical && variants.find(v => v.tool === preferredCanonical)) || variants[0];
  let mergedProvider: string | null = (survivor.upstream_provider as string) || null;
  let mergedModel: string | null = (survivor.upstream_model as string) || null;
  for (const v of variants) {
    if (v === survivor) continue;
    mergedProvider = mergedProvider ?? ((v.upstream_provider as string | null) || null);
    mergedModel = mergedModel ?? ((v.upstream_model as string | null) || null);
  }
  const targetName = preferredCanonical ?? (survivor.tool as string);
  // 时间戳折叠：created_at 取组内最小非零值，updated_at 取组内最大值（全零组回填 0 = 未知）
  const created = Math.min(...variants.map(v => Number(v.created_at) || 0).filter(v => v > 0).concat(Infinity));
  const updated = Math.max(...variants.map(v => Number(v.updated_at) || 0));
  runRaw('UPDATE tool_config SET tool = ?, upstream_provider = ?, upstream_model = ?, created_at = ?, updated_at = ? WHERE rowid = ?',
    [targetName, mergedProvider, mergedModel, created === Infinity ? 0 : created, updated, survivor.rid]);
  for (const v of variants) {
    if (v !== survivor) runRaw('DELETE FROM tool_config WHERE rowid = ?', [v.rid]);
  }
}

/** 折叠一组 (created_at, updated_at) 值：created 取最小非零（全 0 → 0 = 未知），updated 取最大 */
function foldTimestamps(vals: Array<[number, number]>): [number, number] {
  const created = Math.min(...vals.map(([c]) => c || 0).filter(v => v > 0).concat(Infinity));
  const updated = Math.max(...vals.map(([, u]) => u || 0));
  return [created === Infinity ? 0 : created, updated];
}

/** pricing 供应商变体归一：改名到规范名；与规范行同 model+effective_from 冲突时删除变体行（规范行定价优先） */
function mergePricingProviderVariants(lower: string, canonical: string): void {
  const rows = queryAll('SELECT rowid AS rid, model, effective_from, created_at, updated_at FROM pricing WHERE LOWER(provider) = ? AND provider != ?', [lower, canonical]);
  for (const row of rows) {
    const conflict = queryOne('SELECT rowid AS rid, created_at, updated_at FROM pricing WHERE provider = ? AND model = ? AND effective_from IS ?',
      [canonical, row.model, row.effective_from]);
    if (conflict) {
      // 冲突删除前先把变体行时间戳折叠进规范行（created 取最小非零排除 0，updated 取最大）
      const [created, updated] = foldTimestamps([
        [Number(conflict.created_at) || 0, Number(conflict.updated_at) || 0],
        [Number(row.created_at) || 0, Number(row.updated_at) || 0],
      ]);
      runRaw('UPDATE pricing SET created_at = ?, updated_at = ? WHERE rowid = ?',
        [created, updated, conflict.rid]);
      runRaw('DELETE FROM pricing WHERE rowid = ?', [row.rid]);
    } else {
      runRaw('UPDATE pricing SET provider = ? WHERE rowid = ?', [canonical, row.rid]);
    }
  }
}

/** pricing 模型维度变体合并：LOWER(model) 与既有行冲突时删除变体行（规范行优先），否则改名为小写。
 *  与供应商维度策略一致（冲突时时间戳折叠进保留行）。 */
function mergePricingModelVariants(): void {
  const rows = queryAll('SELECT rowid AS rid, provider, model, effective_from, created_at, updated_at FROM pricing WHERE model != LOWER(model)');
  for (const row of rows) {
    const lowerModel = (row.model as string).toLowerCase();
    const conflict = queryOne('SELECT rowid AS rid, created_at, updated_at FROM pricing WHERE provider = ? AND model = ? AND effective_from IS ?',
      [row.provider, lowerModel, row.effective_from]);
    if (conflict) {
      // 冲突删除前先把变体行时间戳折叠进保留行（与供应商维度一致）
      const [created, updated] = foldTimestamps([
        [Number(conflict.created_at) || 0, Number(conflict.updated_at) || 0],
        [Number(row.created_at) || 0, Number(row.updated_at) || 0],
      ]);
      runRaw('UPDATE pricing SET created_at = ?, updated_at = ? WHERE rowid = ?',
        [created, updated, conflict.rid]);
      runRaw('DELETE FROM pricing WHERE rowid = ?', [row.rid]);
    } else {
      runRaw('UPDATE pricing SET model = ? WHERE rowid = ?', [lowerModel, row.rid]);
    }
  }
}

/** daily_stats 变体合并：按指定列（tool / provider）把大小写变体归一到规范名。
 *  复合主键冲突时累加合并进规范行，否则原地改名。 */
function mergeDailyStatsVariants(col: 'tool' | 'provider', lower: string, canonical: string): void {
  const rows = queryAll(`SELECT rowid AS rid, * FROM daily_stats WHERE LOWER(${col}) = ? AND ${col} != ?`, [lower, canonical]);
  for (const row of rows) {
    const conflictProvider = col === 'provider' ? canonical : row.provider;
    const conflictTool = col === 'tool' ? canonical : row.tool;
    const conflict = queryOne(
      'SELECT 1 AS one FROM daily_stats WHERE date = ? AND provider = ? AND model = ? AND tool = ?',
      [row.date, conflictProvider, row.model, conflictTool],
    );
    if (conflict) {
      runRaw(
        `UPDATE daily_stats SET
           call_count = call_count + ?, total_cost = total_cost + ?,
           prompt_tokens = prompt_tokens + ?, output_tokens = output_tokens + ?,
           uncached_input = uncached_input + ?, cache_read_tokens = cache_read_tokens + ?,
           created_at_ms = CASE WHEN created_at_ms = 0 THEN ? ELSE created_at_ms END
         WHERE date = ? AND provider = ? AND model = ? AND tool = ?`,
        [row.call_count, row.total_cost, row.prompt_tokens, row.output_tokens,
         row.uncached_input, row.cache_read_tokens, row.created_at_ms,
         row.date, conflictProvider, row.model, conflictTool],
      );
      runRaw('DELETE FROM daily_stats WHERE rowid = ?', [row.rid]);
    } else {
      runRaw(`UPDATE daily_stats SET ${col} = ? WHERE rowid = ?`, [canonical, row.rid]);
    }
  }
}

/** daily_stats 模型维度变体合并：按复合主键 (date, provider, model, tool) 冲突时累加合并进小写行。
 *  与 mergeDailyStatsVariants 同模式（按单列 model 工作）。 */
function mergeDailyStatsModelVariants(): void {
  const rows = queryAll('SELECT rowid AS rid, * FROM daily_stats WHERE model != LOWER(model)');
  for (const row of rows) {
    const lowerModel = (row.model as string).toLowerCase();
    const conflict = queryOne(
      'SELECT 1 AS one FROM daily_stats WHERE date = ? AND provider = ? AND model = ? AND tool = ?',
      [row.date, row.provider, lowerModel, row.tool],
    );
    if (conflict) {
      runRaw(
        `UPDATE daily_stats SET
           call_count = call_count + ?, total_cost = total_cost + ?,
           prompt_tokens = prompt_tokens + ?, output_tokens = output_tokens + ?,
           uncached_input = uncached_input + ?, cache_read_tokens = cache_read_tokens + ?,
           created_at_ms = CASE WHEN created_at_ms = 0 THEN ? ELSE created_at_ms END
         WHERE date = ? AND provider = ? AND model = ? AND tool = ?`,
        [row.call_count, row.total_cost, row.prompt_tokens, row.output_tokens,
         row.uncached_input, row.cache_read_tokens, row.created_at_ms,
         row.date, row.provider, lowerModel, row.tool],
      );
      runRaw('DELETE FROM daily_stats WHERE rowid = ?', [row.rid]);
    } else {
      runRaw('UPDATE daily_stats SET model = ? WHERE rowid = ?', [lowerModel, row.rid]);
    }
  }
}

/** 列出所有工具配置 */
export function listToolConfigs(): Record<string, any>[] {
  return queryAll('SELECT * FROM tool_config', []);
}

/** 获取单个工具的配置（大小写不敏感） */
export function getToolConfig(tool: string): Record<string, any> | null {
  const row = queryOne('SELECT * FROM tool_config WHERE tool = ?', [tool]);
  if (row) return row;
  return queryOne('SELECT * FROM tool_config WHERE LOWER(tool) = LOWER(?)', [tool]);
}

/** 更新工具级上游配置（upsert，工具名 / 供应商名 / 模型名大小写不敏感归一化） */
export function updateToolConfig(tool: string, upstreamProvider: string | null, upstreamModel: string | null): void {
  const name = normalizeToolName(tool);
  const prov = upstreamProvider ? normalizeProviderName(upstreamProvider) : upstreamProvider;
  const model = upstreamModel ? upstreamModel.toLowerCase() : upstreamModel;
  const now = Date.now();
  execute(
    `INSERT INTO tool_config (tool, upstream_provider, upstream_model, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(tool) DO UPDATE SET upstream_provider = excluded.upstream_provider, upstream_model = excluded.upstream_model, updated_at = excluded.updated_at`,
    [name, prov, model, now, now],
  );
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
  d.run('DELETE FROM daily_stats');
  d.run("DELETE FROM sqlite_sequence WHERE name IN ('calls','sessions','pricing','provider_config','daily_stats')");
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
  provider = normalizeProviderName(provider);
  model = model.toLowerCase();
  const cur = currency || 'CNY';
  const def = isDefault ? 1 : 0;
  // sql.js 不支持 ON CONFLICT，用先查再插入/更新的方式（provider + model 大小写不敏感去重）
  let existing = queryOne(
    'SELECT id, is_default FROM pricing WHERE provider = ? AND model = ? AND effective_from IS NULL',
    [provider, model],
  );
  if (!existing) {
    existing = queryOne(
      'SELECT id, is_default FROM pricing WHERE LOWER(provider) = LOWER(?) AND LOWER(model) = LOWER(?) AND effective_from IS NULL',
      [provider, model],
    );
  }
  if (existing) {
    // 默认条目只更新价格和币种，不覆盖 is_default 标记
    const keepDefault = existing.is_default ? 1 : def;
    execute(
      'UPDATE pricing SET input_price = ?, cache_input_price = ?, output_price = ?, currency = ?, is_default = ?, updated_at = ? WHERE id = ?',
      [inputPrice, cacheInputPrice, outputPrice, cur, keepDefault, Date.now(), existing.id],
    );
    return Number(existing.id);
  }
  const now = Date.now();
  return executeInsert(
    'INSERT INTO pricing (provider, model, input_price, cache_input_price, output_price, currency, is_default, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id',
    [provider, model, inputPrice, cacheInputPrice, outputPrice, cur, def, now, now],
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

/** 内置供应商名称集合（不可删除、不可停用；存储不变量：小写） */
export const BUILTIN_PROVIDERS = new Set(['anthropic', 'openai']);

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
export function getProviderConfig(provider: string): { provider: string; base_url: string; base_url_anthropic: string; api_key: string; enabled: boolean } | null {
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
    enabled: row.enabled === 1,
  };
}

/** 内置供应商检查（大小写不敏感） */
function isBuiltinProvider(provider: string): boolean {
  return [...BUILTIN_PROVIDERS].some(b => b.toLowerCase() === provider.toLowerCase());
}

/** 更新 provider 配置（内置供应商不允许停用；供应商名大小写不敏感定位规范行） */
export function updateProviderConfig(provider: string, data: { enabled?: boolean; api_key?: string; base_url?: string; base_url_anthropic?: string }): { ok: boolean; error?: string } {
  // 内置供应商不允许停用（大小写不敏感）
  if (data.enabled === false && isBuiltinProvider(provider)) {
    return { ok: false, error: `内置供应商 "${provider}" 不可停用` };
  }
  const sets: string[] = [];
  const vals: any[] = [];
  if (data.enabled !== undefined) { sets.push('enabled = ?'); vals.push(data.enabled ? 1 : 0); }
  if (data.api_key !== undefined) { sets.push('api_key = ?'); vals.push(data.api_key); }
  if (data.base_url !== undefined) { sets.push('base_url = ?'); vals.push(data.base_url); }
  if (data.base_url_anthropic !== undefined) { sets.push('base_url_anthropic = ?'); vals.push(data.base_url_anthropic); }
  if (sets.length === 0) return { ok: true };
  sets.push('updated_at = ?'); vals.push(Date.now());
  // 大小写不敏感解析到小写名后按小写名更新（会话覆写存的是小写名，级联清理须一致）
  const canonical = normalizeProviderName(provider);
  vals.push(canonical);
  execute(`UPDATE provider_config SET ${sets.join(', ')} WHERE provider = ?`, vals);
  // 停用时自动清除所有引用该供应商的会话上游覆写（provider + model）
  if (data.enabled === false) {
    const cleared = execute('UPDATE sessions SET upstream_provider = NULL, upstream_model = NULL WHERE upstream_provider = ?', [canonical]);
    if (cleared > 0) {
      console.log(`已清除 ${cleared} 个会话的 "${canonical}" 上游覆写`);
    }
  }
  return { ok: true };
}

/** 新增自定义 provider（大小写不敏感去重：与内置供应商仅大小写不同时提示已存在；既有自定义供应商更新现有行） */
export function addProviderConfig(provider: string, baseUrl: string, baseUrlAnthropic: string, apiKey: string): number {
  const existing = queryOne('SELECT id, provider FROM provider_config WHERE provider = ?', [provider])
    ?? queryOne('SELECT id, provider FROM provider_config WHERE LOWER(provider) = LOWER(?)', [provider]);
  if (existing && isBuiltinProvider(existing.provider as string)) {
    // 内置供应商（大小写不敏感）已存在 → 不允许新增同名供应商，由调用方提示用户
    throw new Error(`供应商已存在：内置供应商 "${existing.provider}" 不可重复添加`);
  }
  if (existing) {
    // 既有自定义供应商 → 更新配置，保持其启用/停用状态（不强制启用）
    execute(
      'UPDATE provider_config SET base_url = ?, base_url_anthropic = ?, api_key = ?, updated_at = ? WHERE id = ?',
      [baseUrl, baseUrlAnthropic, apiKey, Date.now(), existing.id],
    );
    return Number(existing.id);
  }
  // 不存在同名（大小写不敏感）供应商 → 按新供应商插入（供应商名归一化为小写）
  const name = normalizeProviderName(provider);
  const now = Date.now();
  const id = executeInsert(
    'INSERT INTO provider_config (provider, base_url, base_url_anthropic, api_key, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?) RETURNING id',
    [name, baseUrl, baseUrlAnthropic, apiKey, now, now],
  );
  return id;
}

/** 删除 provider 配置（内置供应商不可删除；供应商名大小写不敏感定位规范行） */
export function deleteProviderConfig(provider: string): { ok: boolean; error?: string } {
  if (isBuiltinProvider(provider)) {
    return { ok: false, error: `内置供应商 "${provider}" 不可删除` };
  }
  const canonical = normalizeProviderName(provider);
  execute('DELETE FROM provider_config WHERE provider = ?', [canonical]);
  // 同时清除引用该供应商的会话上游覆写（按小写名匹配）
  const cleared = execute('UPDATE sessions SET upstream_provider = NULL, upstream_model = NULL WHERE upstream_provider = ?', [canonical]);
  if (cleared > 0) {
    console.log(`已清除 ${cleared} 个会话的 "${canonical}" 上游覆写`);
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
