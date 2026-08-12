import { describe, it, expect } from 'vitest';
import { formatThinkingFull } from '../proxy/thinking-preview.js';

describe('formatThinkingFull', () => {
  it('短思考：上分隔线 + 内容 + 下分隔线', () => {
    const out = formatThinkingFull('简短');
    expect(out).toBe(
      '[proxy] ═══ 🧠 思考过程 | 2 字 ═══\n简短\n[proxy] ═══════════════════════════════════════'
    );
  });

  it('长内容完整输出，区域隔离', () => {
    const long = 'x'.repeat(500);
    const out = formatThinkingFull(long);
    expect(out.startsWith('[proxy] ═══ 🧠 思考过程 | 500 字 ═══\n')).toBe(true);
    expect(out.endsWith('\n[proxy] ═══════════════════════════════════════')).toBe(true);
    expect(out).toContain(long);
  });
});
