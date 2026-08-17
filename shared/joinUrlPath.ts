/**
 * 智能拼接 base URL 与路径，避免重复段（如 /v1/v1/）。
 * 背景：部分供应商的 base_url 按官方文档写法已含 /v1 尾段（如阿里云百炼
 * compatible-mode/v1），直接 `${base}/${path}` 会产生 /v1/v1/... 导致上游 400。
 * 代理转发（router.ts）与模型探测（model-sync.ts）共用此拼接逻辑。
 */
export function joinUrlPath(base: string, path: string): string {
  const cleanBase = base.replace(/\/+$/, '');
  const cleanPath = path.replace(/^\/+/, '');
  if (!cleanPath) return cleanBase;
  const baseParts = cleanBase.split('/');
  const pathParts = cleanPath.split('/');
  if (baseParts.length > 0 && pathParts.length > 0 &&
      baseParts[baseParts.length - 1] === pathParts[0]) {
    return `${cleanBase}/${pathParts.slice(1).join('/')}`;
  }
  return `${cleanBase}/${cleanPath}`;
}
