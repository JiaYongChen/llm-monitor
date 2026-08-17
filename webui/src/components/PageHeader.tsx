import { Badge } from './ui/badge';

/** 总览图标颜色（侧边栏激活态紫色） */
export const OVERVIEW_COLOR = '#5e5ce6';

/** 页面标题行：sticky 居中标题 + 可选「实时监控中」徽标（沿用现状仅在有调用数据时显示，由页面传入） */
export default function PageHeader({ title, color = OVERVIEW_COLOR, live = false }: { title: string; color?: string; live?: boolean }) {
  return (
    <div className="relative flex items-center justify-center sticky top-0 z-10 bg-[#f5f5f7] -mt-8 pt-8 pb-3 -mb-3">
      <h1 className="text-2xl font-bold tracking-tight" style={{ color }}>{title}</h1>
      {live && (
        <Badge variant="secondary" className="absolute right-0 gap-1.5">
          <span className="relative flex h-2 w-2"><span className="animate-ping absolute h-2 w-2 rounded-full bg-green-400 opacity-75" /><span className="relative rounded-full h-2 w-2 bg-green-500" /></span>
          实时监控中
        </Badge>
      )}
    </div>
  );
}
