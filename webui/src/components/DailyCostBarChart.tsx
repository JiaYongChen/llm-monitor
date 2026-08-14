import { useMemo } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { useCurrency, formatCost } from '../lib/currency';
import { fillDateRange, fmtXAxis } from '../lib/dates';
import ChartTooltip, { DashedCursor } from './ChartTooltip';
import { displayName } from '../lib/display';
import { sortByPresetOrder } from '../lib/utils';
import { useCategoryColors, buildCategoryColorMap, type CategoryKind } from '../lib/colors';

interface DailyCostRow {
  date: string;
  category?: string;
  total_cost: number;
}

export default function DailyCostBarChart({ data, range, tz, categoryKind = 'model' }: { data: DailyCostRow[]; range: string; tz: number; categoryKind?: CategoryKind }) {
  const { currency, rates } = useCurrency();
  // 短范围（today/yesterday）后端返回小时标签，X 轴按 HH:00 展示；其余范围按天（MM-DD）
  const isHourly = range === 'today' || range === 'yesterday';

  // 按 category 和 date 组织数据 → 宽表格式：{ date, CatA: cost, CatB: cost, ... }
  const chartData = useMemo(() => {
    // 先用 || '' 兜底再 filter：filter(Boolean) 无类型收窄能力，直接 map 会残留 undefined 推断
    const categories = [...new Set(data.map(d => d.category || '').filter(Boolean))];
    const byDate = new Map<string, Record<string, number>>();
    for (const d of data) {
      if (!d.category) continue;
      let row = byDate.get(d.date);
      if (!row) { row = {}; byDate.set(d.date, row); }
      row[d.category] = (row[d.category] || 0) + d.total_cost;
    }
    // 按总费用升序排列（小值在柱状底部）
    const catTotals = new Map<string, number>();
    for (const d of data) {
      if (!d.category) continue;
      catTotals.set(d.category, (catTotals.get(d.category) || 0) + d.total_cost);
    }
    categories.sort((a, b) => (catTotals.get(a) || 0) - (catTotals.get(b) || 0));
    const dates = fillDateRange(range, tz);
    return {
      categories,
      rows: dates.map(date => {
        const entry = byDate.get(date) || {};
        const row: any = { date };
        for (const cat of categories) row[cat] = entry[cat] || 0;
        return row;
      }),
    };
  }, [data, range, tz]);

  const hasData = chartData.rows.some(r =>
    chartData.categories.some(cat => (r[cat] || 0) > 0)
  );

  const { data: colors } = useCategoryColors();
  // 类别 → 颜色：tool/provider 由注册表决定（跨图表一致），model 与未注册类别取名称哈希确定性色
  const colorMap = useMemo(
    () => (colors ? buildCategoryColorMap(chartData.categories, categoryKind, colors) : new Map<string, string>()),
    [chartData.categories, categoryKind, colors],
  );

  if (!hasData) return (
    <p className="text-sm text-gray-500 text-center py-8">暂无数据</p>
  );

  // 颜色注册数据未就绪时不渲染分布图，避免柱段/图例以默认色渲染后在数据到达时整体跳变
  if (!colors) return (
    <p className="text-sm text-gray-500 text-center py-8">加载颜色数据中…</p>
  );

  return (
    <ResponsiveContainer width="100%" height={300}>
      <BarChart data={chartData.rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barCategoryGap="10%">
        <CartesianGrid strokeDasharray="3 3" stroke="#e5e5ea" vertical={false} />
        <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#aeaeb2' }} tickFormatter={(d: string) => fmtXAxis(d, isHourly)} axisLine={{ stroke: '#e5e5ea' }} tickLine={false} />
        <YAxis tick={{ fontSize: 10, fill: '#aeaeb2' }} tickFormatter={(v: number) => formatCost(v, currency, rates)} axisLine={false} tickLine={false} />
        <Tooltip cursor={<DashedCursor />} content={<ChartTooltip formatValue={(v) => formatCost(v, currency, rates)} />} />
        <Legend
          wrapperStyle={{ fontSize: 12 }}
          payload={sortByPresetOrder(chartData.categories).map(cat => ({
            // 图例按固定预设序排列；颜色由类别名唯一决定，与柱段取色一致
            id: cat, value: displayName(cat), type: 'rect' as const, color: colorMap.get(cat),
          }))}
        />
        {chartData.categories.map(cat => (
          <Bar key={cat} dataKey={cat} name={displayName(cat)} fill={colorMap.get(cat)} stackId="cost" />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}
