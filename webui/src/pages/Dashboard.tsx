import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as api from '../api/client';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { Activity, Zap, Layers } from 'lucide-react';
import { useCurrency, formatCost, CURRENCIES, PROVIDER_COLORS } from '../lib/currency';

/** 工具侧边栏图标颜色映射 */
const TOOL_COLORS: Record<string, string> = {
  ClaudeCode: '#d97706', codex: '#16a34a',
};
/** 工具显示名称映射 */
const TOOL_DISPLAY: Record<string, string> = {
  ClaudeCode: 'ClaudeCode', codex: 'Codex',
};
/** 供应商显示名称映射 */
const PROVIDER_DISPLAY: Record<string, string> = {
  Anthropic: 'Anthropic', OpenAI: 'OpenAI',
};
/** 总览图标颜色（侧边栏激活态紫色） */
const OVERVIEW_COLOR = '#5e5ce6';

export default function Dashboard() {
  const { currency, rates } = useCurrency();
  const sym = CURRENCIES[currency].symbol;
  const [searchParams] = useSearchParams();
  const provider = searchParams.get('provider') || undefined;
  const tool = searchParams.get('tool') || undefined;
  const qc = useQueryClient();

  // 工具级上游配置
  const { data: toolConfigs } = useQuery({ queryKey: ['tool-configs'], queryFn: () => api.listToolConfigs() });
  const { data: providers } = useQuery({ queryKey: ['providers'], queryFn: () => api.listProviders() });
  const { data: pricing } = useQuery({ queryKey: ['pricing'], queryFn: () => api.listPricing() });
  const toolConfig = (toolConfigs as any[])?.find((t: any) => t.tool === tool);

  /** 根据当前筛选状态决定标题文本和颜色 */
  const pageTitle = provider ? (PROVIDER_DISPLAY[provider] || provider) : tool ? (TOOL_DISPLAY[tool] || tool) : '总览';
  const titleColor = provider
    ? (PROVIDER_COLORS[provider] || OVERVIEW_COLOR)
    : tool
      ? (TOOL_COLORS[tool] || OVERVIEW_COLOR)
      : OVERVIEW_COLOR;

  const statsGroupBy = provider ? 'model' : tool ? 'provider' : 'tool';
  const { data: stats } = useQuery({ queryKey: ['stats', statsGroupBy, provider, tool], queryFn: () => api.getStats(statsGroupBy, provider, tool), refetchInterval: 5000 });
  const totalCalls = stats?.reduce((a: number, b: any) => a + b.count, 0) || 0;
  const totalCost = stats?.reduce((a: number, b: any) => a + b.total_cost, 0) || 0;
  const totalInput = stats?.reduce((a: number, b: any) => a + (b.total_input_tokens || 0), 0) || 0;
  const totalOutput = stats?.reduce((a: number, b: any) => a + (b.total_output_tokens || 0), 0) || 0;
  const totalCacheRead = stats?.reduce((a: number, b: any) => a + (b.total_cache_read_tokens || 0), 0) || 0;
  const maxCost = Math.max(...(stats || []).map((s: any) => s.total_cost), 0.0001);
  const bars = ['#6366f1', '#10b981', '#3b82f6', '#f59e0b', '#8b5cf6', '#ef4444', '#06b6d4', '#f97316'];
  return (
    <div className="p-8 max-w-6xl mx-auto space-y-6 animate-in">
      <div className="relative flex items-center justify-center">
        <h1 className="text-2xl font-bold tracking-tight" style={{ color: titleColor }}>{pageTitle}</h1>
        {totalCalls > 0 && (
          <Badge variant="secondary" className="absolute right-0 gap-1.5">
            <span className="relative flex h-2 w-2"><span className="animate-ping absolute h-2 w-2 rounded-full bg-green-400 opacity-75" /><span className="relative rounded-full h-2 w-2 bg-green-500" /></span>
            实时监控中
          </Badge>
        )}
      </div>

      {/* 工具级上游配置（仅在筛选到具体工具时显示） */}
      {tool && providers && (
        <div className="p-4 rounded-xl bg-white border border-[#e5e5ea] shadow-sm">
          <div className="flex items-center gap-4">
            <span className="text-xs font-medium text-[#aeaeb2] uppercase tracking-wider shrink-0">默认上游</span>
            <select
              className="text-sm border border-[#e5e5ea] rounded-lg px-3 py-1.5 bg-white text-[#1d1d1f] focus:outline-none focus:ring-2 focus:ring-[#0071e3] min-w-[180px]"
              value={toolConfig?.upstream_provider || ''}
              onChange={async (e) => {
                const val = e.target.value || null;
                await api.updateToolConfig(tool, val, val ? toolConfig?.upstream_model || null : null);
                qc.invalidateQueries({ queryKey: ['tool-configs'] });
              }}
            >
              <option value="">跟随请求路径</option>
              {(providers as any[])?.filter((p: any) => p.enabled).map((p: any) => (
                <option key={p.provider} value={p.provider}>{p.provider}</option>
              ))}
            </select>
            {toolConfig?.upstream_provider && (
              <>
                <span className="text-xs font-medium text-[#aeaeb2] uppercase tracking-wider shrink-0">默认模型</span>
                <select
                  className="text-sm border border-[#e5e5ea] rounded-lg px-3 py-1.5 bg-white text-[#1d1d1f] focus:outline-none focus:ring-2 focus:ring-[#0071e3] min-w-[200px]"
                  value={toolConfig?.upstream_model || ''}
                  onChange={async (e) => {
                    const val = e.target.value || null;
                    await api.updateToolConfig(tool, toolConfig.upstream_provider, val);
                    qc.invalidateQueries({ queryKey: ['tool-configs'] });
                  }}
                >
                  <option value="">跟随客户端请求</option>
                  {[...new Set<string>(((pricing as any[]) || []).filter((p: any) => p.provider === toolConfig.upstream_provider).map((p: any) => p.model as string))].map((m: string) => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
              </>
            )}
          </div>
        </div>
      )}

      {/* KPI 卡片 */}
      <div className={`grid gap-4 ${provider ? 'grid-cols-5' : 'grid-cols-4'}`}>
        {[
          { l: '总调用次数', v: totalCalls.toLocaleString(), s: undefined, icon: Activity, c: 'text-violet-500' },
          { l: '累计费用', v: formatCost(totalCost, currency, rates), icon: ({ className }: any) => <span className={className}>{sym}</span>, c: 'text-amber-500' },
          { l: '输出 Token', v: totalOutput >= 1000 ? `${(totalOutput / 1000).toFixed(0)}K` : String(totalOutput), icon: Zap, c: 'text-sky-500' },
          { l: '输入 Token', v: totalInput >= 1000 ? `${(totalInput / 1000).toFixed(0)}K` : String(totalInput), icon: Zap, c: 'text-blue-500' },
          ...(provider ? [
            { l: '缓存命中率', v: totalInput > 0 ? `${(totalCacheRead / totalInput * 100).toFixed(1)}%` : '--', s: totalCacheRead > 0 ? `${(totalCacheRead / 1000).toFixed(0)}K 命中` : '暂无缓存命中', icon: Layers, c: 'text-emerald-500' },
          ] : []),
        ].map(k => (
          <Card key={k.l}>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-xs font-medium uppercase tracking-wider text-gray-500">{k.l}</CardTitle>
              <k.icon className={`h-4 w-4 ${k.c}`} />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{k.v}</div>
              {k.s && <p className="text-xs text-gray-500 mt-1">{k.s}</p>}
            </CardContent>
          </Card>
        ))}
      </div>

      {/* 费用分布 */}
      <Card>
        <CardHeader><CardTitle className="text-base">费用分布</CardTitle></CardHeader>
        <CardContent>
          {stats?.some((s: any) => s.total_cost > 0) ? (
            <div className="space-y-4">
              {stats.filter((s: any) => s.total_cost > 0).sort((a: any, b: any) => b.total_cost - a.total_cost).map((s: any, i: number) => {
                  const displayKey = Object.keys(PROVIDER_COLORS).find(k => k.toLowerCase() === s.key?.toLowerCase()) || PROVIDER_DISPLAY[s.key] || s.key;
                  return (
                <div key={s.key}>
                  <div className="flex items-center justify-between mb-1.5 text-sm">
                    <span className="font-medium">{displayKey}</span>
                    <span className="font-mono text-gray-500">{formatCost(s.total_cost, currency, rates)}</span>
                  </div>
                  <div className="h-2 rounded-full bg-secondary overflow-hidden">
                    <div className="h-full rounded-full transition-all duration-700" style={{ width: `${Math.max((s.total_cost / maxCost) * 100, 2)}%`, background: bars[i % bars.length] }} />
                  </div>
                </div>
                  );
                })}
            </div>
          ) : <p className="text-sm text-gray-500 text-center py-8">暂无数据 — 启动 CLI 工具后自动统计</p>}
        </CardContent>
      </Card>
    </div>
  );
}
