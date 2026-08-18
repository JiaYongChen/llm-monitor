import type { ReactNode } from 'react';
import { Card, CardContent, CardHeader } from './ui/card';
import TimeRangeSelector from './TimeRangeSelector';

/** 合并图表卡片：顶部左对齐时间范围标签 + 纵向堆叠内容（总览行两列 grid 由页面组合） */
export default function ChartsCard({ range, onRangeChange, children }: { range: string; onRangeChange: (v: string) => void; children: ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <TimeRangeSelector value={range} onChange={onRangeChange} align="left" />
      </CardHeader>
      <CardContent>
        <div className="space-y-6">{children}</div>
      </CardContent>
    </Card>
  );
}
