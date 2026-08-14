/** 类别颜色取色模块 — 注册表命中取注册色；模型与未注册类别按字母序循环色板兜底 */
import { useQuery } from '@tanstack/react-query';
import * as api from '../api/client';
import { sortByPresetOrder } from './utils';

export type CategoryKind = 'tool' | 'provider' | 'model';

/** /api/colors 返回结构（色板 + 两池注册表） */
export interface CategoryColors {
  palette: { idx: number; color: string }[];
  tools: Record<string, number>;
  providers: Record<string, number>;
}

/** 拉取类别颜色注册数据（同 queryKey 多处调用共享缓存，零重复请求） */
export function useCategoryColors() {
  return useQuery({ queryKey: ['colors'], queryFn: () => api.fetchColors() });
}

/** 单类别取色：tool/provider 命中注册表 → 色板色；未命中或数据未加载 → undefined（由调用方兜底） */
export function categoryColor(name: string, kind: CategoryKind, colors?: CategoryColors): string | undefined {
  if (!colors || kind === 'model') return undefined;
  const registry = kind === 'tool' ? colors.tools : colors.providers;
  const lower = name.toLowerCase();
  const hit = Object.entries(registry).find(([k]) => k.toLowerCase() === lower);
  if (!hit) return undefined;
  const idx = Number(hit[1]);
  return colors.palette.find(p => Number(p.idx) === idx)?.color;
}

/** 类别集合 → 颜色映射：tool/provider 命中注册表取注册色；model 与未命中类别按预设序（字母序）循环色板。
 *  颜色与图例/柱段顺序完全解耦（图例用 sortByPresetOrder、柱段保持各自顺序不变）。 */
export function buildCategoryColorMap(names: string[], kind: CategoryKind, colors: CategoryColors): Map<string, string> {
  const map = new Map<string, string>();
  if (colors.palette.length === 0) return map;
  let fallback = 0;
  for (const name of sortByPresetOrder(names)) {
    const hit = categoryColor(name, kind, colors);
    if (hit) {
      map.set(name, hit);
      continue;
    }
    map.set(name, colors.palette[fallback % colors.palette.length].color);
    fallback++;
  }
  return map;
}
