/** 前端类别取色测试 — tool/provider：注册表命中取注册色 + 未命中名称哈希确定性兜底（避开内置锚点、跨集合稳定）；
 *  model：buildModelColorMap 按字母序依次对应色板（与集合内容相关，见各断言）。 */
import { describe, it, expect } from 'vitest';
import { categoryColor, buildCategoryColorMap, buildModelColorMap, type CategoryColors } from '../webui/src/lib/colors';

/** 测试夹具：5 色色板（前两位已按色板交换排序：#ff7f0e 在前）+ 内置 4 类注册表（tool: claudecode→0、codex→1；provider: anthropic→0、openai→1）。
 *  兜底哈希映射区间与后端池满公式一致：[2, len-1] = [2,4]（span=3），具体取色见各断言。 */
const FIXTURE: CategoryColors = {
  palette: [
    { idx: 0, color: '#ff7f0e' },
    { idx: 1, color: '#1f77b4' },
    { idx: 2, color: '#2ca02c' },
    { idx: 3, color: '#d62728' },
    { idx: 4, color: '#9467bd' },
  ],
  tools: { claudecode: 0, codex: 1 },
  providers: { anthropic: 0, openai: 1 },
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

  it('未注册类别取确定性哈希色（hash % 3 = 0 → palette[2]，不与内置锚点撞色）', () => {
    const color = categoryColor('kimi', 'tool', FIXTURE);
    expect(color).toBe('#2ca02c');           // hashString('kimi') % 3 === 0
    expect(color).not.toBe('#ff7f0e');       // 不撞 claudecode（idx0 锚点）
    expect(color).not.toBe('#1f77b4');       // 不撞 codex（idx1 锚点）
  });

  it('未注册类别颜色由名称唯一决定，跨调用稳定', () => {
    expect(categoryColor('kimi', 'tool', FIXTURE)).toBe(categoryColor('kimi', 'tool', FIXTURE));
    expect(categoryColor('kimi', 'tool', FIXTURE)).toBe(categoryColor('kimi', 'provider', FIXTURE));
  });

  it('数据未加载返回 undefined（调用方兜底）', () => {
    expect(categoryColor('codex', 'tool')).toBeUndefined();
  });
});

describe('buildCategoryColorMap', () => {
  it('注册命中取注册色，未命中取哈希兜底色（与内置锚点不撞色）', () => {
    const map = buildCategoryColorMap(['codex', 'kimi', 'claudecode', 'zebra'], 'tool', FIXTURE);
    expect(map.get('claudecode')).toBe('#ff7f0e');
    expect(map.get('codex')).toBe('#1f77b4');
    expect(map.get('kimi')).toBe('#2ca02c');  // % 3 = 0
    expect(map.get('zebra')).toBe('#d62728'); // % 3 = 1
  });

  it('同一未注册类别跨集合颜色稳定（哈希与集合内容无关）', () => {
    const small = buildCategoryColorMap(['kimi'], 'tool', FIXTURE);
    const large = buildCategoryColorMap(['a-tool', 'kimi', 'zebra-tool'], 'tool', FIXTURE);
    expect(small.get('kimi')).toBe(large.get('kimi'));
    expect(large.get('kimi')).toBe('#2ca02c');
  });

  it('空集合返回空映射', () => {
    expect(buildCategoryColorMap([], 'tool', FIXTURE).size).toBe(0);
  });
});

describe('buildModelColorMap', () => {
  it('模型按字母序依次对应色板（第 0 色起）', () => {
    const map = buildModelColorMap(['gpt-5', 'claude-sonnet-4-5', 'gemini-2.5-pro'], FIXTURE);
    expect(map.get('claude-sonnet-4-5')).toBe('#ff7f0e'); // 字母序第 1 → palette[0]（色板交换后首位为橙）
    expect(map.get('gemini-2.5-pro')).toBe('#1f77b4');    // 字母序第 2 → palette[1]（'e' < 'p'，gemini 先于 gpt）
    expect(map.get('gpt-5')).toBe('#2ca02c');             // 字母序第 3 → palette[2]
  });

  it('颜色取决于集合内容：插入字典序更小的模型后，原模型颜色后移', () => {
    const before = buildModelColorMap(['gpt-5', 'claude-sonnet-4-5'], FIXTURE);
    const after = buildModelColorMap(['a-model', 'gpt-5', 'claude-sonnet-4-5'], FIXTURE);
    expect(before.get('claude-sonnet-4-5')).toBe('#ff7f0e'); // 原第 1 位
    expect(after.get('claude-sonnet-4-5')).toBe('#1f77b4');  // 后移 1 位
    expect(after.get('a-model')).toBe('#ff7f0e');            // 新第 1 位
  });

  it('模型数超过色板长度时模循环取色', () => {
    const map = buildModelColorMap(['a', 'b', 'c', 'd', 'e', 'f'], FIXTURE); // 6 > 5
    expect(map.get('a')).toBe('#ff7f0e'); // idx 0
    expect(map.get('f')).toBe('#ff7f0e'); // idx 5 % 5 = 0
  });

  it('空集合返回空映射；空色板不报错', () => {
    expect(buildModelColorMap([], FIXTURE).size).toBe(0);
    const empty: CategoryColors = { palette: [], tools: {}, providers: {} };
    expect(buildModelColorMap(['a'], empty).size).toBe(0);
  });
});
