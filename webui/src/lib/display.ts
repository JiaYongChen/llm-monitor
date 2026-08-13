/** 名称显示格式化：整体映射表 → 分词 + 特殊词大写 + 首字母大写
 *  存储层名称统一小写，显示层统一在此格式化（工具/供应商/模型共用） */

/** 整体名称显示映射（键小写）：无分隔符名称无法靠算法还原，靠显式映射 */
export const DISPLAY_MAP: Record<string, string> = {
  claudecode: 'ClaudeCode',
  codex: 'Codex',
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  chatgpt: 'ChatGPT',
};

/** 特殊含义词（小写）：按分隔符分词后整词命中则全大写显示 */
export const SPECIAL_WORDS: ReadonlySet<string> = new Set([
  'ai', 'gpt', 'api', 'cli', 'llm', 'url', 'http', 'https',
  'json', 'sql', 'id', 'ip', 'glm', 'kimi',
]);

/** 分隔符：-、_、空格、. */
const SEP_RE = /([-_.\s]+)/;

export function displayName(raw: string | null | undefined): string {
  if (!raw) return '';
  const lower = raw.toLowerCase();
  const mapped = DISPLAY_MAP[lower];
  if (mapped) return mapped;
  return raw
    .split(SEP_RE)
    .map(part => {
      if (!part) return part;
      if (SEP_RE.test(part)) return part;  // 分隔符原样保留
      const partLower = part.toLowerCase();
      if (SPECIAL_WORDS.has(partLower)) return partLower.toUpperCase();
      // 字母开头 → 首字母大写其余小写；数字开头（如 "4o"）保持原样
      return /^[a-z]/.test(partLower)
        ? partLower.charAt(0).toUpperCase() + partLower.slice(1)
        : partLower;
    })
    .join('');
}
