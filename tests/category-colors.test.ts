/** 前端类别取色测试 — 注册表命中取注册色 + 未命中名称哈希确定性兜底（避开内置锚点、跨集合稳定） */
import { describe, it, expect } from 'vitest';
import { categoryColor, buildCategoryColorMap, type CategoryColors } from '../webui/src/lib/colors';

/** 测试夹具：5 色色板 + 内置 4 类注册表（tool: codex→0、claudecode→1；provider: openai→0、anthropic→1）。
 *  兜底哈希映射区间为 [4, len-1] = [4,4]，即所有未注册/模型类别恒取 palette[4]。 */
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

  it('未注册类别取确定性哈希色（不与内置锚点撞色）', () => {
    const color = categoryColor('kimi', 'tool', FIXTURE);
    expect(color).toBe('#9467bd');           // 哈希映射到 [4, len-1]
    expect(color).not.toBe('#1f77b4');       // 不撞 codex（idx0 锚点）
    expect(color).not.toBe('#ff7f0e');       // 不撞 claudecode（idx1 锚点）
  });

  it('未注册类别颜色由名称唯一决定，跨调用稳定', () => {
    expect(categoryColor('kimi', 'tool', FIXTURE)).toBe(categoryColor('kimi', 'tool', FIXTURE));
    expect(categoryColor('kimi', 'tool', FIXTURE)).toBe(categoryColor('kimi', 'provider', FIXTURE));
  });

  it('model 类别永不查注册表（取哈希色而非注册色）', () => {
    const color = categoryColor('claudecode', 'model', FIXTURE);
    expect(color).toBe('#9467bd');           // 哈希色，而非 claudecode 的注册色 '#ff7f0e'
  });

  it('数据未加载返回 undefined（调用方兜底）', () => {
    expect(categoryColor('codex', 'tool')).toBeUndefined();
  });
});

describe('buildCategoryColorMap', () => {
  it('注册命中取注册色，未命中取哈希兜底色（与 codex 不撞色）', () => {
    const map = buildCategoryColorMap(['codex', 'kimi', 'claudecode', 'zebra'], 'tool', FIXTURE);
    expect(map.get('claudecode')).toBe('#ff7f0e');
    expect(map.get('codex')).toBe('#1f77b4');
    expect(map.get('kimi')).toBe('#9467bd');
    expect(map.get('zebra')).toBe('#9467bd');
  });

  it('模型类别全部取哈希色（不查注册表）', () => {
    const map = buildCategoryColorMap(['gpt-5', 'claude-sonnet-4-5'], 'model', FIXTURE);
    expect(map.get('claude-sonnet-4-5')).toBe('#9467bd');
    expect(map.get('gpt-5')).toBe('#9467bd');
  });

  it('同一未注册类别跨集合颜色稳定（哈希与集合内容无关）', () => {
    const small = buildCategoryColorMap(['kimi'], 'tool', FIXTURE);
    const large = buildCategoryColorMap(['a-tool', 'kimi', 'zebra-tool'], 'tool', FIXTURE);
    expect(small.get('kimi')).toBe(large.get('kimi'));
  });

  it('空集合返回空映射', () => {
    expect(buildCategoryColorMap([], 'tool', FIXTURE).size).toBe(0);
  });
});
