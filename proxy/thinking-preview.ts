/** 终端思考预览格式化 — 摘要行 + 开头预览，避免长思考刷屏 */

export function formatThinkingPreview(thinking: string, maxLen = 200): string {
  const head = `[proxy] 🧠 思考过程 | ${thinking.length} 字`;
  const preview = thinking.slice(0, maxLen);
  return preview.length < thinking.length ? `${head}\n${preview}…` : `${head}\n${preview}`;
}

/** 终端思考完整输出 — 摘要行 + 全部思考内容 */
export function formatThinkingFull(thinking: string): string {
  return `[proxy] 🧠 思考过程 | ${thinking.length} 字\n${thinking}`;
}
