/** 前端类别取色测试 — 注册表命中取色 + 未命中字母序循环兜底 */
import { describe, it, expect } from 'vitest';
import { categoryColor, buildCategoryColorMap, type CategoryColors } from '../webui/src/lib/colors';

/** 测试夹具：5 色色板 + 内置 4 类注册表（tool: codex→0、claudecode→1；provider: openai→0、anthropic→1） */
const FIXTURE: CategoryColors = {
  palette: [
    { idx: 0, color: '#1f77b4' },
    { idx: 1, color: '#ff7f0e' },
    { idx: 2, color: '#2ca02c' },
    { idx: 3, color: '#d62728' },
    { idx: 4, color: '#9467bd' },
  ],
  tools: { claudecode: 1, codex: 0 },
  providers: { anthropic: 1, openai: 0 },
};

describe('categoryColor', () => {
  it('tool 池注册表命中取色（claudecode → 橙）', () => {
    expect(categoryColor('claudecode', 'tool', FIXTURE)).toBe('#ff7f0e');
  });

  it('provider 池注册表命中取色（anthropic → 橙）', () => {
    expect(categoryColor('anthropic', 'provider', FIXTURE)).toBe('#ff7f0e');
  });

  it('注册表查找大小写不敏感', () => {
    expect(categoryColor('ClaudeCode', 'tool', FIXTURE)).toBe('#ff7f0e');
  });

  it('未注册类别返回 undefined（调用方兜底）', () => {
    expect(categoryColor('kimi', 'tool', FIXTURE)).toBeUndefined();
  });

  it('model 类别永不查注册表', () => {
    expect(categoryColor('claudecode', 'model', FIXTURE)).toBeUndefined();
  });

  it('数据未加载返回 undefined', () => {
    expect(categoryColor('codex', 'tool')).toBeUndefined();
  });
});

describe('buildCategoryColorMap', () => {
  it('注册命中取注册色，未命中按字母序循环色板兜底', () => {
    const map = buildCategoryColorMap(['codex', 'kimi', 'claudecode', 'zebra'], 'tool', FIXTURE);
    expect(map.get('claudecode')).toBe('#ff7f0e');
    expect(map.get('codex')).toBe('#1f77b4');
    expect(map.get('kimi')).toBe('#1f77b4');   // 未命中第 1 个 → palette[0]
    expect(map.get('zebra')).toBe('#ff7f0e');  // 未命中第 2 个 → palette[1]
  });

  it('模型类别全部字母序循环（不查注册表）', () => {
    const map = buildCategoryColorMap(['gpt-5', 'claude-sonnet-4-5'], 'model', FIXTURE);
    expect(map.get('claude-sonnet-4-5')).toBe('#1f77b4');
    expect(map.get('gpt-5')).toBe('#ff7f0e');
  });

  it('循环超过色板长度时取模', () => {
    // 补零命名保证字母序与自然序一致
    const names = Array.from({ length: 7 }, (_, i) => `m-${String(i).padStart(2, '0')}`);
    const map = buildCategoryColorMap(names, 'model', FIXTURE);
    expect(map.get('m-05')).toBe('#1f77b4'); // 第 6 个未命中 → 5 % 5 = 0
  });

  it('空集合返回空映射', () => {
    expect(buildCategoryColorMap([], 'tool', FIXTURE).size).toBe(0);
  });
});
