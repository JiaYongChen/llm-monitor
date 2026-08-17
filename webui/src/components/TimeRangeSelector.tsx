/** 时间范围档位（分段按钮组顺序即展示顺序；value 与后端 getDailyStats / 前端 fillDateRange 的 range 契约一致） */
export const DAILY_RANGES = [
  { value: 'yesterday', label: '昨天' },
  { value: 'today', label: '今天' },
  { value: '7d', label: '7 天' },
  { value: '14d', label: '14 天' },
  { value: '30d', label: '30 天' },
  { value: '60d', label: '60 天' },
  { value: 'thisMonth', label: '本月' },
  { value: 'lastMonth', label: '上月' },
  { value: 'thisQuarter', label: '本季度' },
  { value: 'lastQuarter', label: '上季度' },
  { value: 'thisYear', label: '本年' },
  { value: 'lastYear', label: '去年' },
];

/** 时间范围分段按钮组（受控组件，状态由页面持有） */
export default function TimeRangeSelector({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex items-center justify-center">
      <div className="inline-flex items-center gap-0.5 bg-[#e9e9ee] rounded-lg p-1">
        {DAILY_RANGES.map(r => (
          <button
            key={r.value}
            type="button"
            aria-pressed={value === r.value}
            onClick={() => onChange(r.value)}
            className={`px-3 py-1.5 text-sm rounded-md transition-colors ${value === r.value ? 'bg-white text-[#1d1d1f] font-medium shadow-sm' : 'text-[#6e6e73] hover:text-[#1d1d1f]'}`}
          >
            {r.label}
          </button>
        ))}
      </div>
    </div>
  );
}
