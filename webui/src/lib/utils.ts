import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** 合并已知工具与数据库中出现的工具：按小写键去重，保留首次出现的形态（已知工具优先且保持顺序）。
 *  存储层工具名统一小写，但代码内常量（如 KNOWN_TOOLS）可能保留 CamelCase —— 去重必须大小写不敏感。 */
export function collectTools(knownTools: string[], sessionTools: (string | null | undefined)[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  const add = (t: string) => {
    const key = t.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    result.push(t);
  };
  for (const t of knownTools) add(t);
  for (const t of sessionTools) if (t) add(t);
  return result;
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
