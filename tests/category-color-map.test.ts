/** categoryColorMap 取色映射测试 — 类别名唯一决定颜色，跨图表一致 */
import { describe, it, expect } from 'vitest';
import { categoryColorMap, CATEGORY_COLORS } from '../webui/src/lib/utils';

describe('categoryColorMap', () => {
  it('同一类别集合，任意输入顺序 → 相同颜色映射（跨图表颜色一致）', () => {
    const a = categoryColorMap(['claudecode', 'codex']);
    const b = categoryColorMap(['codex', 'claudecode']);
    expect(a.get('claudecode')).toBe(b.get('claudecode'));
    expect(a.get('codex')).toBe(b.get('codex'));
  });

  it('内置类别固定取色：claudecode → 色板第 2 色、codex → 第 1 色', () => {
    const map = categoryColorMap(['codex', 'claudecode']);
    expect(map.get('claudecode')).toBe(CATEGORY_COLORS[1]);
    expect(map.get('codex')).toBe(CATEGORY_COLORS[0]);
  });

  it('不同集合下同一类别颜色不变（内置类别）', () => {
    const onlyCodex = categoryColorMap(['codex']);
    const both = categoryColorMap(['claudecode', 'codex']);
    expect(onlyCodex.get('codex')).toBe(both.get('codex'));
  });

  it('超出色板长度时循环取色（周期 = 色板长度）', () => {
    // 补零命名保证字母序与自然序一致
    const names = Array.from({ length: CATEGORY_COLORS.length + 2 }, (_, i) => `cat-${String(i).padStart(2, '0')}`);
    const map = categoryColorMap(names);
    const n = CATEGORY_COLORS.length;
    expect(map.get(`cat-${String(n).padStart(2, '0')}`)).toBe(map.get('cat-00'));
    expect(map.get(`cat-${String(n + 1).padStart(2, '0')}`)).toBe(map.get('cat-01'));
  });

  it('空数组返回空映射', () => {
    expect(categoryColorMap([]).size).toBe(0);
  });
});
