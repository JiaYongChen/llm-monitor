import type { ReactNode } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';

/** 图表卡片外壳：标题 + 内容区的轻量包装 */
export default function ChartCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}
