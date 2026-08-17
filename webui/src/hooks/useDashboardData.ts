import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import * as api from '../api/client';
import type { CategoryKind } from '../lib/colors';

/** 模块级共享的时间范围档位：页面切换（卸载/挂载）时保持用户上次选择 */
let sharedRange = '30d';

/** Dashboard 三页共用查询 hook：stats/dailyStats/dailyModelStats/costDailyStats 四查询 + 时区配置 + totals 归约。
 *  查询键与拆分前完全一致 → 页面切换时 react-query 共享缓存，零重复请求。 */
export default function useDashboardData({ groupBy, provider, tool }: { groupBy: CategoryKind; provider?: string; tool?: string }) {
  const [dailyRange, setDailyRangeState] = useState(sharedRange);
  /** 受控更新：同步写回模块级共享状态，跨页面保持选择 */
  const setDailyRange = (v: string) => {
    sharedRange = v;
    setDailyRangeState(v);
  };
  const { data: stats } = useQuery({ queryKey: ['stats', groupBy, provider, tool], queryFn: () => api.getStats(groupBy, provider, tool), refetchInterval: 5000 });
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
  const totalOutput = stats?.reduce((a: number, b: any) => a + (b.total_output_tokens || 0), 0) || 0;
  const totalCacheRead = stats?.reduce((a: number, b: any) => a + (b.total_cache_read_tokens || 0), 0) || 0;
  const totalUncached = stats?.reduce((a: number, b: any) => a + (b.total_uncached_input || 0), 0) || 0;

  return {
    stats,
    dailyStats,
    dailyModelStats,
    costDailyData,
    dailyRange,
    setDailyRange,
    dailyTz,
    totals: { totalCalls, totalCost, totalOutput, totalCacheRead, totalUncached },
  };
}
