import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
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
