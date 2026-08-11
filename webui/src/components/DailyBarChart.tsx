import { useMemo } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';

const COLORS = {
  output: '#5e5ce6',
  uncached: '#f59e0b',
  cached: '#30b48b',
};

interface DailyData {
  date: string;
  total_output_tokens: number;
  total_uncached_input: number;
  total_cache_read_tokens: number;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/** 生成最近 N 天的完整日期序列（含今天） */
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
  total_output_tokens: 0,
  total_uncached_input: 0,
  total_cache_read_tokens: 0,
};

export default function DailyBarChart({ data, days }: { data: DailyData[]; days: number }) {
  // 填充缺失天数，确保图表显示完整时间范围
  const filledData = useMemo(() => {
    const map = new Map<string, DailyData>();
    for (const d of data) map.set(d.date, d);
    return fillDateRange(days).map(date => map.get(date) || { ...ZERO_ROW, date });
  }, [data, days]);

  const hasData = filledData.some(d =>
    d.total_output_tokens > 0 || d.total_uncached_input > 0 || d.total_cache_read_tokens > 0,
  );

  if (!hasData) return (
    <p className="text-sm text-gray-500 text-center py-8">暂无每日数据</p>
  );

  return (
    <ResponsiveContainer width="100%" height={260}>
      <BarChart data={filledData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#e5e5ea" vertical={false} />
        <XAxis
          dataKey="date"
          tick={{ fontSize: 11, fill: '#aeaeb2' }}
          tickFormatter={(d: string) => d.slice(5)}
          axisLine={{ stroke: '#e5e5ea' }}
          tickLine={false}
        />
        <YAxis
          tick={{ fontSize: 11, fill: '#aeaeb2' }}
          tickFormatter={fmtTokens}
          axisLine={false}
          tickLine={false}
        />
        <Tooltip
          contentStyle={{ borderRadius: 10, border: '1px solid #e5e5ea', fontSize: 12 }}
          formatter={(v: number, name: string) => [v.toLocaleString(), name]}
          labelFormatter={(d: string) => d}
        />
        <Bar dataKey="total_output_tokens" name="输出" stackId="a" fill={COLORS.output} />
        <Bar dataKey="total_uncached_input" name="输入(未命中)" stackId="a" fill={COLORS.uncached} />
        <Bar dataKey="total_cache_read_tokens" name="输入(命中)" stackId="a" fill={COLORS.cached} />
      </BarChart>
    </ResponsiveContainer>
  );
}
