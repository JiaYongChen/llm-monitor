/** 数据库迁移 — 迁移列表（v2/v3 收编 + v4）+ 历史名称归一化迁移
 *  依赖 db-core（queryAll/queryOne/runRaw/getDb/saveDb/getCurrentDbPath），不依赖 db.ts，避免循环。 */
import type { Database } from 'sql.js';
import { existsSync, copyFileSync } from 'node:fs';
import { queryAll, queryOne, runRaw, getDb, saveDb, getCurrentDbPath } from './db-core.js';

/** 内置供应商名称集合（不可删除、不可停用；存储不变量：小写） */
export const BUILTIN_PROVIDERS = new Set(['anthropic', 'openai']);

/** 单条迁移 */
export interface Migration { version: number; name: string; up: (d: Database) => void; }

/** 迁移列表：按 version 升序；仅老库升级路径执行，全新库各迁移对空库均为 no-op */
export const migrations: Migration[] = [
  { version: 2, name: '时间戳格式重建', up: migrateToV2 },
  { version: 3, name: 'daily_stats 回填（历史兼容）', up: migrateToV3 },
  { version: 4, name: 'hourly_stats 替换 daily_stats', up: migrateToV4 },
];

/** 依次执行未应用的迁移（事务包裹 + 版本递增落 metadata），返回最终版本 */
export function runMigrations(currentVersion: number): number {
  const d = getDb();
  let v = currentVersion;
  for (const m of migrations) {
    if (v >= m.version) continue;
    d.run('BEGIN');
    try {
      m.up(d);
      d.run("INSERT OR REPLACE INTO metadata (key, value) VALUES ('schema_version', ?)", [String(m.version)]);
      d.run('COMMIT');
      v = m.version;
      console.log(`数据库已升级到 schema v${m.version}（${m.name}）`);
    } catch (err) {
      d.run('ROLLBACK');
      throw err;
    }
  }
  return v;
}

/** v1 → v2：时间戳格式变更，重建 calls/sessions（原 initDb 内联块移动：
 *  备份 → DROP 旧表 → 重建新结构表；版本写入由 runMigrations 统一）。
 *  重建为原逻辑的必要组成（原 initDb 在 DROP 后由建表块重建新结构）——
 *  迁移机制化后重建移入本函数，保证 v1 老库与全新库路径的表都完整。 */
function migrateToV2(d: Database): void {
  // 迁移前备份：复制数据库文件以防数据丢失
  const path = getCurrentDbPath();
  const backupPath = path.replace(/\.db$/, `.v1-backup.db`);
  try {
    if (existsSync(path)) {
      saveDb();
      copyFileSync(path, backupPath);
      console.log(`数据库升级前已备份到: ${backupPath}`);
    }
  } catch (e) {
    console.warn('数据库备份失败，仍将执行迁移:', e);
  }
  d.run('DROP TABLE IF EXISTS calls');
  d.run('DROP TABLE IF EXISTS sessions');
  // 重建最新结构（含后续 ALTER 补充的列；v1 老库的 ALTER 已在旧表上执行过，重建后不再补列）
  d.run(`
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
      created_at INTEGER NOT NULL,
      target_url TEXT,
      source_ip TEXT,
      downstream_url TEXT
    )
  `);
  d.run(`
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
      upstream_provider TEXT,
      upstream_model TEXT
    )
  `);
  console.log('数据库已升级到 schema v2（时间戳格式），旧数据已备份');
}

/** v2 → v3：从 calls 表回填已有数据到 daily_stats（仅首次升级执行）。
 *  原 initDb 尾部块移动；v2 老库无 daily_stats 表（该表由 v3 引入），
 *  故先防御性建表再回填（v4 中该表被 DROP，不残留）。
 *  使用 INSERT OR IGNORE + 事务包装确保幂等：升级中断后重启不会触发主键冲突（事务由 runMigrations 提供）。 */
function migrateToV3(d: Database): void {
  d.run(`
    CREATE TABLE IF NOT EXISTS daily_stats (
      date TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, tool TEXT NOT NULL,
      call_count INTEGER NOT NULL DEFAULT 0, total_cost REAL NOT NULL DEFAULT 0,
      prompt_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
      uncached_input INTEGER NOT NULL DEFAULT 0, cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      created_at_ms INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (date, provider, model, tool)
    )
  `);
  d.run(`
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
  console.log('数据库已升级到 schema v3（新增 daily_stats 统计表，已回填历史数据）');
}

/** v4：建 hourly_stats（防御 IF NOT EXISTS）→ 从 calls 回填 → tool 列回填 → DROP daily_stats */
function migrateToV4(d: Database): void {
  d.run(`
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
  d.run('CREATE INDEX IF NOT EXISTS idx_hourly_provider ON hourly_stats(provider)');
  // 回填：hour_ms = 整数除法取小时边界；created_at 取组内最早、updated_at 取组内最晚
  d.run(`
    INSERT OR IGNORE INTO hourly_stats (hour_ms, provider, model, tool, call_count, total_cost, prompt_tokens, output_tokens, uncached_input, cache_read_tokens, created_at, updated_at)
    SELECT
      (created_at / 3600000) * 3600000 AS hour_ms,
      provider, model, COALESCE(tool, 'unknown') AS tool,
      COUNT(*) AS call_count,
      SUM(total_cost) AS total_cost,
      SUM(COALESCE(prompt_tokens, 0)) AS prompt_tokens,
      SUM(COALESCE(output_tokens, 0)) AS output_tokens,
      SUM(COALESCE(uncached_input, 0)) AS uncached_input,
      SUM(COALESCE(cache_read_tokens, 0)) AS cache_read_tokens,
      MIN(created_at) AS created_at,
      MAX(created_at) AS updated_at
    FROM calls
    GROUP BY hour_ms, provider, model, tool
  `);
  // tool 列回填：历史 NULL 从 sessions 补齐（为 listCalls 去 JOIN 铺路）
  d.run('UPDATE calls SET tool = (SELECT s.tool FROM sessions s WHERE s.id = calls.session_id) WHERE tool IS NULL');
  d.run('DROP TABLE IF EXISTS daily_stats');
}

/** 旧迁移 migrateToolCanonicalNames 专用的历史规范名映射（保留 CamelCase 目标，
 *  旧迁移产出中间态规范名，随后由 migrateLowercaseNames 统一转小写） */
const LEGACY_CANONICAL_TOOLS: Record<string, string> = {
  claudecode: 'ClaudeCode',
  claude: 'ClaudeCode',
  codex: 'Codex',
  chatgpt: 'Codex',
};

/** 迁移历史数据：把各表中的旧工具名/供应商名归一化为规范名。
 *  单次执行（metadata 门控），全程事务包裹，失败回滚不留中间状态。
 *  - 工具维度：内置别名（claudecode/claude→ClaudeCode、codex→Codex；chatgpt 为新增别名，
 *    不迁移历史数据以避免劫持同名自定义工具）+ 自定义工具大小写变体（归一到 tool_config 精确名）
 *  - 供应商维度：provider_config 中各供应商名的大小写变体（calls / sessions / tool_config）
 *  - tool_config 主键为 tool：多变体一轮收敛为一行，合并各变体的上游配置 */
export function migrateToolCanonicalNames(): void {
  const gated = queryOne("SELECT value FROM metadata WHERE key = ?", ['tool_canonical_migrated']);
  if (gated?.value === '1') return;  // 已迁移 → 跳过
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
    }
    // ── 供应商维度第二步：各表变体归一到 provider_config 精确名 ──
    for (const p of queryAll('SELECT provider FROM provider_config')) {
      const canonical = p.provider as string;
      const lower = canonical.toLowerCase();
      runRaw('UPDATE calls SET provider = ? WHERE LOWER(provider) = ? AND provider != ?', [canonical, lower, canonical]);
      runRaw('UPDATE sessions SET upstream_provider = ? WHERE LOWER(upstream_provider) = ? AND upstream_provider != ?', [canonical, lower, canonical]);
      runRaw('UPDATE tool_config SET upstream_provider = ? WHERE LOWER(upstream_provider) = ? AND upstream_provider != ?', [canonical, lower, canonical]);
      mergePricingProviderVariants(lower, canonical);
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
  const gated = queryOne("SELECT value FROM metadata WHERE key = ?", ['lowercase_migrated']);
  if (gated?.value === '1') return;
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

    // ── 2. 纯小写化：合并后各约束维度每组只剩一行，改名无冲突 ──
    const updates: Array<[string, string]> = [
      ['provider_config', 'provider'],
      ['tool_config', 'tool'], ['tool_config', 'upstream_provider'], ['tool_config', 'upstream_model'],
      ['sessions', 'tool'], ['sessions', 'upstream_provider'], ['sessions', 'upstream_model'],
      ['calls', 'provider'], ['calls', 'model'], ['calls', 'tool'],
      ['pricing', 'provider'], ['pricing', 'model'],
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
