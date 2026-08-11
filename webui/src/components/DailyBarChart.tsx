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

function fillDateRange(days: number, hourly?: boolean): string[] {
  const result: string[] = [];
  const now = new Date();
  if (hourly) {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    for (let h = 0; h < 24; h++) {
      const d = new Date(start.getTime() + h * 60 * 60 * 1000);
      result.push(d.toISOString().slice(0, 13) + ':00');
    }
    return result;
  }
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

function fmtXAxis(d: string, hourly?: boolean): string {
  if (hourly) return d.slice(11, 16); // '2024-01-15 14:00' → '14:00'
  return d.slice(5); // '2024-01-15' → '01-15'
}

export default function DailyBarChart({ data, days, isHourly, modelData }: { data: DailyData[]; days: number; isHourly?: boolean; modelData?: DailyData[] }) {
  const filledData = useMemo(() => {
    const map = new Map<string, DailyData>();
    for (const d of data) map.set(d.date, d);
    return fillDateRange(days, isHourly).map(date => map.get(date) || { ...ZERO_ROW, date });
  }, [data, days, isHourly]);

  const modelSeries = useMemo(() => {
    if (!modelData || modelData.length === 0) return null;
    const models = [...new Set(modelData.map(d => d.model!).filter(Boolean))];
    const byDate = new Map<string, Record<string, number>>();
    for (const d of modelData) {
      if (!d.model) continue;
      let row = byDate.get(d.date);
      if (!row) { row = {}; byDate.set(d.date, row); }
      row[d.model] = (row[d.model] || 0) + d.total_output_tokens + d.total_uncached_input + d.total_cache_read_tokens;
    }
    return fillDateRange(days, isHourly).map(date => {
      const row: any = { date };
      const entry = byDate.get(date) || {};
      for (const m of models) row[m] = entry[m] || 0;
      return row;
    });
  }, [modelData, days, isHourly]);

  const hasData = filledData.some(d =>
    d.total_output_tokens > 0 || d.total_uncached_input > 0 || d.total_cache_read_tokens > 0,
  );

  const totalCalls = filledData.reduce((s, d) => s + (d.count || 0), 0);
  const totalTokens = filledData.reduce((s, d) => s + d.total_output_tokens + d.total_uncached_input + d.total_cache_read_tokens, 0);

  if (!hasData) return (
    <p className="text-sm text-gray-500 text-center py-8">暂无每日数据</p>
  );

  return (
    <div className="space-y-6">
      {/* 调用次数趋势 + Token 用量 同行 */}
      <div className="grid grid-cols-2 gap-6">
        <div>
          <div className="flex items-center justify-between mb-2">
            <h4 className="text-xs font-medium text-[#aeaeb2]">调用次数</h4>
            <span className="text-xs font-mono text-[#6366f1]">{totalCalls.toLocaleString()} 次</span>
          </div>
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={filledData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e5e5ea" vertical={false} />
              <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#aeaeb2' }} tickFormatter={(d: string) => fmtXAxis(d, isHourly)} axisLine={{ stroke: '#e5e5ea' }} tickLine={false} />
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
            <BarChart data={filledData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e5e5ea" vertical={false} />
              <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#aeaeb2' }} tickFormatter={(d: string) => fmtXAxis(d, isHourly)} axisLine={{ stroke: '#e5e5ea' }} tickLine={false} />
              <YAxis tick={{ fontSize: 10, fill: '#aeaeb2' }} tickFormatter={fmtTokens} axisLine={false} tickLine={false} />
              <Tooltip contentStyle={{ borderRadius: 10, border: '1px solid #e5e5ea', fontSize: 12 }} formatter={(v: number, name: string) => [v.toLocaleString(), name]} labelFormatter={(d: string) => d} />
              <Bar dataKey="total_output_tokens" name="输出" stackId="a" fill={COLORS.output} />
              <Bar dataKey="total_uncached_input" name="输入(未命中)" stackId="a" fill={COLORS.uncached} />
              <Bar dataKey="total_cache_read_tokens" name="输入(命中)" stackId="a" fill={COLORS.cached} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* 按模型分组柱状图 */}
      {modelSeries && (
        <div>
          <h4 className="text-xs font-medium text-[#aeaeb2] mb-2">模型分布</h4>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={modelSeries} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e5e5ea" vertical={false} />
              <XAxis dataKey="date" tick={{ fontSize: 11, fill: '#aeaeb2' }} tickFormatter={(d: string) => fmtXAxis(d, isHourly)} axisLine={{ stroke: '#e5e5ea' }} tickLine={false} />
              <YAxis tick={{ fontSize: 11, fill: '#aeaeb2' }} tickFormatter={fmtTokens} axisLine={false} tickLine={false} />
              <Tooltip contentStyle={{ borderRadius: 10, border: '1px solid #e5e5ea', fontSize: 12 }} formatter={(v: number, name: string) => [v.toLocaleString(), name]} labelFormatter={(d: string) => d} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              {[...new Set(modelData!.map(d => d.model!).filter(Boolean))].map((model, i) => (
                <Bar key={model} dataKey={model} name={model} fill={MODEL_COLORS[i % MODEL_COLORS.length]} />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
