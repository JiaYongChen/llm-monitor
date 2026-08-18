import { useMemo } from 'react';
import { BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { fillDateRange, fmtXAxis } from '../lib/dates';
import ChartTooltip, { DashedCursor } from './ChartTooltip';
import { displayName } from '../lib/display';
import { sortByPresetOrder } from '../lib/utils';
import { useCategoryColors, buildCategoryColorMap, buildModelColorMap, type CategoryKind } from '../lib/colors';

const COLORS = {
  output: '#5e5ce6',
  uncached: '#f59e0b',
  cached: '#30b48b',
};

interface DailyData {
  date: string;
  model?: string;
  category?: string;
  count: number;
  total_output_tokens: number;
  total_uncached_input: number;
  total_cache_read_tokens: number;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

const ZERO_ROW: DailyData = {
  date: '',
  count: 0,
  total_output_tokens: 0,
  total_uncached_input: 0,
  total_cache_read_tokens: 0,
};

export default function DailyBarChart({ data, range, tz, modelData, groupLabel = '模型分布', categoryKind = 'model' }: { data: DailyData[]; range: string; tz: number; modelData?: DailyData[]; groupLabel?: string; categoryKind?: CategoryKind }) {
  // X 轴刻度由 fmtXAxis 按标签格式自判别：小时 HH:00 / 周 W34 / 月 YYYY-MM / 天 MM-DD
  const filledData = useMemo(() => {
    const map = new Map<string, DailyData>();
    for (const d of data) map.set(d.date, d);
    return fillDateRange(range, tz).map(date => map.get(date) || { ...ZERO_ROW, date });
  }, [data, range, tz]);

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

  if (!hasData && !modelSeries) return (
    <p className="text-sm text-gray-500 text-center py-8">暂无每日数据</p>
  );

  return (
    <div className="space-y-6">
      {modelSeries ? (!colors ? (
        // 颜色注册数据未就绪时不渲染分布图，避免柱段/图例以默认色渲染后在数据到达时整体跳变
        <p className="text-sm text-gray-500 text-center py-8">加载颜色数据中…</p>
      ) : (
        <>
          {/* 分布堆叠图（最前） */}
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

          {/* 每个模型：调用次数 + Token 用量 */}
          {modelNames.map(model => {
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
                        <Tooltip contentStyle={{ borderRadius: 10, border: '1px solid #e5e5ea', fontSize: 12 }} formatter={(v: number) => [v.toLocaleString(), '请求数']} labelFormatter={(d: string) => d} />
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
          })}
        </>
      )) : (
        <>
          {/* 调用次数趋势 + Token 用量 同行（无模型数据时的聚合视图） */}
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
                  <Tooltip contentStyle={{ borderRadius: 10, border: '1px solid #e5e5ea', fontSize: 12 }} formatter={(v: number) => [v.toLocaleString(), '请求数']} labelFormatter={(d: string) => d} />
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
