import { useMemo } from 'react';
import { BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { fillDateRange, fmtXAxis } from '../lib/dates';
import ChartTooltip, { DashedCursor } from './ChartTooltip';
import { displayName } from '../lib/display';
import { useCurrency, formatCost } from '../lib/currency';
import { useCategoryColors, buildCategoryColorMap, buildModelColorMap, type CategoryKind } from '../lib/colors';
import { sortByPresetOrder } from '../lib/utils';
import { buildCategoryRows, listCategories, stackOrder, type CategoryWideRow, type DailyData } from '../lib/chart-data';

// Token 类型固定色（明细区堆叠柱）
const COLORS = {
  output: '#5e5ce6',
  uncached: '#f59e0b',
  cached: '#30b48b',
};

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

const ZERO_ROW: DailyData = {
  date: '',
  count: 0,
  total_cost: 0,
  total_output_tokens: 0,
  total_uncached_input: 0,
  total_cache_read_tokens: 0,
};

/** 类别维度的分组标签前缀（工具/供应商/模型） */
const CATEGORY_LABELS: Record<CategoryKind, string> = { tool: '工具', provider: '供应商', model: '模型' };

/** Token 总量取值（输出 + 未命中输入 + 缓存命中三项和） */
const tokenValue = (d: DailyData) => (d.total_output_tokens || 0) + (d.total_uncached_input || 0) + (d.total_cache_read_tokens || 0);

// ── 堆叠分布图（费用 / Tokens 共用）──

function StackedDistributionChart({ title, rows, stackCategories, legendCategories, colorMap, formatValue, yAxisFormatter }: {
  title: string;
  rows: CategoryWideRow[];
  stackCategories: string[];   // Bar 声明序：tool/provider 按总量升序（小值在柱底）
  legendCategories: string[];  // 图例序：tool/provider 按后端返回顺序
  colorMap: Map<string, string>;
  formatValue: (v: number) => string;
  yAxisFormatter: (v: number) => string;
}) {
  return (
    <div>
      <h4 className="text-xs font-medium text-[#aeaeb2] mb-2">{title}</h4>
      <ResponsiveContainer width="100%" height={300}>
        <BarChart data={rows} margin={{ top: 16, right: 8, left: 0, bottom: 0 }} barCategoryGap="10%">
          <CartesianGrid strokeDasharray="3 3" stroke="#e5e5ea" vertical={false} />
          <XAxis dataKey="date" tick={{ fontSize: 11, fill: '#aeaeb2' }} tickFormatter={(d: string) => fmtXAxis(d)} axisLine={{ stroke: '#e5e5ea' }} tickLine={false} />
          <YAxis tick={{ fontSize: 11, fill: '#aeaeb2' }} tickFormatter={yAxisFormatter} axisLine={false} tickLine={false} />
          <Tooltip cursor={<DashedCursor />} content={<ChartTooltip formatValue={formatValue} />} />
          <Legend
            wrapperStyle={{ fontSize: 12 }}
            payload={legendCategories.map(cat => ({
              id: cat, value: displayName(cat), type: 'rect' as const, color: colorMap.get(cat),
            }))}
          />
          {stackCategories.map(cat => (
            <Bar key={cat} dataKey={cat} name={displayName(cat)} fill={colorMap.get(cat)} stackId="dist" />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

// ── 每类别明细小节（调用次数折线 + Token 类型堆叠；无类别数据时聚合兜底视图）──

function CategoryDetailSections({ data, modelData, range, tz }: { data: DailyData[]; modelData: DailyData[]; range: string; tz: number }) {
  // X 轴刻度由 fmtXAxis 按标签格式自判别：小时 HH:00 / 周 2026-8(W34) / 月 YYYY-MM / 天 YYYY-MM-DD
  const filledData = useMemo(() => {
    const map = new Map<string, DailyData>();
    for (const d of data) map.set(d.date, d);
    return fillDateRange(range, tz).map(date => map.get(date) || { ...ZERO_ROW, date });
  }, [data, range, tz]);

  const hasData = filledData.some(d =>
    d.total_output_tokens > 0 || d.total_uncached_input > 0 || d.total_cache_read_tokens > 0,
  );

  const totalCalls = filledData.reduce((s, d) => s + (d.count || 0), 0);
  const totalTokens = filledData.reduce((s, d) => s + d.total_output_tokens + d.total_uncached_input + d.total_cache_read_tokens, 0);

  // Token 类型按总量升序排列（小值在柱状底部）
  const tokenTypes = useMemo(() => {
    const out = filledData.reduce((s, d) => s + d.total_output_tokens, 0);
    const uncached = filledData.reduce((s, d) => s + d.total_uncached_input, 0);
    const cached = filledData.reduce((s, d) => s + d.total_cache_read_tokens, 0);
    const list = [
      { key: 'total_output_tokens', name: '↑ 输出', color: COLORS.output },
      { key: 'total_uncached_input', name: '↓ 输入', color: COLORS.uncached },
      { key: 'total_cache_read_tokens', name: '↓ 缓存命中', color: COLORS.cached },
    ];
    list.sort((a, b) => {
      const va = a.key === 'total_output_tokens' ? out : a.key === 'total_uncached_input' ? uncached : cached;
      const vb = b.key === 'total_output_tokens' ? out : b.key === 'total_uncached_input' ? uncached : cached;
      return va - vb;
    });
    return list;
  }, [filledData]);

  // 类别列表（去重），固定顺序：内置工具/供应商按预设序，其余字母序（不随用量变化）
  const modelNames = useMemo(() => {
    const names = [...new Set((modelData || []).map(d => d.category || d.model || '').filter(Boolean))];
    return sortByPresetOrder(names);
  }, [modelData]);

  // 单个模型的按日数据（用于每模型趋势图）
  const perModelData = (model: string): DailyData[] => {
    const map = new Map<string, DailyData>();
    for (const d of modelData || []) {
      if ((d.category || d.model) !== model) continue;
      map.set(d.date, d);
    }
    return fillDateRange(range, tz).map(date => map.get(date) || { ...ZERO_ROW, date });
  };

  if (!hasData && modelNames.length === 0) return (
    <p className="text-sm text-gray-500 text-center py-8">暂无每日数据</p>
  );

  return (
    <div className="space-y-6">
      {modelNames.length > 0 ? (
        modelNames.map(model => {
          const md = perModelData(model);
          const calls = md.reduce((s, d) => s + (d.count || 0), 0);
          const tokens = md.reduce((s, d) => s + d.total_output_tokens + d.total_uncached_input + d.total_cache_read_tokens, 0);
          return (
            <div key={model}>
              {/* 模型标签行：模型名独立成标签，图表显示在标签下方 */}
              <h4 className="text-sm font-semibold text-[#1d1d1f] mb-2">{displayName(model)}</h4>
              <div className="grid grid-cols-2 gap-6">
                <div>
                  {/* 左侧调用次数折线图（小标题去掉模型名前缀，汇总数字保留） */}
                  <div className="flex items-center justify-between mb-2">
                    <h4 className="text-xs font-medium text-[#aeaeb2]">调用次数</h4>
                    <span className="text-xs font-mono text-[#aeaeb2]">{calls.toLocaleString()} 次</span>
                  </div>
                  <ResponsiveContainer width="100%" height={200}>
                    <LineChart data={md} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#e5e5ea" vertical={false} />
                      <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#aeaeb2' }} tickFormatter={(d: string) => fmtXAxis(d)} axisLine={{ stroke: '#e5e5ea' }} tickLine={false} />
                      <YAxis tick={{ fontSize: 10, fill: '#aeaeb2' }} allowDecimals={false} axisLine={false} tickLine={false} />
                      <Tooltip contentStyle={{ borderRadius: 10, border: '1px solid #e5e5ea', fontSize: 12 }} formatter={(v: number) => [v.toLocaleString(), '请求数']} labelFormatter={(d: string) => fmtXAxis(d)} />
                      <Line type="monotone" dataKey="count" name="调用次数" stroke="#6366f1" strokeWidth={2} dot={{ r: 3 }} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
                <div>
                  {/* 右侧 Token 用量柱状图（小标题去掉模型名前缀，汇总数字保留） */}
                  <div className="flex items-center justify-between mb-2">
                    <h4 className="text-xs font-medium text-[#aeaeb2]">Token 用量</h4>
                    <span className="text-xs font-mono text-[#aeaeb2]">{tokens.toLocaleString()}</span>
                  </div>
                  <ResponsiveContainer width="100%" height={200}>
                    <BarChart data={md} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barCategoryGap="10%">
                      <CartesianGrid strokeDasharray="3 3" stroke="#e5e5ea" vertical={false} />
                      <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#aeaeb2' }} tickFormatter={(d: string) => fmtXAxis(d)} axisLine={{ stroke: '#e5e5ea' }} tickLine={false} />
                      <YAxis tick={{ fontSize: 10, fill: '#aeaeb2' }} tickFormatter={fmtTokens} axisLine={false} tickLine={false} />
                      <Tooltip cursor={<DashedCursor />} content={<ChartTooltip formatValue={(v) => v.toLocaleString()} />} />
                      {tokenTypes.map(tt => (
                        <Bar key={tt.key} dataKey={tt.key} name={tt.name} stackId="a" fill={tt.color} stroke="#fff" strokeWidth={1} />
                      ))}
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </div>
          );
        })
      ) : (
        <>
          {/* 调用次数趋势 + Token 用量 同行（无类别数据时的聚合视图） */}
          <div className="grid grid-cols-2 gap-6">
            <div>
              <div className="flex items-center justify-between mb-2">
                <h4 className="text-xs font-medium text-[#aeaeb2]">调用次数</h4>
                <span className="text-xs font-mono text-[#6366f1]">{totalCalls.toLocaleString()} 次</span>
              </div>
              <ResponsiveContainer width="100%" height={200}>
                <LineChart data={filledData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e5e5ea" vertical={false} />
                  <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#aeaeb2' }} tickFormatter={(d: string) => fmtXAxis(d)} axisLine={{ stroke: '#e5e5ea' }} tickLine={false} />
                  <YAxis tick={{ fontSize: 10, fill: '#aeaeb2' }} allowDecimals={false} axisLine={false} tickLine={false} />
                  <Tooltip contentStyle={{ borderRadius: 10, border: '1px solid #e5e5ea', fontSize: 12 }} formatter={(v: number) => [v.toLocaleString(), '请求数']} labelFormatter={(d: string) => fmtXAxis(d)} />
                  <Line type="monotone" dataKey="count" name="调用次数" stroke="#6366f1" strokeWidth={2} dot={{ r: 3 }} />
                </LineChart>
              </ResponsiveContainer>
            </div>
            <div>
              <div className="flex items-center justify-between mb-2">
                <h4 className="text-xs font-medium text-[#aeaeb2]">Token 用量</h4>
                <span className="text-xs font-mono text-[#aeaeb2]">{totalTokens.toLocaleString()}</span>
              </div>
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={filledData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barCategoryGap="10%">
                  <CartesianGrid strokeDasharray="3 3" stroke="#e5e5ea" vertical={false} />
                  <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#aeaeb2' }} tickFormatter={(d: string) => fmtXAxis(d)} axisLine={{ stroke: '#e5e5ea' }} tickLine={false} />
                  <YAxis tick={{ fontSize: 10, fill: '#aeaeb2' }} tickFormatter={fmtTokens} axisLine={false} tickLine={false} />
                  <Tooltip cursor={<DashedCursor />} content={<ChartTooltip formatValue={(v) => v.toLocaleString()} />} />
                  {tokenTypes.map(tt => (
                    <Bar key={tt.key} dataKey={tt.key} name={tt.name} stackId="a" fill={tt.color} stroke="#fff" strokeWidth={1} />
                  ))}
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ── 整面板 ──

/** Dashboard 图表面板：顶部并列费用 + Tokens 堆叠分布图，下方每类别明细（无类别数据时聚合兜底视图） */
export default function DailyChartsPanel({ dailyStats, categoryData, range, tz, categoryKind }: {
  dailyStats?: DailyData[];
  categoryData?: DailyData[];
  range: string;
  tz: number;
  categoryKind: CategoryKind;
}) {
  const catData = useMemo(() => categoryData || [], [categoryData]);
  const { currency, rates } = useCurrency();
  const { data: colors } = useCategoryColors();

  // 类别列表（首现顺序 = 后端返回顺序）
  const categories = useMemo(() => listCategories(catData), [catData]);
  // 取色：model 维度按字母序对应色板；tool/provider 由注册表决定（跨图表一致）
  const colorMap = useMemo(() => {
    if (!colors) return new Map<string, string>();
    return categoryKind === 'model'
      ? buildModelColorMap([...categories].sort((a, b) => a.localeCompare(b)), colors)
      : buildCategoryColorMap(categories, categoryKind, colors);
  }, [colors, categories, categoryKind]);

  // 两个分布图的宽表（取值函数不同）
  const costRows = useMemo(() => buildCategoryRows(catData, range, tz, d => d.total_cost || 0), [catData, range, tz]);
  const tokenRows = useMemo(() => buildCategoryRows(catData, range, tz, tokenValue), [catData, range, tz]);
  // 堆叠顺序：model 字母序；tool/provider 按各自指标总量升序（小值在柱底）
  const costStack = useMemo(() => stackOrder(categories, catData, categoryKind, d => d.total_cost || 0), [categories, catData, categoryKind]);
  const tokenStack = useMemo(() => stackOrder(categories, catData, categoryKind, tokenValue), [categories, catData, categoryKind]);
  // 图例顺序：model 字母序；tool/provider 后端返回顺序
  const legendCategories = useMemo(
    () => categoryKind === 'model' ? [...categories].sort((a, b) => a.localeCompare(b)) : categories,
    [categories, categoryKind],
  );

  // 费用图空态：无类别或全零；Tokens 图仅判无类别（两者刻意不对称）
  const hasCostData = costRows.some(r => categories.some(c => (r[c] || 0) > 0));
  const label = CATEGORY_LABELS[categoryKind];
  const placeholder = <p className="text-sm text-gray-500 text-center py-8">暂无数据</p>;
  const colorLoading = <p className="text-sm text-gray-500 text-center py-8">加载颜色数据中…</p>;

  return (
    <>
      {/* 总览行：费用分布 + 类别分布堆叠图并列；无类别数据时不渲染两格 grid，合并为单个占位 */}
      {categories.length === 0 ? (
        placeholder
      ) : (
        <div className="grid grid-cols-2 gap-6">
          {!hasCostData
            ? placeholder
            : !colors
              ? colorLoading
              : <StackedDistributionChart title={`${label}费用`} rows={costRows} stackCategories={costStack} legendCategories={legendCategories} colorMap={colorMap} formatValue={(v) => formatCost(v, currency, rates)} yAxisFormatter={(v) => formatCost(v, currency, rates)} />}
          {!colors
            ? colorLoading
            : <StackedDistributionChart title={`${label}Tokens`} rows={tokenRows} stackCategories={tokenStack} legendCategories={legendCategories} colorMap={colorMap} formatValue={(v) => v.toLocaleString()} yAxisFormatter={fmtTokens} />}
        </div>
      )}
      {dailyStats && (
        <CategoryDetailSections data={dailyStats} modelData={catData} range={range} tz={tz} />
      )}
    </>
  );
}
