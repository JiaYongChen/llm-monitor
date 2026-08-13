import { useCurrency, formatCost } from '../lib/currency';
import { formatTime } from '../lib/utils';
import { displayName } from '../lib/display';
import { extractThinking } from '@/shared/extractThinking';

function pj(raw: string | null): string {
  if (!raw) return '(空)';
  try { return JSON.stringify(JSON.parse(raw), null, 2); } catch { return raw; }
}

/** 键值对行 */
function KV({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-start gap-2 py-1.5">
      <span className="text-[11px] font-medium text-[#aeaeb2] w-20 shrink-0">{label}</span>
      <span className={`text-xs text-[#1d1d1f] break-all ${mono ? 'font-mono' : ''}`}>{value || '—'}</span>
    </div>
  );
}

export default function CallDetailPanel({ call }: { call: any }) {
  const { currency, rates } = useCurrency();
  const ok = call.status_code === 200;
  const sc = ok ? '#30b48b' : call.status_code === 429 ? '#e69900' : '#e03a3a';

  return (
    <div className="max-w-3xl mx-auto space-y-5 animate-in">
      {/* 下游请求 */}
      <div className="rounded-xl bg-white border border-[#e5e5ea] shadow-sm p-5">
        <h3 className="text-sm font-semibold text-[#1d1d1f] mb-2">下游请求</h3>
        <div className="flex items-center gap-2">
          <span className="px-1.5 py-0.5 rounded text-[10px] font-mono font-medium bg-[#f0f0f4] text-[#6e6e73]">{call.method}</span>
          <span className="font-mono text-xs text-[#1d1d1f] break-all">{call.downstream_url || call.endpoint}</span>
        </div>
      </div>

      {/* 上游请求 */}
      {call.target_url && (
        <div className="rounded-xl bg-white border border-[#e5e5ea] shadow-sm p-5">
          <h3 className="text-sm font-semibold text-[#1d1d1f] mb-2">上游请求</h3>
          <div className="flex items-center gap-2">
            <span className="px-1.5 py-0.5 rounded text-[10px] font-mono font-medium bg-[#f0f0f4] text-[#6e6e73]">{call.method}</span>
            <span className="font-mono text-xs text-[#0071e3] break-all">{call.target_url}</span>
          </div>
        </div>
      )}

      {/* 连接与标识 */}
      <div className="rounded-xl bg-white border border-[#e5e5ea] shadow-sm p-5">
        <h3 className="text-sm font-semibold text-[#1d1d1f] mb-3">基本信息</h3>
        <div className="grid grid-cols-1 gap-x-6">
          <KV label="供应商" value={displayName(call.provider)} />
          <KV label="模型" value={displayName(call.model)} mono />
          <KV label="状态" value={
            ok ? `200 OK` : call.error_message ? `${call.status_code} ${call.error_message}` : `${call.status_code}`
          } mono />
          <KV label="耗时" value={`${(call.duration_ms / 1000).toFixed(2)}s`} mono />
          <KV label="时间" value={formatTime(call.created_at)} />
          <KV label="来源" value={call.source_ip ? `${call.source_ip}:${call.source_port || '?'}` : ''} mono />
        </div>
      </div>

      {/* token 与费用 */}
      <div className="rounded-xl bg-white border border-[#e5e5ea] shadow-sm p-5">
        <h3 className="text-sm font-semibold text-[#1d1d1f] mb-4">token 与费用</h3>
        {call.prompt_tokens != null || call.output_tokens != null ? (
          <>
            <div className="grid grid-cols-2 gap-4">
              <div className="p-4 rounded-lg bg-[#f0f0f4]">
                <div className="flex items-center gap-2 mb-3">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#5e5ce6" strokeWidth="2"><polyline points="9 10 4 15 9 20"/><path d="M20 4v7a4 4 0 01-4 4H4"/></svg>
                  <span className="text-xs font-semibold text-[#6e6e73]">输出</span>
                  <span className="text-xs font-mono ml-auto text-[#aeaeb2]">{call.output_tokens?.toLocaleString() || 0} token</span>
                </div>
                <div className="flex justify-between mt-3 pt-3 border-t border-[#e5e5ea]">
                  <span className="text-xs font-medium text-[#6e6e73]">输出费用</span>
                  <span className="text-sm font-mono font-semibold text-[#e69900]">{formatCost(call.output_cost, currency, rates)}</span>
                </div>
              </div>
              <div className="p-4 rounded-lg bg-[#f0f0f4]">
                <div className="flex items-center gap-2 mb-3">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#007aff" strokeWidth="2"><polyline points="15 14 20 9 15 4"/><path d="M4 20v-7a4 4 0 014-4h12"/></svg>
                  <span className="text-xs font-semibold text-[#6e6e73]">输入</span>
                  <span className="text-xs font-mono ml-auto text-[#aeaeb2]">{call.prompt_tokens?.toLocaleString() ?? '0'} token</span>
                </div>
                <Line l="未缓存" n={call.uncached_input > 0 ? call.uncached_input : 0} c="#6e6e73" />
                {call.cache_write_tokens > 0 && <Line l="写入缓存" n={call.cache_write_tokens} c="#e69900" />}
                {call.cache_read_tokens > 0 && <Line l="命中缓存" n={call.cache_read_tokens} c="#30b48b" />}
                <div className="flex justify-between mt-3 pt-3 border-t border-[#e5e5ea]">
                  <span className="text-xs font-medium text-[#6e6e73]">输入费用</span>
                  <span className="text-sm font-mono font-semibold text-[#e69900]">{formatCost(call.input_cost, currency, rates)}</span>
                </div>
              </div>
            </div>
            <div className="flex items-center justify-between p-4 mt-4 rounded-lg bg-[#e8e7ff] border border-[#d4d2f8]">
              <span className="text-sm font-semibold text-[#1d1d1f]">合计</span>
              <div className="text-right">
                <span className="text-lg font-mono font-bold text-[#5e5ce6]">{formatCost(call.total_cost, currency, rates)}</span>
                {call.cache_savings > 0 && <div className="text-[11px] text-[#30b48b]">缓存节省 {formatCost(call.cache_savings, currency, rates)}</div>}
              </div>
            </div>
          </>
        ) : (
          <div className="text-xs text-[#aeaeb2]">无 token 数据（非聊天请求或未成功响应）</div>
        )}
      </div>

      {extractThinking(call.response_body) && (
        <ThinkingCard thinking={extractThinking(call.response_body)!} />
      )}

      <CodeBlock title="请求体" raw={call.request_body} />
      <CodeBlock title="响应体" raw={call.response_body} />
    </div>
  );
}

function Line({ l, n, c }: { l: string; n: number; c: string }) {
  return <div className="flex items-center justify-between text-[11px] py-1"><div className="flex items-center gap-2"><span className="w-1 h-1 rounded-full" style={{ background: c }} /><span className="text-[#6e6e73]">{l}</span></div><span className="font-mono text-[#aeaeb2]">{n.toLocaleString()}</span></div>;
}

/** 思考过程卡片 — 始终显示全文，带滚动条 */
function ThinkingCard({ thinking }: { thinking: string }) {
  return (
    <div className="rounded-xl bg-white border border-[#e5e5ea] shadow-sm">
      <div className="flex items-center gap-2 px-5 py-3 border-b border-[#f0f0f4]">
        <span className="text-sm">🧠</span>
        <span className="text-sm font-semibold text-[#1d1d1f]">思考过程</span>
        <span className="text-[10px] font-mono text-[#aeaeb2]">{thinking.length} 字</span>
      </div>
      <div className="mx-[10px] mb-[10px] mt-2 p-4 max-h-48 overflow-y-auto scrollbar-visible bg-[#f0f0f4] rounded-lg">
        <p className="text-xs leading-relaxed whitespace-pre-wrap text-[#8e8e93] italic">{thinking}</p>
      </div>
    </div>
  );
}

function CodeBlock({ title, raw }: { title: string; raw: string | null }) {
  const text = pj(raw);

  return (
    <div className="rounded-xl bg-white border border-[#e5e5ea] shadow-sm">
      <div className="flex items-center gap-2 px-5 py-3 border-b border-[#f0f0f4]">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#5e5ce6" strokeWidth="2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
        <span className="text-sm font-semibold text-[#1d1d1f]">{title}</span>
        <span className="text-[10px] font-mono text-[#aeaeb2]">{text.length} B</span>
      </div>
      <div className="mx-[10px] mb-[10px] mt-2 p-4 max-h-64 overflow-y-auto scrollbar-visible bg-[#f0f0f4] rounded-lg">
        <pre className="text-[11px] leading-relaxed font-mono whitespace-pre-wrap text-[#6e6e73]">{text}</pre>
      </div>
    </div>
  );
}

