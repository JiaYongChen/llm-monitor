import { useMemo } from 'react';
import { BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';

const COLORS = {
  output: '#5e5ce6',
  uncached: '#f59e0b',
  cached: '#30b48b',
};

const MODEL_COLORS = ['#6366f1', '#f59e0b', '#10b981', '#ef4444', '#8b5cf6', '#06b6d4', '#f97316', '#84cc16'];

interface DailyData {
  date: string;
  model?: string;
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

function fillDateRange(days: number): string[] {
  const result: string[] = [];
  const now = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    result.push(d.toISOString().slice(0, 10));
  }
  return result;
}

const ZERO_ROW: DailyData = {
  date: '',
  count: 0,
  total_output_tokens: 0,
  total_uncached_input: 0,
  total_cache_read_tokens: 0,
};

export default function DailyBarChart({ data, days, modelData }: { data: DailyData[]; days: number; modelData?: DailyData[] }) {
  const filledData = useMemo(() => {
    const map = new Map<string, DailyData>();
    for (const d of data) map.set(d.date, d);
    return fillDateRange(days).map(date => map.get(date) || { ...ZERO_ROW, date });
  }, [data, days]);

  // 按模型分组的数据
  const modelSeries = useMemo(() => {
    if (!modelData || modelData.length === 0) return null;
    const models = [...new Set(modelData.map(d => d.model!).filter(Boolean))];
    const dates = fillDateRange(days);
    // 构建以日期为索引的 map
    const byDate = new Map<string, Record<string, number>>();
    for (const d of modelData) {
      if (!d.model) continue;
      let row = byDate.get(d.date);
      if (!row) { row = {}; byDate.set(d.date, row); }
      row[d.model] = (row[d.model] || 0) + d.total_output_tokens + d.total_uncached_input + d.total_cache_read_tokens;
    }
    // 填充完整日期序列
    return dates.map(date => {
      const row: any = { date };
      const entry = byDate.get(date) || {};
      for (const m of models) row[m] = entry[m] || 0;
      return row;
    });
  }, [modelData, days]);

  const hasData = filledData.some(d =>
    d.total_output_tokens > 0 || d.total_uncached_input > 0 || d.total_cache_read_tokens > 0,
  );

  if (!hasData) return (
    <p className="text-sm text-gray-500 text-center py-8">暂无每日数据</p>
  );

  return (
    <div className="space-y-6">
      {/* Token 用量堆叠柱状图 */}
      <ResponsiveContainer width="100%" height={220}>
        <BarChart data={filledData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e5e5ea" vertical={false} />
          <XAxis dataKey="date" tick={{ fontSize: 11, fill: '#aeaeb2' }} tickFormatter={(d: string) => d.slice(5)} axisLine={{ stroke: '#e5e5ea' }} tickLine={false} />
          <YAxis tick={{ fontSize: 11, fill: '#aeaeb2' }} tickFormatter={fmtTokens} axisLine={false} tickLine={false} />
          <Tooltip contentStyle={{ borderRadius: 10, border: '1px solid #e5e5ea', fontSize: 12 }} formatter={(v: number, name: string) => [v.toLocaleString(), name]} labelFormatter={(d: string) => d} />
          <Bar dataKey="total_output_tokens" name="输出" stackId="a" fill={COLORS.output} />
          <Bar dataKey="total_uncached_input" name="输入(未命中)" stackId="a" fill={COLORS.uncached} />
          <Bar dataKey="total_cache_read_tokens" name="输入(命中)" stackId="a" fill={COLORS.cached} />
        </BarChart>
      </ResponsiveContainer>

      {/* 每日调用次数趋势线 */}
      <ResponsiveContainer width="100%" height={180}>
        <LineChart data={filledData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e5e5ea" vertical={false} />
          <XAxis dataKey="date" tick={{ fontSize: 11, fill: '#aeaeb2' }} tickFormatter={(d: string) => d.slice(5)} axisLine={{ stroke: '#e5e5ea' }} tickLine={false} />
          <YAxis tick={{ fontSize: 11, fill: '#aeaeb2' }} allowDecimals={false} axisLine={false} tickLine={false} />
          <Tooltip contentStyle={{ borderRadius: 10, border: '1px solid #e5e5ea', fontSize: 12 }} formatter={(v: number, name: string) => [v.toLocaleString(), name]} labelFormatter={(d: string) => d} />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <Line type="monotone" dataKey="count" name="调用次数" stroke="#6366f1" strokeWidth={2} dot={{ r: 3 }} />
        </LineChart>
      </ResponsiveContainer>

      {/* 按模型分组柱状图 */}
      {modelSeries && (
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={modelSeries} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e5e5ea" vertical={false} />
            <XAxis dataKey="date" tick={{ fontSize: 11, fill: '#aeaeb2' }} tickFormatter={(d: string) => d.slice(5)} axisLine={{ stroke: '#e5e5ea' }} tickLine={false} />
            <YAxis tick={{ fontSize: 11, fill: '#aeaeb2' }} tickFormatter={fmtTokens} axisLine={false} tickLine={false} />
            <Tooltip contentStyle={{ borderRadius: 10, border: '1px solid #e5e5ea', fontSize: 12 }} formatter={(v: number, name: string) => [v.toLocaleString(), name]} labelFormatter={(d: string) => d} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            {[...new Set(modelData!.map(d => d.model!).filter(Boolean))].map((model, i) => (
              <Bar key={model} dataKey={model} name={model} fill={MODEL_COLORS[i % MODEL_COLORS.length]} />
            ))}
          </BarChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
