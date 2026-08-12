/** 终端思考完整输出 — 上下分隔线包围，隔离不同请求的思考区域 */
export function formatThinkingFull(thinking: string): string {
  const head = `[think] ═══ 🧠 思考过程 | ${thinking.length} 字 ═══`;
  const foot = `[think] ═══════════════════════════════════════`;
  return `${head}\n${thinking}\n${foot}`;
}
