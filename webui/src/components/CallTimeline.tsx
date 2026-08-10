import { useCurrency, formatCost } from '../lib/currency';
import { formatTime } from '../lib/utils';

/** 供应商名称展示映射 */
const PROVIDER_DISPLAY: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
};

function providerLabel(raw: string): string {
  return PROVIDER_DISPLAY[raw] || raw.charAt(0).toUpperCase() + raw.slice(1);
}

/** Token 数量短格式 */
function fmtTokens(n: number | null | undefined): string {
  if (n == null || n === 0) return '0';
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

export default function CallTimeline({ calls }: { calls: any[] }) {
  const { currency, rates } = useCurrency();
  return (
    <div>
      {calls.map((c, i) => {
        const ok = c.status_code === 200;
        const sc = ok ? '#30b48b' : c.status_code === 429 ? '#e69900' : '#e03a3a';
        const hasTokens = (c.prompt_tokens || c.output_tokens || c.cache_read_tokens || c.uncached_input);
        return (
          <a key={c.id} href={`/calls/${c.id}`} onClick={(e) => { e.preventDefault(); window.history.pushState({}, '', `/calls/${c.id}`); window.dispatchEvent(new PopStateEvent('popstate')); }}
            className="flex items-center gap-3 px-5 py-2.5 hover:bg-[#f5f5f7] transition-colors group text-sm"
            style={{ textDecoration: 'none', color: 'inherit', borderBottom: i === calls.length - 1 ? 'none' : '1px solid #f0f0f4' }}>
            <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: sc }} />
            <span className="text-xs font-mono w-14 flex-shrink-0 text-[#aeaeb2]">{formatTime(c.created_at, 'time')}</span>
            <span className="px-1.5 py-0.5 rounded text-[10px] font-mono font-medium w-10 text-center flex-shrink-0 bg-[#f0f0f4] text-[#6e6e73]">{c.method}</span>
            <span className="text-xs flex-1 truncate font-mono text-[#6e6e73]">{providerLabel(c.provider)}</span>
            {hasTokens ? (
              <>
                <span className="text-[11px] font-mono w-24 text-right flex-shrink-0 text-[#6e6e73]" title={`缓存命中 ${fmtTokens(c.cache_read_tokens)} / 未命中 ${fmtTokens(c.uncached_input)}`}>↧&nbsp;{fmtTokens(c.cache_read_tokens)}/{fmtTokens(c.uncached_input)}</span>
                <span className="text-[11px] font-mono w-16 text-right flex-shrink-0 text-[#6e6e73]">↥&nbsp;{fmtTokens(c.output_tokens)}</span>
              </>
            ) : (
              <span className="text-xs flex-1 font-mono text-[#aeaeb2]">--</span>
            )}
            <span className="text-xs font-mono w-14 text-right flex-shrink-0 text-[#aeaeb2]">{c.duration_ms >= 1000 ? `${(c.duration_ms / 1000).toFixed(1)}s` : `${c.duration_ms}ms`}</span>
            <span className="text-xs font-mono font-medium w-24 text-right flex-shrink-0 text-[#6e6e73]">{c.total_cost > 0 ? formatCost(c.total_cost, currency, rates) : '--'}</span>
          </a>
        );
      })}
      {!calls.length && <div className="py-12 text-center text-sm text-[#aeaeb2]">暂无调用记录</div>}
    </div>
  );
}
