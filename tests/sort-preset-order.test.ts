/** sortByPresetOrder 排序函数测试 — 内置顺序 + 字母序兜底 */
import { describe, it, expect } from 'vitest';
import { sortByPresetOrder } from '../webui/src/lib/utils';

describe('sortByPresetOrder', () => {
  it('内置工具序：claudecode 恒在 codex 前（与侧边栏 KNOWN_TOOLS 定义序一致）', () => {
    expect(sortByPresetOrder(['codex', 'claudecode'])).toEqual(['claudecode', 'codex']);
    expect(sortByPresetOrder(['claudecode', 'codex'])).toEqual(['claudecode', 'codex']);
  });

  it('内置供应商序：anthropic → openai，其余按字母序排在其后', () => {
    expect(sortByPresetOrder(['openai', 'kimi', 'anthropic'])).toEqual(['anthropic', 'openai', 'kimi']);
  });

  it('模型等非内置名称按字母序', () => {
    expect(sortByPresetOrder(['gpt-5', 'claude-sonnet-4-5', 'glm-4.5'])).toEqual(['claude-sonnet-4-5', 'glm-4.5', 'gpt-5']);
  });

  it('内置序匹配大小写不敏感，但保留原形态', () => {
    expect(sortByPresetOrder(['CODEX', 'claudecode'])).toEqual(['claudecode', 'CODEX']);
    expect(sortByPresetOrder(['OpenAI', 'anthropic'])).toEqual(['anthropic', 'OpenAI']);
  });

  it('空数组返回空数组', () => {
    expect(sortByPresetOrder([])).toEqual([]);
  });

  it('纯函数：不修改原数组', () => {
    const input = ['codex', 'claudecode'];
    sortByPresetOrder(input);
    expect(input).toEqual(['codex', 'claudecode']);
  });
});
