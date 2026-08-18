/** 类别颜色注册模块 — 色板种子 + 工具/供应商色位注册 + 内置固定色位初始化 */
import { getDb, queryAll, queryOne, saveDb } from './db.js';
import { normalizeToolName, normalizeProviderName } from './db.js';
import { hashString } from '../shared/hash.js';
import type { Database } from 'sql.js';

/** 色板主题（本期仅 light；未来暗色主题插入同色位的变体行） */
export const PALETTE_THEME = 'light';

/** light 主题 32 色种子（前 10 为 d3 Tableau 10，其余 colorbrewer Dark2/Set1/Accent/Paired 精选，均为中等明度）。
 *  前两位为 #ff7f0e/#1f77b4（交换自 Tableau 10 原始顺序）：模型柱状图顺序取色以橙为首；
 *  内置锚点色位已随交换补偿（见 BUILTIN_COLOR_IDX 与 registerBuiltinCategoryColors），类别显示色不受影响。 */
export const PALETTE_COLORS: string[] = [
  '#ff7f0e', '#1f77b4', '#2ca02c', '#d62728', '#9467bd', '#8c564b', '#e377c2', '#7f7f7f',
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

/** 从注册表全量加载缓存（首次调用时重建；此后增量更新） */
function ensureRegistryCache(): Map<string, number> {
  if (!registryCache) {
    registryCache = new Map(
      queryAll('SELECT kind, name, color_idx FROM category_colors')
        .map(r => [cacheKey(String(r.kind), String(r.name)), Number(r.color_idx)]),
    );
  }
  return registryCache;
}

/** 该 kind 已占用的色位集合中找最小未占 idx；全占（32 个）则按名称哈希映射到 [2,31]，
 *  避开内置锚点 claudecode/anthropic(0) 与 codex/openai(1)——池满属于极端情况，但撞色不应撞到最高可见度类别。 */
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

/** 内置类别固定色位（与注册池无关的静态约定）：tool 池 claudecode→0、codex→1；provider 池 anthropic→0、openai→1。
 *  色板 0/1 两位交换后（#ff7f0e 在前）锚点随之互换，保证内置类别显示色与交换前一致（claudecode/anthropic 橙、codex/openai 蓝）。 */
const BUILTIN_COLOR_IDX: Array<[kind: 'tool' | 'provider', name: string, idx: number]> = [
  ['tool', 'claudecode', 0],
  ['tool', 'codex', 1],
  ['provider', 'anthropic', 0],
  ['provider', 'openai', 1],
];

/** 内置固定色位插入（INSERT OR IGNORE：不覆盖已有注册，幂等） */
function insertInTx(d: Database, kind: string, name: string, idx: number): void {
  d.run('INSERT OR IGNORE INTO category_colors (kind, name, color_idx, created_at) VALUES (?, ?, ?, ?)', [kind, name, idx, Date.now()]);
}

/** 内置类别固定色位初始化（幂等，每次启动执行）：保证内置工具/供应商显示色与历史一致。
 *  历史名称色位由运行期 registerCategoryColor 按最小空位注册（insertInTx 的 IGNORE 语义保证不覆盖）。 */
export function registerBuiltinCategoryColors(): void {
  const d = getDb();
  for (const [kind, name, idx] of BUILTIN_COLOR_IDX) {
    insertInTx(d, kind, name, idx);
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
