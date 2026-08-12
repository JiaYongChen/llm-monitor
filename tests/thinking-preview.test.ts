import { describe, it, expect } from 'vitest';
import { formatThinkingFull } from '../proxy/thinking-preview.js';

describe('formatThinkingFull', () => {
  it('输出完整思考内容，不截断', () => {
    expect(formatThinkingFull('简短')).toBe('[proxy] 🧠 思考过程 | 2 字\n简短');
  });

  it('长内容完整输出', () => {
    const long = 'x'.repeat(500);
    expect(formatThinkingFull(long)).toBe(`[proxy] 🧠 思考过程 | 500 字\n${long}`);
  });
});
