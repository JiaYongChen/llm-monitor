import { useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, Zap } from 'lucide-react';
import * as api from '../api/client';
import PageHeader, { OVERVIEW_COLOR } from '../components/PageHeader';
import KpiCards from '../components/KpiCards';
import ChartsCard from '../components/ChartsCard';
import UpstreamSelectorPanel from '../components/UpstreamSelectorPanel';
import DailyBarChart from '../components/DailyBarChart';
import DailyCostBarChart from '../components/DailyCostBarChart';
import TokenDistributionBarChart from '../components/TokenDistributionBarChart';
import useDashboardData from '../hooks/useDashboardData';
import { useCurrency, formatCost, CURRENCIES } from '../lib/currency';
import { useCategoryColors, categoryColor } from '../lib/colors';
import { displayName } from '../lib/display';

/** 工具详情页：按供应商维度汇总单个工具；含工具级上游配置面板 */
export default function ToolDetail() {
  const { tool } = useParams<{ tool: string }>();
  const toolName = tool || '';
  const qc = useQueryClient();
  const { currency, rates } = useCurrency();
  const sym = CURRENCIES[currency].symbol;
  const { data: toolConfigs } = useQuery({ queryKey: ['tool-configs'], queryFn: () => api.listToolConfigs() });
  const { data: providers } = useQuery({ queryKey: ['providers'], queryFn: () => api.listProviders() });
  const { data: providerModels } = useQuery({ queryKey: ['provider-models'], queryFn: () => api.listProviderModels() });
  // 工具名大小写不敏感匹配（URL 参数可能为任意大小写）
  const toolConfig = toolConfigs?.find((t: any) => toolName && t.tool.toLowerCase() === toolName.toLowerCase());
  const { dailyStats, costDailyData, dailyRange, setDailyRange, dailyTz, totals } = useDashboardData({ groupBy: 'provider', tool: toolName, pageKey: 'tool' });
  const { data: colors } = useCategoryColors();
  const { totalCalls, totalCost, totalOutput, totalUncached, totalCacheRead } = totals;
  return (
    <div className="p-8 max-w-6xl mx-auto space-y-6 animate-in">
      <PageHeader
        title={displayName(toolName)}
        color={categoryColor(toolName, 'tool', colors) || OVERVIEW_COLOR}
        live={totalCalls > 0}
      />
      {providers && (
        <UpstreamSelectorPanel
          tool={toolName}
          provider={toolConfig?.upstream_provider || ''}
          model={toolConfig?.upstream_model || ''}
          providers={providers}
          providerModels={providerModels as any[]}
          onProviderChange={async (next, defaultModel) => {
            if (!next) {
              await api.updateToolConfig(toolName, null, null);
            } else {
              await api.updateToolConfig(toolName, next, defaultModel);
            }
            qc.invalidateQueries({ queryKey: ['tool-configs'] });
          }}
          onModelChange={async (next) => {
            await api.updateToolConfig(toolName, toolConfig?.upstream_provider || '', next);
            qc.invalidateQueries({ queryKey: ['tool-configs'] });
          }}
        />
      )}
      <KpiCards items={[
        { label: '总调用次数', value: totalCalls.toLocaleString(), icon: <Activity className="h-4 w-4 text-violet-500" /> },
        { label: '累计费用', value: formatCost(totalCost, currency, rates), icon: <span className="h-4 w-4 text-amber-500">{sym}</span> },
        { label: '输出 tokens', value: totalOutput.toLocaleString(), icon: <Zap className="h-4 w-4 text-sky-500" /> },
        { label: '输入 tokens', value: (totalUncached + totalCacheRead).toLocaleString(), icon: <Zap className="h-4 w-4 text-blue-500" /> },
      ]} />
      <ChartsCard range={dailyRange} onRangeChange={setDailyRange}>
        {/* 总览行：费用分布 + 类别分布堆叠图并列 */}
        <div className="grid grid-cols-2 gap-6">
          <div>
            <h4 className="text-xs font-medium text-[#aeaeb2] mb-2">供应商费用</h4>
            <DailyCostBarChart data={costDailyData || []} range={dailyRange} tz={dailyTz} categoryKind="provider" />
          </div>
          <TokenDistributionBarChart modelData={costDailyData} range={dailyRange} tz={dailyTz} groupLabel="供应商Tokens" categoryKind="provider" />
        </div>
        {dailyStats && (
          <DailyBarChart data={dailyStats} range={dailyRange} tz={dailyTz} modelData={costDailyData} />
        )}
      </ChartsCard>
    </div>
  );
}
