import type { ReactNode } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';

/** KPI 卡片项：icon 为 ReactNode（lucide 图标或货币符号）；valueColor 可选彩色数值 */
export interface KpiItem {
  label: string;
  value: string;
  icon?: ReactNode;
  valueColor?: string;
  sub?: ReactNode;
}

/** KPI 卡片行：列数由卡片数量决定（inline style，Tailwind 无法动态类名）。
 *  归一三种形态：Dashboard 4 卡（图标）/ 供应商页 5 卡（双行 sub）/ 会话页 5 卡（无图标、彩色数值） */
export default function KpiCards({ items }: { items: KpiItem[] }) {
  return (
    <div className="grid gap-4" style={{ gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))` }}>
      {items.map(k => (
        <Card key={k.label}>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-xs font-medium uppercase tracking-wider text-gray-500">{k.label}</CardTitle>
            {k.icon}
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold" style={k.valueColor ? { color: k.valueColor } : undefined}>{k.value}</div>
            {k.sub && <p className="text-xs text-gray-500 mt-1">{k.sub}</p>}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
