import { useMemo } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { useCurrency, formatCost } from '../lib/currency';
import { fillDateRange, fmtXAxis } from '../lib/dates';
import ChartTooltip, { DashedCursor } from './ChartTooltip';
import { displayName } from '../lib/display';

const CATEGORY_COLORS = ['#6366f1', '#f59e0b', '#10b981', '#ef4444', '#8b5cf6', '#06b6d4', '#f97316', '#84cc16', '#ec4899', '#14b8a6'];

interface DailyCostRow {
  date: string;
  category?: string;
  total_cost: number;
}

export default function DailyCostBarChart({ data, range, tz, groupBy }: { data: DailyCostRow[]; range: string; tz: number; groupBy?: string }) {
  const { currency, rates } = useCurrency();
  // daily_stats 为天级粒度，today/yesterday 与其余 range 一样按天渲染（X 轴显示 MM-DD）

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

  if (!hasData) return (
    <p className="text-sm text-gray-500 text-center py-8">暂无数据</p>
  );

  return (
    <ResponsiveContainer width="100%" height={300}>
      <BarChart data={chartData.rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barCategoryGap="10%">
        <CartesianGrid strokeDasharray="3 3" stroke="#e5e5ea" vertical={false} />
        <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#aeaeb2' }} tickFormatter={(d: string) => fmtXAxis(d)} axisLine={{ stroke: '#e5e5ea' }} tickLine={false} />
        <YAxis tick={{ fontSize: 10, fill: '#aeaeb2' }} tickFormatter={(v: number) => formatCost(v, currency, rates)} axisLine={false} tickLine={false} />
        <Tooltip cursor={<DashedCursor />} content={<ChartTooltip formatValue={(v) => formatCost(v, currency, rates)} />} />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        {chartData.categories.map((cat, i) => (
          <Bar key={cat} dataKey={cat} name={displayName(cat)} fill={CATEGORY_COLORS[i % CATEGORY_COLORS.length]} stackId="cost" />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}
