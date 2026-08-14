/** 类别颜色注册模块 — 色板种子 + 工具/供应商色位注册 + 启动迁移 */
import { getDb, queryAll, queryOne, saveDb, getSetting } from './db.js';
import { normalizeToolName, normalizeProviderName } from './db.js';
import { hashString } from '../shared/hash.js';
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

// ── 注册缓存：recorder 每条记录都会调用 registerCategoryColor，内存 Map 门控避免每次查库（sql.js 每次重新编译 SQL）──

/** 已注册类别缓存（key = `${kind}:${name}` → color_idx），null 表示未初始化 */
let registryCache: Map<string, number> | null = null;

function cacheKey(kind: string, name: string): string {
  return `${kind}:${name}`;
}

/** 从注册表全量加载缓存（首次调用与迁移完成后重建） */
function ensureRegistryCache(): Map<string, number> {
  if (!registryCache) {
    registryCache = new Map(
      queryAll('SELECT kind, name, color_idx FROM category_colors')
        .map(r => [cacheKey(String(r.kind), String(r.name)), Number(r.color_idx)]),
    );
  }
  return registryCache;
}

/** 失效缓存（迁移重置注册表时调用；下次注册时自动重建） */
function invalidateRegistryCache(): void {
  registryCache = null;
}

/** 该 kind 已占用的色位集合中找最小未占 idx；全占（32 个）则按名称哈希映射到 [2,31]，
 *  避开内置锚点 codex/openai(0) 与 claudecode/anthropic(1)——池满属于极端情况，但撞色不应撞到最高可见度类别。 */
function nextFreeIdx(kind: string, name: string): number {
  const used = new Set(
    queryAll('SELECT color_idx FROM category_colors WHERE kind = ?', [kind]).map(r => Number(r.color_idx)),
  );
  for (let i = 0; i < PALETTE_SIZE; i++) {
    if (!used.has(i)) return i;
  }
  return 2 + (hashString(name) % (PALETTE_SIZE - 2));
}

/** 注册工具/供应商色位：已注册幂等返回；新类别分配最小未占色位并持久化。
 *  名称内部归一化（tool → normalizeToolName、provider → normalizeProviderName），存储不变量小写；
 *  空名与 'unknown'（未识别类别）不注册，返回 -1。 */
export function registerCategoryColor(kind: 'tool' | 'provider', name: string): number {
  const normalized = kind === 'tool' ? normalizeToolName(name) : normalizeProviderName(name);
  if (!normalized || normalized === 'unknown') return -1;
  const cache = ensureRegistryCache();
  const key = cacheKey(kind, normalized);
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const d = getDb();
  const idx = nextFreeIdx(kind, normalized);
  d.run('INSERT INTO category_colors (kind, name, color_idx, created_at) VALUES (?, ?, ?, ?)', [kind, normalized, idx, Date.now()]);
  cache.set(key, idx);
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

/** 收集名称并归一化（与运行期 registerCategoryColor 同规则）：跳过空值、'unknown' 与归一化后为空的名字。
 *  归一化保证历史遗留名（如 'chatgpt' → 'codex'、大小写变体）不会注册为独立死类别占色位——
 *  即使前序名称迁移降级失败，混合大小写名也在此统一为小写。 */
function addName(set: Set<string>, name: unknown, kind: 'tool' | 'provider'): void {
  if (!name) return;
  const normalized = kind === 'tool' ? normalizeToolName(String(name)) : normalizeProviderName(String(name));
  if (normalized && normalized !== 'unknown') set.add(normalized);
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
    // 2. 五表扫描收集（归一化与运行期注册一致；名称已由既往迁移统一小写，此处归一化作级联失败防御）
    const tools = new Set<string>();
    const providers = new Set<string>();
    for (const r of queryAll('SELECT DISTINCT tool AS name FROM sessions')) addName(tools, r.name, 'tool');
    for (const r of queryAll('SELECT DISTINCT tool AS name FROM calls')) addName(tools, r.name, 'tool');
    for (const r of queryAll('SELECT DISTINCT tool AS name FROM daily_stats')) addName(tools, r.name, 'tool');
    for (const r of queryAll('SELECT DISTINCT tool AS name FROM tool_config')) addName(tools, r.name, 'tool');
    for (const r of queryAll('SELECT DISTINCT provider AS name FROM provider_config')) addName(providers, r.name, 'provider');
    for (const r of queryAll('SELECT DISTINCT provider AS name FROM calls')) addName(providers, r.name, 'provider');
    for (const r of queryAll('SELECT DISTINCT provider AS name FROM daily_stats')) addName(providers, r.name, 'provider');
    for (const r of queryAll('SELECT DISTINCT upstream_provider AS name FROM sessions')) addName(providers, r.name, 'provider');
    for (const r of queryAll('SELECT DISTINCT upstream_provider AS name FROM tool_config')) addName(providers, r.name, 'provider');
    for (const r of queryAll('SELECT DISTINCT provider AS name FROM pricing')) addName(providers, r.name, 'provider');
    // 3. 其余名称按字母序注册（最小空位）
    for (const name of [...tools].sort((a, b) => a.localeCompare(b))) {
      if (!queryOne('SELECT 1 AS one FROM category_colors WHERE kind = ? AND name = ?', ['tool', name])) {
        insertInTx(d, 'tool', name, nextFreeIdx('tool', name));
      }
    }
    for (const name of [...providers].sort((a, b) => a.localeCompare(b))) {
      if (!queryOne('SELECT 1 AS one FROM category_colors WHERE kind = ? AND name = ?', ['provider', name])) {
        insertInTx(d, 'provider', name, nextFreeIdx('provider', name));
      }
    }
    d.run("INSERT OR REPLACE INTO metadata (key, value) VALUES ('colors_migrated', '1')");
    d.run('COMMIT');
    invalidateRegistryCache(); // 注册表已重建，缓存必须同步失效
    saveDb();
  } catch (err) {
    d.run('ROLLBACK');
    throw err;
  }
}

/** 查询颜色注册数据：色板（light 主题）+ 工具/供应商两池注册表（name → 色位）。
 *  注册表用无原型对象承载任意类别名（防 '__proto__' 等特殊名被原型访问器吞掉）；
 *  色板表为空时兜底返回种子常量（seed 失败降级后查询仍可用，前端不会拿到空色板退化同色）。 */
export function getCategoryColors(): { palette: { idx: number; color: string }[]; tools: Record<string, number>; providers: Record<string, number> } {
  const rows = queryAll('SELECT idx, color FROM color_palette WHERE theme = ? ORDER BY idx', [PALETTE_THEME]);
  const palette = (rows.length > 0 ? rows : PALETTE_COLORS.map((color, idx) => ({ idx, color })))
    .map(r => ({ idx: Number(r.idx), color: String(r.color) }));
  const tools: Record<string, number> = Object.create(null);
  const providers: Record<string, number> = Object.create(null);
  for (const r of queryAll('SELECT kind, name, color_idx FROM category_colors ORDER BY id')) {
    const idx = Number(r.color_idx);
    if (r.kind === 'tool') tools[String(r.name)] = idx;
    else providers[String(r.name)] = idx;
  }
  return { palette, tools, providers };
}
