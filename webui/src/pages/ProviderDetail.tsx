import { useParams } from 'react-router-dom';
import { Activity, Zap, Layers } from 'lucide-react';
import PageHeader, { OVERVIEW_COLOR } from '../components/PageHeader';
import KpiCards from '../components/KpiCards';
import ChartsCard from '../components/ChartsCard';
import DailyChartsPanel from '../components/DailyChartsPanel';
import useDashboardData from '../hooks/useDashboardData';
import { useCurrency, formatCost, CURRENCIES } from '../lib/currency';
import { useCategoryColors, categoryColor } from '../lib/colors';
import { displayName } from '../lib/display';

/** 供应商详情页：按模型维度汇总单个供应商；KPI 多一张缓存命中率卡 */
export default function ProviderDetail() {
  const { provider } = useParams<{ provider: string }>();
  const providerName = provider || '';
  const { currency, rates } = useCurrency();
  const sym = CURRENCIES[currency].symbol;
  const { dailyStats, costDailyData, dailyRange, setDailyRange, dailyTz, totals } = useDashboardData({ groupBy: 'model', provider: providerName, pageKey: 'provider' });
  const { data: colors } = useCategoryColors();
  const { totalCalls, totalCost, totalOutput, totalUncached, totalCacheRead } = totals;
  return (
    <div className="p-8 max-w-6xl mx-auto space-y-6 animate-in">
      <PageHeader
        title={displayName(providerName)}
        color={categoryColor(providerName, 'provider', colors) || OVERVIEW_COLOR}
        live={totalCalls > 0}
      />
      <KpiCards items={[
        { label: '总调用次数', value: totalCalls.toLocaleString(), icon: <Activity className="h-4 w-4 text-violet-500" /> },
        { label: '累计费用', value: formatCost(totalCost, currency, rates), icon: <span className="h-4 w-4 text-amber-500">{sym}</span> },
        { label: '输出 tokens', value: totalOutput.toLocaleString(), icon: <Zap className="h-4 w-4 text-sky-500" /> },
        { label: '输入 tokens', value: (totalUncached + totalCacheRead).toLocaleString(),
          sub: <><span>未命中: {totalUncached.toLocaleString()}</span><br /><span>命中: {totalCacheRead.toLocaleString()}</span></>, icon: <Zap className="h-4 w-4 text-blue-500" /> },
        { label: '缓存命中率', value: totalUncached + totalCacheRead > 0 ? `${(totalCacheRead / (totalUncached + totalCacheRead) * 100).toFixed(1)}%` : '--',
          sub: totalCacheRead > 0 ? `${totalCacheRead.toLocaleString()} 命中` : '暂无缓存命中', icon: <Layers className="h-4 w-4 text-emerald-500" /> },
      ]} />
      <ChartsCard range={dailyRange} onRangeChange={setDailyRange}>
        <DailyChartsPanel
          dailyStats={dailyStats}
          categoryData={costDailyData || []}
          range={dailyRange}
          tz={dailyTz}
          categoryKind="model"
        />
      </ChartsCard>
    </div>
  );
}
