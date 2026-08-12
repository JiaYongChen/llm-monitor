/**
 * 从响应体 JSON 文本提取模型思考过程。
 * 兼容三种形态：
 *   1. 干净结构（流式收集）：{ thinking: string }
 *   2. Anthropic 原始结构（非流式）：{ content: [{ type: 'thinking', thinking: string }] }
 *   3. OpenAI 原始结构（非流式）：{ choices: [{ message: { reasoning_content: string } }] }
 * 无思考或解析失败返回 null。
 */
export function extractThinking(responseBody: string | null | undefined): string | null {
  if (!responseBody) return null;
  let obj: any;
  try {
    obj = JSON.parse(responseBody);
  } catch {
    return null;
  }
  if (typeof obj !== 'object' || obj === null) return null;

  // 形态 1：干净结构
  if (typeof obj.thinking === 'string' && obj.thinking) return obj.thinking;

  // 形态 2：Anthropic 原始结构（可能有多个 thinking 块，拼接）
  if (Array.isArray(obj.content)) {
    const parts = obj.content
      .filter((b: any) => b?.type === 'thinking' && typeof b.thinking === 'string' && b.thinking)
      .map((b: any) => b.thinking);
    if (parts.length > 0) return parts.join('');
  }

  // 形态 3：OpenAI 原始结构
  const reasoning = obj.choices?.[0]?.message?.reasoning_content;
  if (typeof reasoning === 'string' && reasoning) return reasoning;

  return null;
}
