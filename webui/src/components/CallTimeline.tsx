import { useCurrency, formatCost } from '../lib/currency';

export default function CallTimeline({ calls }: { calls: any[] }) {
  const { currency, rates } = useCurrency();
  return (
    <div>
      {calls.map((c, i) => {
        const ok = c.status_code === 200;
        const sc = ok ? '#30b48b' : c.status_code === 429 ? '#e69900' : '#e03a3a';
        return (
          <a key={c.id} href={`/calls/${c.id}`} onClick={(e) => { e.preventDefault(); window.history.pushState({}, '', `/calls/${c.id}`); window.dispatchEvent(new PopStateEvent('popstate')); }}
            className="flex items-center gap-4 px-5 py-2.5 hover:bg-[#f5f5f7] transition-colors group text-sm"
            style={{ textDecoration: 'none', color: 'inherit', borderBottom: i === calls.length - 1 ? 'none' : '1px solid #f0f0f4' }}>
            <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: sc }} />
            <span className="text-xs font-mono w-14 flex-shrink-0 text-[#aeaeb2]">{c.created_at?.slice(11, 19)}</span>
            <span className="px-1.5 py-0.5 rounded text-[10px] font-mono font-medium w-10 text-center flex-shrink-0 bg-[#f0f0f4] text-[#6e6e73]">{c.method}</span>
            <span className="text-xs flex-1 truncate font-mono text-[#6e6e73]">{c.endpoint}</span>
            <span className="text-xs font-mono w-14 text-right flex-shrink-0 text-[#aeaeb2]">{c.duration_ms >= 1000 ? `${(c.duration_ms / 1000).toFixed(1)}s` : `${c.duration_ms}ms`}</span>
            <span className="text-xs font-mono font-medium w-24 text-right flex-shrink-0 text-[#6e6e73]">{c.total_cost > 0 ? formatCost(c.total_cost, currency, rates) : '--'}</span>
          </a>
        );
      })}
      {!calls.length && <div className="py-12 text-center text-sm text-[#aeaeb2]">暂无调用记录</div>}
    </div>
  );
}
