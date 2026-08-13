import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** 名称显示格式化：首字母大写（仅用于工具 / 供应商名展示；模型 ID 须保持原样） */
export function capitalizeFirst(name: string | null | undefined): string {
  if (!name) return '';
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** 映射表大小写不敏感查找：先精确匹配，未命中再按小写匹配（用于 TOOL_DISPLAY / TOOL_COLORS 等） */
export function lookupCi(map: Record<string, string>, key: string | null | undefined): string | undefined {
  if (!key) return undefined;
  if (map[key]) return map[key];
  const lower = key.toLowerCase();
  const hit = Object.keys(map).find(k => k.toLowerCase() === lower);
  return hit ? map[hit] : undefined;
}

/** 将 Unix 毫秒时间戳转为 UTC+8 显示字符串 */
export function formatTime(ts: number | string | null | undefined, fmt: 'full' | 'time' = 'full'): string {
  if (ts == null || ts === '') return '--';
  // 防御：sql.js 可能将 INTEGER 返回为字符串
  const num = typeof ts === 'string' ? parseInt(ts, 10) : ts;
  if (isNaN(num) || num <= 0) return '--';
  const d = new Date(num + 8 * 3600_000); // UTC+8
  const Y = d.getUTCFullYear();
  const M = String(d.getUTCMonth() + 1).padStart(2, '0');
  const D = String(d.getUTCDate()).padStart(2, '0');
  const h = String(d.getUTCHours()).padStart(2, '0');
  const m = String(d.getUTCMinutes()).padStart(2, '0');
  const s = String(d.getUTCSeconds()).padStart(2, '0');
  if (fmt === 'time') return `${h}:${m}:${s}`;
  return `${Y}-${M}-${D} ${h}:${m}:${s}`;
}
