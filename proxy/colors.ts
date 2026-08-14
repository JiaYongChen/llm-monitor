/** 类别颜色注册模块 — 色板种子 + 工具/供应商色位注册 + 启动迁移 */
import { getDb, queryAll, saveDb, getSetting } from './db.js';
import { normalizeToolName, normalizeProviderName } from './db.js';
import type { Database } from 'sql.js';

/** 色板主题（本期仅 light；未来暗色主题插入同色位的变体行） */
export const PALETTE_THEME = 'light';

/** light 主题 32 色种子（前 10 为 d3 Tableau 10，其余 colorbrewer Dark2/Set1/Accent/Paired 精选，均为中等明度） */
export const PALETTE_COLORS: string[] = [
  '#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd', '#8c564b', '#e377c2', '#7f7f7f',
  '#bcbd22', '#17becf', '#1b9e77', '#d95f02', '#7570b3', '#e7298a', '#66a61e', '#e6ab02',
  '#a6761d', '#666666', '#386cb0', '#984ea3', '#4daf4a', '#a65628', '#f781bf', '#bf5b17',
  '#8dd3c7', '#fb8072', '#80b1d3', '#fdb462', '#b3de69', '#bebada', '#e41a1c', '#999999',
];

/** 色板长度（注册循环与前端兜底共用） */
export const PALETTE_SIZE = PALETTE_COLORS.length;

/** 局部查询辅助（db.ts 的 queryOne 未导出） */
function queryOne(sql: string, params?: any[]): Record<string, any> | null {
  const d = getDb();
  const stmt = d.prepare(sql);
  if (params) stmt.bind(params);
  let result: Record<string, any> | null = null;
  if (stmt.step()) result = stmt.getAsObject();
  stmt.free();
  return result;
}

/** 种入色板：该主题无数据时插入 PALETTE_COLORS（幂等） */
export function seedPalette(): void {
  const d = getDb();
  const count = Number(queryOne('SELECT COUNT(*) AS c FROM color_palette WHERE theme = ?', [PALETTE_THEME])?.c) || 0;
  if (count > 0) return;
  PALETTE_COLORS.forEach((color, i) => {
    d.run('INSERT INTO color_palette (theme, idx, color) VALUES (?, ?, ?)', [PALETTE_THEME, i, color]);
  });
  saveDb();
}

/** 该 kind 已占用的色位集合中找最小未占 idx；全占（32 个）则循环复用 idx0 */
function nextFreeIdx(d: Database, kind: string): number {
  const used = new Set(
    queryAll('SELECT color_idx FROM category_colors WHERE kind = ?', [kind]).map(r => Number(r.color_idx)),
  );
  for (let i = 0; i < PALETTE_SIZE; i++) {
    if (!used.has(i)) return i;
  }
  return 0;
}

/** 注册工具/供应商色位：已注册幂等返回；新类别分配最小未占色位并持久化。
 *  名称内部归一化（tool → normalizeToolName、provider → normalizeProviderName），存储不变量小写。 */
export function registerCategoryColor(kind: 'tool' | 'provider', name: string): number {
  const normalized = kind === 'tool' ? normalizeToolName(name) : normalizeProviderName(name);
  if (!normalized) return -1;
  const existing = queryOne('SELECT color_idx FROM category_colors WHERE kind = ? AND name = ?', [kind, normalized]);
  if (existing) return Number(existing.color_idx);
  const d = getDb();
  const idx = nextFreeIdx(d, kind);
  d.run('INSERT INTO category_colors (kind, name, color_idx, created_at) VALUES (?, ?, ?, ?)', [kind, normalized, idx, Date.now()]);
  saveDb();
  return idx;
}

/** 内置类别固定色位（与注册池无关的静态约定）：tool 池 codex→0、claudecode→1；provider 池 openai→0、anthropic→1 */
const BUILTIN_COLOR_IDX: Array<[kind: 'tool' | 'provider', name: string, idx: number]> = [
  ['tool', 'codex', 0],
  ['tool', 'claudecode', 1],
  ['provider', 'openai', 0],
  ['provider', 'anthropic', 1],
];

/** 事务内插入（INSERT OR IGNORE：内置固定色位不覆盖已有注册） */
function insertInTx(d: Database, kind: string, name: string, idx: number): void {
  d.run('INSERT OR IGNORE INTO category_colors (kind, name, color_idx, created_at) VALUES (?, ?, ?, ?)', [kind, name, idx, Date.now()]);
}

/** 收集名称（跳过空值与 'unknown'——未识别工具不占色位） */
function addName(set: Set<string>, name: unknown): void {
  if (name && name !== 'unknown') set.add(String(name));
}

/** 启动迁移：内置固定色位 + 历史名称字母序注册。单次执行（metadata 门控 colors_migrated），
 *  事务包裹失败回滚。扫描五表（calls/sessions/daily_stats/tool_config/provider_config）收集已出现名称。 */
export function migrateCategoryColors(): void {
  if (getSetting('colors_migrated') === '1') return;
  const d = getDb();
  d.run('BEGIN');
  try {
    // 1. 内置类别固定色位
    for (const [kind, name, idx] of BUILTIN_COLOR_IDX) {
      insertInTx(d, kind, name, idx);
    }
    // 2. 五表扫描收集（名称已由既往迁移统一小写）
    const tools = new Set<string>();
    const providers = new Set<string>();
    for (const r of queryAll('SELECT DISTINCT tool AS name FROM sessions')) addName(tools, r.name);
    for (const r of queryAll('SELECT DISTINCT tool AS name FROM calls')) addName(tools, r.name);
    for (const r of queryAll('SELECT DISTINCT tool AS name FROM daily_stats')) addName(tools, r.name);
    for (const r of queryAll('SELECT DISTINCT tool AS name FROM tool_config')) addName(tools, r.name);
    for (const r of queryAll('SELECT DISTINCT provider AS name FROM provider_config')) addName(providers, r.name);
    for (const r of queryAll('SELECT DISTINCT provider AS name FROM calls')) addName(providers, r.name);
    for (const r of queryAll('SELECT DISTINCT provider AS name FROM daily_stats')) addName(providers, r.name);
    for (const r of queryAll('SELECT DISTINCT upstream_provider AS name FROM sessions')) addName(providers, r.name);
    for (const r of queryAll('SELECT DISTINCT upstream_provider AS name FROM tool_config')) addName(providers, r.name);
    for (const r of queryAll('SELECT DISTINCT provider AS name FROM pricing')) addName(providers, r.name);
    // 3. 其余名称按字母序注册（最小空位）
    for (const name of [...tools].sort((a, b) => a.localeCompare(b))) {
      if (!queryOne('SELECT 1 AS one FROM category_colors WHERE kind = ? AND name = ?', ['tool', name])) {
        insertInTx(d, 'tool', name, nextFreeIdx(d, 'tool'));
      }
    }
    for (const name of [...providers].sort((a, b) => a.localeCompare(b))) {
      if (!queryOne('SELECT 1 AS one FROM category_colors WHERE kind = ? AND name = ?', ['provider', name])) {
        insertInTx(d, 'provider', name, nextFreeIdx(d, 'provider'));
      }
    }
    d.run("INSERT OR REPLACE INTO metadata (key, value) VALUES ('colors_migrated', '1')");
    d.run('COMMIT');
    saveDb();
  } catch (err) {
    d.run('ROLLBACK');
    throw err;
  }
}
