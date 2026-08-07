import { useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as api from '../api/client';
import { useCurrency, formatCost } from '../lib/currency';
import CallTimeline from '../components/CallTimeline';

export default function SessionDetail() {
  const { id } = useParams<{ id: string }>();
  const sessionId = Number(id);
  const { currency, rates } = useCurrency();
  const qc = useQueryClient();
  const { data: s } = useQuery({ queryKey: ['session', sessionId], queryFn: () => api.getSession(sessionId), enabled: !!sessionId });
  const { data: calls } = useQuery({ queryKey: ['calls', sessionId], queryFn: () => api.listCalls(sessionId, undefined, undefined, 200, 0), enabled: !!sessionId });
  const { data: providers } = useQuery({ queryKey: ['providers'], queryFn: () => api.listProviders() });

  if (!s) return <div className="p-8 text-sm text-[#aeaeb2]">加载中...</div>;

  const enabledProviders = (providers || []).filter((p: any) => p.enabled);
  const currentUpstream = s.upstream_provider || '';

  return (
    <div className="p-8 max-w-5xl mx-auto space-y-6 animate-in">
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-lg font-bold text-[#1d1d1f]">{s.label || `会话 #${s.id}`}</h1>
            <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${s.status === 'active' ? 'bg-[#e6f7f1] text-[#30b48b]' : 'bg-[#f0f0f4] text-[#aeaeb2]'}`}>{s.status === 'active' ? '活跃中' : '已结束'}</span>
          </div>
          <div className="text-xs text-[#aeaeb2] mt-1 space-x-4"><span className="capitalize">{s.tool}</span><span>{s.first_call_at?.slice(0, 19)}</span><span>  </span><span>{s.last_call_at?.slice(0, 19)}</span></div>
        </div>
        <button onClick={async () => { const l = window.prompt('名称:', s.label || ''); if (l) { await api.renameSession(s.id, l); qc.invalidateQueries({ queryKey: ['session', sessionId] }); qc.invalidateQueries({ queryKey: ['sessions'] }); } }} className="btn btn-ghost">重命名</button>
      </div>

      {/* 上游选择器 */}
      <div className="p-4 rounded-xl bg-white border border-[#e5e5ea] shadow-sm">
        <div className="flex items-center gap-3">
          <span className="text-xs font-medium text-[#aeaeb2] uppercase tracking-wider">上游 API</span>
          <select
            className="text-sm border border-[#e5e5ea] rounded-lg px-3 py-1.5 bg-white text-[#1d1d1f] focus:outline-none focus:ring-2 focus:ring-[#0071e3] min-w-[200px]"
            value={currentUpstream}
            onChange={async (e) => {
              const val = e.target.value || null;
              await api.updateSessionUpstream(s.id, val);
              qc.invalidateQueries({ queryKey: ['session', sessionId] });
            }}
          >
            <option value="">跟随请求路径（{s.tool}）</option>
            {enabledProviders.map((p: any) => (
              <option key={p.provider} value={p.provider}>{p.provider}{p.base_url ? ` — ${p.base_url}` : ''}</option>
            ))}
          </select>
          {currentUpstream && (
            <span className="text-xs text-[#30b48b]">此会话所有请求将转发到 {currentUpstream} 上游</span>
          )}
        </div>
      </div>

      <div className="grid grid-cols-4 gap-4">
        {[{ l: '调用次数', v: s.request_count.toLocaleString() }, { l: '总费用', v: formatCost(s.total_cost, currency, rates), c: '#e69900' }, { l: 'Token 用量', v: `${(s.total_tokens / 1000).toFixed(0)}K` }, { l: '首次端点', v: s.first_endpoint || '--' }].map(k => (
          <div key={k.l} className="p-4 rounded-xl bg-white border border-[#e5e5ea] shadow-sm"><div className="text-[11px] font-medium uppercase tracking-wider text-[#aeaeb2] mb-1">{k.l}</div><div className="text-xl font-bold text-[#1d1d1f]" style={k.c ? { color: k.c } : {}}>{k.v}</div></div>
        ))}
      </div>

      <div className="rounded-xl bg-white border border-[#e5e5ea] shadow-sm">
        <div className="px-5 py-3 border-b border-[#e5e5ea] flex items-center gap-2"><h2 className="text-sm font-semibold text-[#1d1d1f]">调用时间线</h2><span className="text-xs font-mono text-[#aeaeb2]">{calls?.length || 0} 条</span></div>
        <CallTimeline calls={calls || []} />
      </div>
    </div>
  );
}
