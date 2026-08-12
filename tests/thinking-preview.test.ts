import { describe, it, expect } from 'vitest';
import { formatThinkingPreview } from '../proxy/thinking-preview.js';

describe('formatThinkingPreview', () => {
  it('短思考：输出字数和完整内容，不加省略号', () => {
    expect(formatThinkingPreview('简短思考')).toBe('[proxy] 🧠 思考过程 | 4 字\n简短思考');
  });

  it('超长思考：截断到 maxLen 并追加省略号', () => {
    const long = 'x'.repeat(500);
    const out = formatThinkingPreview(long, 200);
    expect(out.startsWith('[proxy] 🧠 思考过程 | 500 字\n')).toBe(true);
    expect(out.endsWith('…')).toBe(true);
    // 第一行 + 换行 + 截断正文
    expect(out.length).toBe('[proxy] 🧠 思考过程 | 500 字\n'.length + 200 + 1);
  });

  it('恰好 maxLen 长度不截断', () => {
    const text = 'y'.repeat(200);
    const out = formatThinkingPreview(text, 200);
    expect(out.endsWith('…')).toBe(false);
  });
});
