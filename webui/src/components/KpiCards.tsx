import { useCurrency, formatCost } from '../lib/currency';

export default function KpiCards({ totalCalls, totalCost, totalTokens, cacheHitRate }: {
  totalCalls: number; totalCost: number; totalTokens: number; cacheHitRate?: number;
}) {
  const { currency, rates } = useCurrency();
  const cards = [
    { label: '总调用', value: totalCalls.toLocaleString(), icon: 'M13 7h8m0 0v8m0-8l-8 8-4-4-6 6', color: '#6366f1' },
    { label: '总费用', value: formatCost(totalCost, currency, rates), icon: 'M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z', color: '#f59e0b' },
    { label: '总 token', value: totalTokens.toLocaleString(), icon: 'M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z', color: '#22c55e' },
    { label: '缓存命中率', value: cacheHitRate != null ? `${(cacheHitRate * 100).toFixed(0)}%` : '--', icon: 'M4 7v10c0 2 1 3 3 3h10c2 0 3-1 3-3V7M4 7c0-2 1-3 3-3h10c2 0 3 1 3 3M4 7h16M9 3v4m6-4v4', color: '#8b5cf6' },
  ];

  return (
    <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
      {cards.map((card) => (
        <div key={card.label} className="rounded-xl p-4 border animate-in"
          style={{ background: '#0c0c10', borderColor: '#1e1e28' }}>
          <div className="flex items-center justify-between mb-2.5">
            <span className="text-xs font-medium" style={{ color: '#a1a1aa' }}>{card.label}</span>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={card.color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d={card.icon} />
            </svg>
          </div>
          <div className="text-2xl font-bold tracking-tight">{card.value}</div>
        </div>
      ))}
    </div>
  );
}
