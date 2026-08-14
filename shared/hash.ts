/** 字符串确定性哈希（djb2 变体，非负）——用于类别名 → 色位兜底映射（前后端共用） */
export function hashString(s: string): number {
  let hash = 0;
  for (let i = 0; i < s.length; i++) hash = ((hash << 5) - hash) + s.charCodeAt(i);
  return Math.abs(hash);
}
