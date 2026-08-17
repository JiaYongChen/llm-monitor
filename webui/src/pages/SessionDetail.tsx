import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as api from '../api/client';
import { useCurrency, formatCost } from '../lib/currency';
import { formatTime } from '../lib/utils';
import { displayName } from '../lib/display';
import CallTimeline from '../components/CallTimeline';
import KpiCards from '../components/KpiCards';
import UpstreamSelectorPanel, { builtinProviderFor } from '../components/UpstreamSelectorPanel';
import { Dialog, DialogHeader, DialogTitle, DialogDescription } from '../components/ui/dialog';
import { Button } from '../components/ui/button';

/** 时间线分页大小 */
const PAGE_SIZE = 50;

export default function SessionDetail() {
  const { id } = useParams<{ id: string }>();
  const sessionId = Number(id);
  const { currency, rates } = useCurrency();
  const qc = useQueryClient();
  const nav = useNavigate();
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [page, setPage] = useState(1);
  // 切换会话时回到第一页
  useEffect(() => { setPage(1); }, [sessionId]);
  const { data: s } = useQuery({ queryKey: ['session', sessionId], queryFn: () => api.getSession(sessionId), enabled: !!sessionId, refetchInterval: 10000 });
  const { data: calls } = useQuery({ queryKey: ['calls', sessionId, page], queryFn: () => api.listCalls(sessionId, undefined, undefined, PAGE_SIZE, (page - 1) * PAGE_SIZE), enabled: !!sessionId, refetchInterval: 10000 });
  const { data: callsCount } = useQuery({ queryKey: ['calls-count', sessionId], queryFn: () => api.countCalls(sessionId), enabled: !!sessionId, refetchInterval: 10000 });
  const { data: tokenStats } = useQuery({ queryKey: ['session-token-stats', sessionId], queryFn: () => api.getSessionTokenStats(sessionId), enabled: !!sessionId, refetchInterval: 10000 });
  const { data: providers } = useQuery({ queryKey: ['providers'], queryFn: () => api.listProviders() });
  const { data: pricing } = useQuery({ queryKey: ['pricing'], queryFn: () => api.listPricing() });

  if (!s) return <div className="p-8 text-sm text-[#aeaeb2]">加载中...</div>;

  // Token 分项统计来自后端全量聚合，不受时间线分页影响
  const uncachedTokens = tokenStats?.uncached_input || 0;
  const cacheHitTokens = tokenStats?.cache_read_tokens || 0;
  const outputTokens = tokenStats?.output_tokens || 0;
  const totalCalls = callsCount?.count || 0;
  const totalPages = Math.max(1, Math.ceil(totalCalls / PAGE_SIZE));

  // 工具对应的内置供应商无需覆写（claudecode→anthropic, codex→openai；大小写不敏感）
  const enabledProviders = (providers || []).filter((p: any) => p.enabled && p.provider !== builtinProviderFor(s.tool));
  const enabledProviderNames = new Set(enabledProviders.map((p: any) => p.provider));
  // 如果当前上游已被停用，自动切回跟随请求
  const currentUpstream = s.upstream_provider && enabledProviderNames.has(s.upstream_provider) ? s.upstream_provider : '';
  const currentModel = currentUpstream ? s.upstream_model || '' : '';

  return (
    <div className="p-8 max-w-5xl mx-auto space-y-6 animate-in">
      <div className="flex items-start justify-between sticky top-0 z-10 bg-[#f5f5f7] -mt-8 pt-8 pb-3 -mb-3">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-lg font-bold text-[#1d1d1f]">{s.label || `会话 #${s.id}`}</h1>
            <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${s.status === 'active' ? 'bg-[#e6f7f1] text-[#30b48b]' : 'bg-[#f0f0f4] text-[#aeaeb2]'}`}>{s.status === 'active' ? '活跃中' : '已结束'}</span>
          </div>
          <div className="text-xs text-[#aeaeb2] mt-1 space-x-4"><span>{displayName(s.tool)}</span><span>{formatTime(s.first_call_at)}</span><span>  </span><span>{formatTime(s.last_call_at)}</span></div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={async () => { const l = window.prompt('名称:', s.label || ''); if (l) { await api.renameSession(s.id, l); qc.invalidateQueries({ queryKey: ['session', sessionId] }); qc.invalidateQueries({ queryKey: ['sessions'] }); } }} className="btn btn-ghost">重命名</button>
          <button onClick={() => setDeleteConfirm(true)} className="btn btn-ghost text-[#e03a3a] hover:text-[#e03a3a]">删除</button>
        </div>
      </div>

      {/* 上游选择器：共用面板（providers 传全量，面板内部排除内置供应商） */}
      <UpstreamSelectorPanel
        tool={s.tool || ''}
        provider={currentUpstream}
        model={currentModel}
        providers={providers || []}
        pricing={pricing || []}
        onProviderChange={async (next, defaultModel) => {
          await api.updateSessionUpstream(s.id, next);
          // 切回跟随请求路径 → 清除模型；第三方供应商 → 默认选第一个模型（由面板回传）
          await api.updateSessionModel(s.id, next ? defaultModel : null);
          qc.invalidateQueries({ queryKey: ['session', sessionId] });
        }}
        onModelChange={async (next) => {
          await api.updateSessionModel(s.id, next);
          qc.invalidateQueries({ queryKey: ['session', sessionId] });
        }}
      />

      <KpiCards items={[
        { label: '调用次数', value: s.request_count.toLocaleString() },
        { label: '总费用', value: formatCost(s.total_cost, currency, rates), valueColor: '#e69900' },
        { label: '输出 tokens', value: outputTokens.toLocaleString() },
        { label: '输入 tokens (未命中缓存)', value: uncachedTokens.toLocaleString() },
        { label: '输入 tokens (命中缓存)', value: cacheHitTokens.toLocaleString(), valueColor: '#30b48b' },
      ]} />

      <div className="rounded-xl bg-white border border-[#e5e5ea] shadow-sm">
        <div className="px-5 py-3 border-b border-[#e5e5ea] flex items-center gap-2"><h2 className="text-sm font-semibold text-[#1d1d1f]">调用时间线</h2><span className="text-xs font-mono text-[#aeaeb2]">共 {totalCalls} 条</span></div>
        <div className="max-h-[50vh] overflow-y-auto scrollbar-visible">
          <CallTimeline calls={calls || []} />
        </div>
        {totalPages > 1 && (
          <div className="px-5 py-2.5 border-t border-[#e5e5ea] flex items-center justify-center gap-3">
            <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>‹ 上一页</Button>
            <span className="text-xs font-mono text-[#aeaeb2]">第 {page} / {totalPages} 页</span>
            <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>下一页 ›</Button>
          </div>
        )}
      </div>

      <Dialog open={deleteConfirm} onClose={() => setDeleteConfirm(false)}>
        <DialogHeader>
          <DialogTitle>删除会话</DialogTitle>
          <DialogDescription>确认删除会话 #{s.id}？其下所有调用记录也将被删除，此操作不可恢复。</DialogDescription>
        </DialogHeader>
        <div className="flex gap-2 pt-2">
          <Button variant="destructive" size="sm" onClick={async () => { await api.deleteSession(s.id); qc.invalidateQueries({ queryKey: ['sessions'] }); nav('/'); }}>确认删除</Button>
          <Button variant="outline" size="sm" onClick={() => setDeleteConfirm(false)}>取消</Button>
        </div>
      </Dialog>
    </div>
  );
}
