/** 类别颜色取色模块 — 注册表命中取注册色；模型与未注册类别取名称哈希确定性色（避开内置锚点、跨集合稳定） */
import { useQuery } from '@tanstack/react-query';
import * as api from '../api/client';
import { hashString } from '../../../shared/hash';

export type CategoryKind = 'tool' | 'provider' | 'model';

/** /api/colors 返回结构（色板 + 两池注册表）。
 *  直接从 api.fetchColors 的返回类型提取——单一来源，client.ts 改结构时此处自动跟随，无副本漂移。 */
export type CategoryColors = Awaited<ReturnType<typeof api.fetchColors>>;

/** 拉取类别颜色注册数据（同 queryKey 多处调用共享缓存，零重复请求）。
 *  recorder 在代理侧异步注册新类别，60s 自动刷新避免面板常开时新类别颜色长期滞后跳变。 */
export function useCategoryColors() {
  return useQuery({ queryKey: ['colors'], queryFn: () => api.fetchColors(), refetchInterval: 60_000 });
}

/** 单类别取色：tool/provider 命中注册表 → 色板色；model 永不查注册表；
 *  未命中 → 名称哈希映射到 [4, len-1] 的确定性色（避开内置锚点 0/1 与旧预设占用 2/3，且跨图表/跨集合稳定）；
 *  数据未加载 → undefined（由调用方兜底）。 */
export function categoryColor(name: string, kind: CategoryKind, colors?: CategoryColors): string | undefined {
  if (!colors) return undefined;
  if (kind !== 'model') {
    const registry = kind === 'tool' ? colors.tools : colors.providers;
    const lower = name.toLowerCase();
    const hit = Object.entries(registry).find(([k]) => k.toLowerCase() === lower);
    if (hit) {
      const idx = Number(hit[1]);
      return colors.palette.find(p => Number(p.idx) === idx)?.color;
    }
  }
  // 哈希兜底：锚点区间外的色板段，长度不足 5 时退化为整板哈希（防御性，正常色板恒 32）
  const len = colors.palette.length;
  if (len === 0) return undefined;
  const span = Math.max(1, len - 4);
  const idx = 4 + (hashString(name.toLowerCase()) % span);
  return colors.palette[Math.min(idx, len - 1)].color;
}

/** 类别集合 → 颜色映射：每类别独立取色（注册命中 → 注册色；其余 → 名称哈希确定性色），
 *  颜色与集合内容、图例/柱段顺序完全解耦（图例用 sortByPresetOrder、柱段保持各自顺序不变）。 */
export function buildCategoryColorMap(names: string[], kind: CategoryKind, colors: CategoryColors): Map<string, string> {
  const map = new Map<string, string>();
  for (const name of names) {
    const color = categoryColor(name, kind, colors);
    if (color) map.set(name, color);
  }
  return map;
}
