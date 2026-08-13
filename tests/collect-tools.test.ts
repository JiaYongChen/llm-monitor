/** collectTools 测试 — 侧边栏工具列表大小写不敏感去重（修复同名工具重复条目） */
import { describe, it, expect } from 'vitest';
import { collectTools } from '../webui/src/lib/utils';

describe('collectTools', () => {
  it('已知工具与库中小写会话工具大小写不敏感去重，保留已知工具形态', () => {
    expect(collectTools(['ClaudeCode', 'Codex'], ['claudecode', 'codex'])).toEqual(['ClaudeCode', 'Codex']);
  });

  it('数据库中的未知工具追加在已知工具之后', () => {
    expect(collectTools(['ClaudeCode', 'Codex'], ['cursor', 'claudecode'])).toEqual(['ClaudeCode', 'Codex', 'cursor']);
  });

  it('会话工具间同样大小写不敏感去重（保留首次出现形态）', () => {
    expect(collectTools([], ['Cursor', 'cursor'])).toEqual(['Cursor']);
  });

  it('空值会话工具被过滤', () => {
    expect(collectTools(['Codex'], [null, undefined, 'codex'])).toEqual(['Codex']);
  });

  it('已知工具为空时保持会话工具顺序', () => {
    expect(collectTools([], ['codex', 'claudecode'])).toEqual(['codex', 'claudecode']);
  });
});
