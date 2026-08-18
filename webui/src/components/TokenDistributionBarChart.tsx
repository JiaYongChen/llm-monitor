import { useMemo } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { fillDateRange, fmtXAxis } from '../lib/dates';
import ChartTooltip, { DashedCursor } from './ChartTooltip';
import { displayName } from '../lib/display';
import { sortByPresetOrder } from '../lib/utils';
import { useCategoryColors, buildCategoryColorMap, buildModelColorMap, type CategoryKind } from '../lib/colors';
import type { DailyData } from './DailyBarChart';

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/** 类别分布堆叠图：按 tool/provider/model 维度堆叠展示 Token 分布（原 DailyBarChart 顶部分布图抽出，卡片总览行使用） */
export default function TokenDistributionBarChart({ modelData, range, tz, groupLabel, categoryKind = 'model' }: { modelData?: DailyData[]; range: string; tz: number; groupLabel: string; categoryKind?: CategoryKind }) {
  // 堆叠分布图的类别：模型维度按字母序（与顺序取色对应）；tool/provider 保持后端返回顺序
  const seriesModels = useMemo(
    () => {
      const names = [...new Set((modelData || []).map(d => d.category || d.model || '').filter(Boolean))];
      return categoryKind === 'model' ? names.sort((a, b) => a.localeCompare(b)) : names;
    },
    [modelData, categoryKind],
  );

  const { data: colors } = useCategoryColors();
  // 类别 → 颜色：模型维度按字母序依次对应色板；tool/provider 由注册表决定（跨图表一致），未注册取名称哈希确定性色
  const colorMap = useMemo(() => {
    if (!colors) return new Map<string, string>();
    return categoryKind === 'model'
      ? buildModelColorMap(seriesModels, colors)
      : buildCategoryColorMap(seriesModels, categoryKind, colors);
  }, [seriesModels, categoryKind, colors]);

  const modelSeries = useMemo(() => {
    if (!modelData || modelData.length === 0) return null;
    // 优先使用 category（新后端统一字段），回退到 model 字段
    const getCat = (d: DailyData) => d.category || d.model || '';
    const models = seriesModels;
    const byDate = new Map<string, Record<string, number>>();
    for (const d of modelData) {
      const cat = getCat(d);
      if (!cat) continue;
      let row = byDate.get(d.date);
      if (!row) { row = {}; byDate.set(d.date, row); }
      row[cat] = (row[cat] || 0) + d.total_output_tokens + d.total_uncached_input + d.total_cache_read_tokens;
    }
    return fillDateRange(range, tz).map(date => {
      const row: any = { date };
      const entry = byDate.get(date) || {};
      for (const m of models) row[m] = entry[m] || 0;
      return row;
    });
  }, [modelData, seriesModels, range, tz]);

  if (!modelSeries) return (
    <p className="text-sm text-gray-500 text-center py-8">暂无数据</p>
  );

  // 颜色注册数据未就绪时不渲染分布图，避免柱段/图例以默认色渲染后在数据到达时整体跳变
  if (!colors) return (
    <p className="text-sm text-gray-500 text-center py-8">加载颜色数据中…</p>
  );

  return (
    <div>
      <h4 className="text-xs font-medium text-[#aeaeb2] mb-2">{groupLabel}</h4>
      <ResponsiveContainer width="100%" height={220}>
        <BarChart data={modelSeries} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barCategoryGap="10%">
          <CartesianGrid strokeDasharray="3 3" stroke="#e5e5ea" vertical={false} />
          <XAxis dataKey="date" tick={{ fontSize: 11, fill: '#aeaeb2' }} tickFormatter={(d: string) => fmtXAxis(d)} axisLine={{ stroke: '#e5e5ea' }} tickLine={false} />
          <YAxis tick={{ fontSize: 11, fill: '#aeaeb2' }} tickFormatter={fmtTokens} axisLine={false} tickLine={false} />
          <Tooltip cursor={<DashedCursor />} content={<ChartTooltip formatValue={(v) => v.toLocaleString()} />} />
          <Legend
            wrapperStyle={{ fontSize: 12 }}
            payload={(categoryKind === 'model' ? seriesModels : sortByPresetOrder(seriesModels)).map(model => ({
              // 图例：模型维度与柱段同一字母序；tool/provider 按固定预设序；颜色与柱段取色一致
              id: model, value: displayName(model), type: 'rect' as const, color: colorMap.get(model),
            }))}
          />
          {seriesModels.map(model => (
            <Bar key={model} dataKey={model} name={displayName(model)} fill={colorMap.get(model)} stackId="model" />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
