import type { ReactNode } from 'react';

interface ChartTooltipProps {
  active?: boolean;
  payload?: any[];
  label?: string | number;
  /** 数值格式化函数（如费用用 formatCost、token 用 toLocaleString） */
  formatValue: (v: number) => string;
}

/** 通用图表 Tooltip：日期行右侧显示当日总计，下面列出各分类明细 */
export default function ChartTooltip({ active, payload, label, formatValue }: ChartTooltipProps) {
  if (!active || !payload || payload.length === 0) return null;

  const total = payload.reduce((s: number, p: any) => s + (Number(p.value) || 0), 0);
  const rows = payload.filter((p: any) => (Number(p.value) || 0) > 0);

  return (
    <div className="rounded-[10px] border border-[#e5e5ea] bg-white px-3 py-2 text-xs shadow-sm">
      <div className="mb-1 flex items-center justify-between gap-6 font-medium text-[#1d1d1f]">
        <span>{label}</span>
        <span className="font-mono text-[#6366f1]">{formatValue(total)}</span>
      </div>
      {rows.length > 0 && (
        <div className="space-y-0.5">
          {rows.map((p: any, i: number) => (
            <div key={i} className="flex items-center justify-between gap-6">
              <span className="flex items-center gap-1.5 text-[#6e6e73]">
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: p.color || p.fill }} />
                {p.name as ReactNode}
              </span>
              <span className="font-mono text-[#1d1d1f]">{formatValue(p.value as number)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
