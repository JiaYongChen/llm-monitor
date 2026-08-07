import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from 'recharts';
import { useCurrency, formatCost } from '../lib/currency';

const COLORS = ['#6366f1', '#10b981', '#3b82f6', '#f59e0b', '#8b5cf6', '#ef4444', '#06b6d4', '#f97316'];

export default function CostPieChart({ stats }: { stats: { key: string; total_cost: number }[] }) {
  const { currency, rates } = useCurrency();
  const data = stats.filter(s => s.total_cost > 0).map(s => ({ name: s.key, value: s.total_cost }));

  if (data.length === 0) return (
    <p className="text-sm text-gray-500 text-center py-8">暂无数据</p>
  );

  return (
    <ResponsiveContainer width="100%" height={280}>
      <PieChart>
        <Pie
          data={data}
          dataKey="value"
          nameKey="name"
          cx="50%"
          cy="50%"
          innerRadius={60}
          outerRadius={100}
          paddingAngle={2}
          label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}
        >
          {data.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
        </Pie>
        <Tooltip formatter={(v: number) => formatCost(v, currency, rates)} />
      </PieChart>
    </ResponsiveContainer>
  );
}
