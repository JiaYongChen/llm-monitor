import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as api from '../api/client';
import { useCurrency, formatCost } from '../lib/currency';
import { formatTime } from '../lib/utils';
import CallTimeline from '../components/CallTimeline';
import { Dialog, DialogHeader, DialogTitle, DialogDescription } from '../components/ui/dialog';
import { Button } from '../components/ui/button';

export default function SessionDetail() {
  const { id } = useParams<{ id: string }>();
  const sessionId = Number(id);
  const { currency, rates } = useCurrency();
  const qc = useQueryClient();
  const nav = useNavigate();
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const { data: s } = useQuery({ queryKey: ['session', sessionId], queryFn: () => api.getSession(sessionId), enabled: !!sessionId });
  const { data: calls } = useQuery({ queryKey: ['calls', sessionId], queryFn: () => api.listCalls(sessionId, undefined, undefined, 10000, 0), enabled: !!sessionId });
  const { data: providers } = useQuery({ queryKey: ['providers'], queryFn: () => api.listProviders() });
  const { data: pricing } = useQuery({ queryKey: ['pricing'], queryFn: () => api.listPricing() });

  if (!s) return <div className="p-8 text-sm text-[#aeaeb2]">加载中...</div>;

  const callsList = calls || [];
  const uncachedTokens = callsList.reduce((sum: number, c: any) => sum + (c.uncached_input || 0), 0);
  const cacheHitTokens = callsList.reduce((sum: number, c: any) => sum + (c.cache_read_tokens || 0), 0);
  const outputTokens = callsList.reduce((sum: number, c: any) => sum + (c.output_tokens || 0), 0);

  // 工具本身对应的内置供应商无需覆写（ClaudeCode→Anthropic, codex→OpenAI）
  const toolBuiltin = s.tool === 'ClaudeCode' ? 'Anthropic' : s.tool === 'codex' ? 'OpenAI' : null;
  const enabledProviders = (providers || []).filter((p: any) => p.enabled && p.provider !== toolBuiltin);
  const enabledProviderNames = new Set(enabledProviders.map((p: any) => p.provider));
  // 如果当前上游已被停用，自动切回跟随请求
  const currentUpstream = s.upstream_provider && enabledProviderNames.has(s.upstream_provider) ? s.upstream_provider : '';
  const currentModel = currentUpstream ? s.upstream_model || '' : '';
  // 模型列表跟随代理商：选了代理商则只显示该代理商的模型，否则显示全部，按添加顺序排列
  const modelOrder = (pricing || [])
    .filter((p: any) => !currentUpstream || p.provider === currentUpstream)
    .sort((a: any, b: any) => a.id - b.id);
  const seen = new Set<string>();
  const models = modelOrder.filter((p: any) => {
    if (seen.has(p.model)) return false;
    seen.add(p.model);
    return true;
  }).map((p: any) => p.model as string);

  return (
    <div className="p-8 max-w-5xl mx-auto space-y-6 animate-in">
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-lg font-bold text-[#1d1d1f]">{s.label || `会话 #${s.id}`}</h1>
            <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${s.status === 'active' ? 'bg-[#e6f7f1] text-[#30b48b]' : 'bg-[#f0f0f4] text-[#aeaeb2]'}`}>{s.status === 'active' ? '活跃中' : '已结束'}</span>
          </div>
          <div className="text-xs text-[#aeaeb2] mt-1 space-x-4"><span className="capitalize">{s.tool}</span><span>{formatTime(s.first_call_at)}</span><span>  </span><span>{formatTime(s.last_call_at)}</span></div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={async () => { const l = window.prompt('名称:', s.label || ''); if (l) { await api.renameSession(s.id, l); qc.invalidateQueries({ queryKey: ['session', sessionId] }); qc.invalidateQueries({ queryKey: ['sessions'] }); } }} className="btn btn-ghost">重命名</button>
          <button onClick={() => setDeleteConfirm(true)} className="btn btn-ghost text-[#e03a3a] hover:text-[#e03a3a]">删除</button>
        </div>
      </div>

      {/* 上游选择器 */}
      <div className="p-4 rounded-xl bg-white border border-[#e5e5ea] shadow-sm space-y-3">
        <div className="flex items-center gap-3">
          <span className="text-xs font-medium text-[#aeaeb2] uppercase tracking-wider w-14 shrink-0">供应商</span>
          <select
            className="text-sm border border-[#e5e5ea] rounded-lg px-3 py-1.5 bg-white text-[#1d1d1f] focus:outline-none focus:ring-2 focus:ring-[#0071e3] min-w-[200px]"
            value={currentUpstream}
            onChange={async (e) => {
              const val = e.target.value || null;
              await api.updateSessionUpstream(s.id, val);
              if (!val) {
                // 切回跟随请求路径 → 清除模型
                await api.updateSessionModel(s.id, null);
              } else {
                // 第三方供应商 → 默认选第一个模型
                const filteredModels = [...new Set<string>((pricing || [])
                  .filter((p: any) => p.provider === val)
                  .map((p: any) => p.model as string)
                )].sort();
                await api.updateSessionModel(s.id, filteredModels[0] || null);
              }
              qc.invalidateQueries({ queryKey: ['session', sessionId] });
            }}
          >
            <option value="">跟随请求路径（{s.tool}）</option>
            {enabledProviders.map((p: any) => (
              <option key={p.provider} value={p.provider}>{p.provider}</option>
            ))}
          </select>
          {currentUpstream && (() => {
            const officialUrls: Record<string, string> = { Anthropic: 'https://api.anthropic.com', OpenAI: 'https://api.openai.com' };
            const up = (providers || []).find((p: any) => p.provider === currentUpstream);
            const baseUrl = (s.tool === 'ClaudeCode' && up?.base_url_anthropic)
              ? up.base_url_anthropic
              : (up?.base_url || officialUrls[currentUpstream] || '');
            const targetPath = baseUrl.toLowerCase().includes('anthropic') ? '/v1/messages' : '/v1/chat/completions';
            const fullUrl = baseUrl ? `${baseUrl.replace(/\/$/, '')}${targetPath}` : '';
            return <span className="text-xs text-[#30b48b]">转发到 {currentUpstream}{fullUrl ? ` — ${fullUrl}` : ''}</span>;
          })()}
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs font-medium text-[#aeaeb2] uppercase tracking-wider w-14 shrink-0">模型</span>
          {currentUpstream ? (
            <select
              className="text-sm border border-[#e5e5ea] rounded-lg px-3 py-1.5 bg-white text-[#1d1d1f] focus:outline-none focus:ring-2 focus:ring-[#0071e3] min-w-[200px]"
              value={currentModel}
              onChange={async (e) => {
                const val = e.target.value || null;
                await api.updateSessionModel(s.id, val);
                qc.invalidateQueries({ queryKey: ['session', sessionId] });
              }}
            >
              {models.map((m: string) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          ) : (
            <span className="text-sm text-[#aeaeb2] px-3 py-1.5">跟随客户端请求</span>
          )}
          {currentModel && (
            <span className="text-xs text-[#0071e3]">强制使用 {currentModel}</span>
          )}
        </div>
      </div>

      <div className="grid grid-cols-5 gap-4">
        {[{ l: '调用次数', v: s.request_count.toLocaleString() }, { l: '总费用', v: formatCost(s.total_cost, currency, rates), c: '#e69900' }, { l: '输出 tokens', v: outputTokens.toLocaleString() }, { l: '输入 tokens (未命中缓存)', v: uncachedTokens.toLocaleString() }, { l: '输入 tokens (命中缓存)', v: cacheHitTokens.toLocaleString(), c: '#30b48b' }].map(k => (
          <div key={k.l} className="p-4 rounded-xl bg-white border border-[#e5e5ea] shadow-sm"><div className="text-[11px] font-medium uppercase tracking-wider text-[#aeaeb2] mb-1">{k.l}</div><div className="text-xl font-bold text-[#1d1d1f]" style={k.c ? { color: k.c } : {}}>{k.v}</div></div>
        ))}
      </div>

      <div className="rounded-xl bg-white border border-[#e5e5ea] shadow-sm">
        <div className="px-5 py-3 border-b border-[#e5e5ea] flex items-center gap-2"><h2 className="text-sm font-semibold text-[#1d1d1f]">调用时间线</h2><span className="text-xs font-mono text-[#aeaeb2]">{calls?.length || 0} 条</span></div>
        <CallTimeline calls={calls || []} />
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
