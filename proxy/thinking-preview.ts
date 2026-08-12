/** 终端思考完整输出 — 摘要行 + 全部思考内容 */
export function formatThinkingFull(thinking: string): string {
  return `[proxy] 🧠 思考过程 | ${thinking.length} 字\n${thinking}`;
}
