import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as api from '../api/client';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { Activity, Zap, Layers } from 'lucide-react';
import DailyBarChart from '../components/DailyBarChart';
import DailyCostBarChart from '../components/DailyCostBarChart';
import { useCurrency, formatCost, CURRENCIES } from '../lib/currency';
import { useCategoryColors, categoryColor } from '../lib/colors';
import { displayName } from '../lib/display';

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
  // 工具名大小写不敏感匹配（URL 参数可能为任意大小写）
  const toolConfig = (toolConfigs as any[])?.find((t: any) => tool && t.tool.toLowerCase() === tool.toLowerCase());

  /** 根据当前筛选状态决定标题文本和颜色（注册表命中 → 类别色；未命中/未加载 → 总览紫） */
  const { data: colors } = useCategoryColors();
  const pageTitle = provider ? displayName(provider) : tool ? displayName(tool) : '总览';
  const titleColor = provider
    ? (categoryColor(provider, 'provider', colors) || OVERVIEW_COLOR)
    : tool
      ? (categoryColor(tool, 'tool', colors) || OVERVIEW_COLOR)
      : OVERVIEW_COLOR;

  // 统计/图表分组维度与图表类别取色维度（三视图统一：总览→tool、工具页→provider、供应商页→model）
  const groupBy = provider ? 'model' : tool ? 'provider' : 'tool';
  const { data: stats } = useQuery({ queryKey: ['stats', groupBy, provider, tool], queryFn: () => api.getStats(groupBy, provider, tool), refetchInterval: 5000 });
  const [dailyRange, setDailyRange] = useState('30d');
  // 时区为全局设置（设置页维护，metadata 持久化）；CurrencyProvider 已用同一 queryKey，共享缓存零重复请求
  const { data: config } = useQuery({ queryKey: ['config'], queryFn: api.getConfig });
  const dailyTz = Number(config?.timezone ?? 8);
  const { data: dailyStats } = useQuery({ queryKey: ['dailyStats', provider, tool, dailyRange, dailyTz], queryFn: () => api.getDailyStats(provider, tool, dailyRange, undefined, dailyTz), refetchInterval: 60000 });
  const { data: dailyModelStats } = useQuery({ queryKey: ['dailyStatsModel', provider, tool, dailyRange, dailyTz], queryFn: () => api.getDailyStats(provider, tool, dailyRange, 'model', dailyTz), enabled: !!provider, refetchInterval: 60000 });
  // 费用分布：与 Token 用量共用同一时间筛选（dailyRange/dailyTz）
  // provider 视图下与模型分布查询 URL 完全一致 → 直接复用 dailyModelStats，避免重复请求
  const { data: costDailyStats } = useQuery({
    queryKey: ['dailyCostStats', provider, tool, groupBy, dailyRange, dailyTz],
    queryFn: () => api.getDailyStats(provider, tool, dailyRange, groupBy, dailyTz),
    enabled: !(provider && groupBy === 'model'),
    refetchInterval: 60000,
  });
  const costDailyData = provider ? dailyModelStats : costDailyStats;

  const totalCalls = stats?.reduce((a: number, b: any) => a + b.count, 0) || 0;
  const totalCost = stats?.reduce((a: number, b: any) => a + b.total_cost, 0) || 0;
  const totalInput = stats?.reduce((a: number, b: any) => a + (b.total_input_tokens || 0), 0) || 0;
  const totalOutput = stats?.reduce((a: number, b: any) => a + (b.total_output_tokens || 0), 0) || 0;
  const totalCacheRead = stats?.reduce((a: number, b: any) => a + (b.total_cache_read_tokens || 0), 0) || 0;
  const totalUncached = stats?.reduce((a: number, b: any) => a + (b.total_uncached_input || 0), 0) || 0;
  return (
    <div className="p-8 max-w-6xl mx-auto space-y-6 animate-in">
      <div className="relative flex items-center justify-center sticky top-0 z-10 bg-[#f5f5f7] -mt-8 pt-8 pb-3 -mb-3">
        <h1 className="text-2xl font-bold tracking-tight" style={{ color: titleColor }}>{pageTitle}</h1>
        {totalCalls > 0 && (
          <Badge variant="secondary" className="absolute right-0 gap-1.5">
            <span className="relative flex h-2 w-2"><span className="animate-ping absolute h-2 w-2 rounded-full bg-green-400 opacity-75" /><span className="relative rounded-full h-2 w-2 bg-green-500" /></span>
            实时监控中
          </Badge>
        )}
      </div>

      {/* 工具级上游配置（仅在筛选到具体工具时显示） */}
      {tool && providers && (() => {
        // 工具本身对应的内置供应商无需覆写（claudecode→anthropic, codex→openai；大小写不敏感）
        const toolLower = (tool || '').toLowerCase();
        const toolBuiltin = toolLower === 'claudecode' ? 'anthropic' : toolLower === 'codex' ? 'openai' : null;
        const enabledProviders = (providers as any[]).filter((p: any) => p.enabled && p.provider !== toolBuiltin);
        const currentUpstream = toolConfig?.upstream_provider || '';
        const currentModel = toolConfig?.upstream_model || '';
        const modelOrder = ((pricing as any[]) || [])
          .filter((p: any) => !currentUpstream || p.provider === currentUpstream)
          .sort((a: any, b: any) => a.id - b.id);
        const seen = new Set<string>();
        const models = modelOrder.filter((p: any) => {
          if (seen.has(p.model)) return false;
          seen.add(p.model);
          return true;
        }).map((p: any) => p.model as string);
        return (
        <div className="p-4 rounded-xl bg-white border border-[#e5e5ea] shadow-sm space-y-3">
          <div className="flex items-center gap-3">
            <span className="text-xs font-medium text-[#aeaeb2] uppercase tracking-wider w-14 shrink-0">供应商</span>
            <select
              className="text-sm border border-[#e5e5ea] rounded-lg px-3 py-1.5 bg-white text-[#1d1d1f] focus:outline-none focus:ring-2 focus:ring-[#0071e3] w-[200px]"
              value={currentUpstream}
              onChange={async (e) => {
                const val = e.target.value || null;
                if (!val) {
                  await api.updateToolConfig(tool, null, null);
                } else {
                  const filteredModels = [...new Set<string>(((pricing as any[]) || [])
                    .filter((p: any) => p.provider === val)
                    .map((p: any) => p.model as string)
                  )].sort();
                  await api.updateToolConfig(tool, val, filteredModels[0] || null);
                }
                qc.invalidateQueries({ queryKey: ['tool-configs'] });
              }}
            >
              <option value="">跟随请求路径（{displayName(tool)}）</option>
              {enabledProviders.map((p: any) => (
                <option key={p.provider} value={p.provider}>{displayName(p.provider)}</option>
              ))}
            </select>
            {currentUpstream && (() => {
              const up = (providers as any[]).find((p: any) => p.provider === currentUpstream);
              const officialUrls: Record<string, string> = { anthropic: 'https://api.anthropic.com', openai: 'https://api.openai.com' };
              const baseUrl = (toolLower === 'claudecode' && up?.base_url_anthropic)
                ? up.base_url_anthropic
                : (up?.base_url || officialUrls[currentUpstream] || '');
              return <span className="text-xs text-[#30b48b]">转发到 {displayName(currentUpstream)} — <span className="font-mono">{baseUrl}</span></span>;
            })()}
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs font-medium text-[#aeaeb2] uppercase tracking-wider w-14 shrink-0">模型</span>
            {currentUpstream ? (
              <select
                className="text-sm border border-[#e5e5ea] rounded-lg px-3 py-1.5 bg-white text-[#1d1d1f] focus:outline-none focus:ring-2 focus:ring-[#0071e3] w-[200px]"
                value={currentModel}
                onChange={async (e) => {
                  const val = e.target.value || null;
                  await api.updateToolConfig(tool, currentUpstream, val);
                  qc.invalidateQueries({ queryKey: ['tool-configs'] });
                }}
              >
                {models.map((m: string) => (
                  <option key={m} value={m}>{displayName(m)}</option>
                ))}
              </select>
            ) : (
              <span className="text-sm text-[#aeaeb2] px-3 py-1.5">跟随客户端请求</span>
            )}
            {currentModel && (
              <span className="text-xs text-[#0071e3]">强制使用 {displayName(currentModel)}</span>
            )}
          </div>
        </div>
        );
      })()}

      {/* KPI 卡片 */}
      <div className={`grid gap-4 ${provider ? 'grid-cols-5' : 'grid-cols-4'}`}>
        {[
          { l: '总调用次数', v: totalCalls.toLocaleString(), s: undefined, icon: Activity, c: 'text-violet-500' },
          { l: '累计费用', v: formatCost(totalCost, currency, rates), icon: ({ className }: any) => <span className={className}>{sym}</span>, c: 'text-amber-500' },
          { l: '输出 tokens', v: totalOutput.toLocaleString(), icon: Zap, c: 'text-sky-500' },
          { l: '输入 tokens', v: (totalUncached + totalCacheRead).toLocaleString(),
            s: provider ? <><span>未命中: {totalUncached.toLocaleString()}</span><br /><span>命中: {totalCacheRead.toLocaleString()}</span></> : undefined, icon: Zap, c: 'text-blue-500' },
          ...(provider ? [
            { l: '缓存命中率', v: totalUncached + totalCacheRead > 0 ? `${(totalCacheRead / (totalUncached + totalCacheRead) * 100).toFixed(1)}%` : '--', s: totalCacheRead > 0 ? `${totalCacheRead.toLocaleString()} 命中` : '暂无缓存命中', icon: Layers, c: 'text-emerald-500' },
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

      {/* 费用分布（时间筛选与 Token 用量共用） */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-base">费用分布</CardTitle>
          <div className="flex items-center gap-2">
            <select
              className="text-sm border border-[#e5e5ea] rounded-lg px-2 py-1 bg-white text-[#6e6e73] focus:outline-none focus:ring-2 focus:ring-[#0071e3]"
              value={dailyRange}
              onChange={e => setDailyRange(e.target.value)}
            >
              <option value="yesterday">昨天</option>
              <option value="today">今天</option>
              <option value="7d">7 天</option>
              <option value="14d">14 天</option>
              <option value="30d">30 天</option>
              <option value="60d">60 天</option>
              <option value="thisMonth">本月</option>
              <option value="lastMonth">上月</option>
            </select>
          </div>
        </CardHeader>
        <CardContent>
          <DailyCostBarChart data={costDailyData || []} range={dailyRange} tz={dailyTz} categoryKind={groupBy} />
        </CardContent>
      </Card>

      {/* 每日调用量和 token 用量趋势（所有视图，时间筛选与费用分布共用） */}
      {dailyStats && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Token 用量</CardTitle>
          </CardHeader>
          <CardContent>
            <DailyBarChart
              data={dailyStats}
              range={dailyRange}
              tz={dailyTz}
              modelData={costDailyData}
              groupLabel={provider ? '模型分布' : tool ? '供应商分布' : '工具分布'}
              categoryKind={groupBy}
            />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
