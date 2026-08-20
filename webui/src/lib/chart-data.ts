/** 图表数据纯函数 — 类别宽表透视 / 类别排序（DailyChartsPanel 共用） */
import { fillDateRange } from './dates';

/** 每日统计数据行（与后端 /api/stats/daily 返回一致） */
export interface DailyData {
  date: string;
  /** 分组类别字段（后端 group_by 时返回），旧数据回退 model */
  category?: string;
  model?: string;
  count: number;
  total_cost: number;
  total_output_tokens: number;
  total_uncached_input: number;
  total_cache_read_tokens: number;
}

/** 类别宽表行：date 键 + 各类别名键存总量 */
export type CategoryWideRow = Record<string, any>;

/** 类别名（优先 category 字段，回退旧 model 字段） */
export function getCategory(d: DailyData): string {
  return d.category || d.model || '';
}

/** 类别去重列表（数据行首现顺序 = 后端返回顺序） */
export function listCategories(categoryData: DailyData[]): string[] {
  return [...new Set(categoryData.map(getCategory).filter(Boolean))];
}

/** 构建类别宽表：补全日期 + 按类别透视（两个堆叠分布图共用，valueOf 决定取值指标） */
export function buildCategoryRows(
  categoryData: DailyData[],
  range: string,
  tz: number,
  valueOf: (d: DailyData) => number,
): CategoryWideRow[] {
  const byDate = new Map<string, Record<string, number>>();
  for (const d of categoryData) {
    const cat = getCategory(d);
    if (!cat) continue;
    let row = byDate.get(d.date);
    if (!row) { row = {}; byDate.set(d.date, row); }
    row[cat] = (row[cat] || 0) + valueOf(d);
  }
  const categories = listCategories(categoryData);
  return fillDateRange(range, tz).map(date => {
    const entry = byDate.get(date) || {};
    const row: CategoryWideRow = { date };
    for (const c of categories) row[c] = entry[c] || 0;
    return row;
  });
}

/** 堆叠顺序（Bar 声明序，小值在柱底）：model 维度按字母序（与色板取色对应）；
 *  tool/provider 维度按指标总量升序 */
export function stackOrder(
  categories: string[],
  categoryData: DailyData[],
  categoryKind: 'tool' | 'provider' | 'model',
  valueOf: (d: DailyData) => number,
): string[] {
  if (categoryKind === 'model') return [...categories].sort((a, b) => a.localeCompare(b));
  const totals = new Map<string, number>();
  for (const d of categoryData) {
    const cat = getCategory(d);
    if (cat) totals.set(cat, (totals.get(cat) || 0) + valueOf(d));
  }
  return [...categories].sort((a, b) => (totals.get(a) || 0) - (totals.get(b) || 0));
}
