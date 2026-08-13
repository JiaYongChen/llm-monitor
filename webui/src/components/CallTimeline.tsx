import { useCurrency, formatCost } from '../lib/currency';
import { formatTime } from '../lib/utils';
import { displayName } from '../lib/display';

/** Token 紧凑显示：≥1M 用 M、≥1K 用 K，保证列宽固定时数字不溢出（精确值见悬浮提示） */
function fmtTokens(n: number | null | undefined): string {
  if (n == null || n === 0) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

/** 表头与数据行共用的网格列模板：列边界由网格锁定，两侧结构完全一致（状态点/时间/方法/供应商/模型/输入/输出/耗时/费用） */
const COLS = 'grid grid-cols-[0.5rem_9rem_2.5rem_1fr_1fr_8rem_4rem_3.5rem_6rem] items-center gap-3 px-5';

export default function CallTimeline({ calls }: { calls: any[] }) {
  const { currency, rates } = useCurrency();
  return (
    <div>
      {calls.length > 0 && (
        <div className={`${COLS} py-2 sticky top-0 z-10 bg-white border-b border-[#e5e5ea]`}>
          <span />
          <span className="text-[11px] font-medium text-center text-[#aeaeb2]" title="调用发生时间">时间</span>
          <span className="text-[11px] font-medium text-center text-[#aeaeb2]" title="HTTP 请求方法">方法</span>
          <span className="text-[11px] font-medium text-center text-[#aeaeb2]" title="上游供应商">供应商</span>
          <span className="text-[11px] font-medium text-center text-[#aeaeb2]" title="模型名称">模型</span>
          <span className="text-[11px] font-medium text-center text-[#aeaeb2]" title="输入 tokens（↓ 未命中缓存 / ↻ 命中缓存）">输入 ↓ / ↻</span>
          <span className="text-[11px] font-medium text-center text-[#aeaeb2]" title="输出 tokens">输出 ↑</span>
          <span className="text-[11px] font-medium text-center text-[#aeaeb2]" title="请求耗时">耗时</span>
          <span className="text-[11px] font-medium text-center text-[#aeaeb2]" title="本次调用费用">费用</span>
        </div>
      )}
      {calls.map((c, i) => {
        const ok = c.status_code === 200;
        const sc = ok ? '#30b48b' : c.status_code === 429 ? '#e69900' : '#e03a3a';
        const hasTokens = (c.prompt_tokens || c.output_tokens || c.cache_read_tokens || c.uncached_input);
        return (
          <a key={c.id} href={`/calls/${c.id}`} onClick={(e) => { e.preventDefault(); window.history.pushState({}, '', `/calls/${c.id}`); window.dispatchEvent(new PopStateEvent('popstate')); }}
            className={`${COLS} py-2.5 hover:bg-[#f5f5f7] transition-colors group text-sm`}
            style={{ textDecoration: 'none', color: 'inherit', borderBottom: i === calls.length - 1 ? 'none' : '1px solid #f0f0f4' }}>
            <span className="w-2 h-2 rounded-full justify-self-center" style={{ background: sc }} />
            <span className="text-xs font-mono text-center text-[#aeaeb2]">{formatTime(c.created_at)}</span>
            <span className="px-1.5 py-0.5 rounded text-[10px] font-mono font-medium text-center bg-[#f0f0f4] text-[#6e6e73]">{c.method}</span>
            <span className="text-xs truncate font-mono min-w-0 text-center text-[#6e6e73]">{displayName(c.provider)}</span>
            <span className="text-xs truncate font-mono min-w-0 text-center text-[#6e6e73]">{displayName(c.model)}</span>
            {hasTokens ? (
              <>
                <span className="text-[11px] font-mono text-center" title={`输入 tokens：未命中缓存 ${(c.uncached_input ?? 0).toLocaleString()} · 命中缓存 ${(c.cache_read_tokens ?? 0).toLocaleString()}`}>
                  <span className="text-[#f59e0b]">↓&nbsp;{fmtTokens(c.uncached_input)}</span>
                  {c.cache_read_tokens > 0 && <span className="text-[#30b48b]"> ↻&nbsp;{fmtTokens(c.cache_read_tokens)}</span>}
                </span>
                <span className="text-[11px] font-mono text-center text-[#5e5ce6]" title={`输出 tokens：${(c.output_tokens ?? 0).toLocaleString()}`}>↑&nbsp;{fmtTokens(c.output_tokens)}</span>
              </>
            ) : (
              <>
                <span className="text-xs font-mono text-center text-[#aeaeb2]">--</span>
                <span className="text-xs font-mono text-center text-[#aeaeb2]">--</span>
              </>
            )}
            <span className="text-xs font-mono text-center text-[#aeaeb2]">{c.duration_ms >= 1000 ? `${(c.duration_ms / 1000).toFixed(1)}s` : `${c.duration_ms}ms`}</span>
            <span className="text-xs font-mono font-medium text-center text-[#6e6e73]">{c.total_cost > 0 ? formatCost(c.total_cost, currency, rates) : '--'}</span>
          </a>
        );
      })}
      {!calls.length && <div className="py-12 text-center text-sm text-[#aeaeb2]">暂无调用记录</div>}
    </div>
  );
}
