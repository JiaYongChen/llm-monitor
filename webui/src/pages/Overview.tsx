import { Navigate, useSearchParams } from 'react-router-dom';
import { Activity, Zap } from 'lucide-react';
import PageHeader from '../components/PageHeader';
import KpiCards from '../components/KpiCards';
import ChartsCard from '../components/ChartsCard';
import DailyChartsPanel from '../components/DailyChartsPanel';
import useDashboardData from '../hooks/useDashboardData';
import { useCurrency, formatCost, CURRENCIES } from '../lib/currency';

/** 总览页：按工具维度汇总（无筛选）。兼容旧查询参数（?tool=/ ?provider=，provider 优先）重定向到新路由。 */
export default function Overview() {
  const [searchParams] = useSearchParams();
  const provider = searchParams.get('provider');
  const tool = searchParams.get('tool');
  if (provider) return <Navigate to={`/providers/${provider}`} replace />;
  if (tool) return <Navigate to={`/tools/${tool}`} replace />;
  return <OverviewContent />;
}

/** 总览内容：数据 hook 只挂载在非重定向分支（保持 hooks 调用顺序稳定，避免重定向渲染触发查询） */
function OverviewContent() {
  const { currency, rates } = useCurrency();
  const sym = CURRENCIES[currency].symbol;
  const { dailyStats, costDailyData, dailyRange, setDailyRange, dailyTz, totals } = useDashboardData({ groupBy: 'tool', pageKey: 'overview' });
  const { totalCalls, totalCost, totalOutput, totalUncached, totalCacheRead } = totals;
  return (
    <div className="p-8 max-w-6xl mx-auto space-y-6 animate-in">
      <PageHeader title="总览" live={totalCalls > 0} />
      <KpiCards items={[
        { label: '总调用次数', value: totalCalls.toLocaleString(), icon: <Activity className="h-4 w-4 text-violet-500" /> },
        { label: '累计费用', value: formatCost(totalCost, currency, rates), icon: <span className="h-4 w-4 text-amber-500">{sym}</span> },
        { label: '输出 tokens', value: totalOutput.toLocaleString(), icon: <Zap className="h-4 w-4 text-sky-500" /> },
        { label: '输入 tokens', value: (totalUncached + totalCacheRead).toLocaleString(), icon: <Zap className="h-4 w-4 text-blue-500" /> },
      ]} />
      <ChartsCard range={dailyRange} onRangeChange={setDailyRange}>
        <DailyChartsPanel
          dailyStats={dailyStats}
          categoryData={costDailyData || []}
          range={dailyRange}
          tz={dailyTz}
          categoryKind="tool"
        />
      </ChartsCard>
    </div>
  );
}
