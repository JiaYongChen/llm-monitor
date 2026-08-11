/**
 * 多轮对话会话一致性测试
 * 验证同一聊天中的多次 API 请求是否映射到同一个会话
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { extractConversationSeed, computeFingerprint, getOrCreateSession } from '../proxy/session.js';
import { initDb, closeDb, listSessions, createPendingSession } from '../proxy/db.js';
import { createTempDb } from './setup.js';

const tmp = createTempDb();
beforeAll(async () => { await initDb(tmp.dbPath); });
afterAll(() => { closeDb(); tmp.cleanup(); });

// 模拟 Claude Code 实际请求格式（Anthropic API）
function makeAnthropicBody(messages: any[], system?: string | any[]) {
  return {
    model: 'claude-sonnet-5-20250915',
    system: system ?? 'You are Claude Code, Anthropic\'s official CLI tool for software engineering tasks.\n\nYou are an interactive agent that helps users...',
    messages,
    stream: true,
    max_tokens: 16000,
    tools: [{ name: 'Bash', description: '...' }],
    metadata: { user_id: 'test-user' },
  };
}

describe('多轮对话会话一致性', () => {
  it('★ 同一聊天两轮请求 → 相同会话', () => {
    // 第 1 轮：用户说"帮我写代码"
    const body1 = makeAnthropicBody([
      { role: 'user', content: '帮我写一段排序代码' },
    ]);
    const sid1 = getOrCreateSession('Anthropic', '/anthropic/v1/messages', body1, 'ClaudeCode');

    // 第 2 轮：用户追问（messages 扩展了，但第一条用户消息不变）
    const body2 = makeAnthropicBody([
      { role: 'user', content: '帮我写一段排序代码' },
      { role: 'assistant', content: '好的，这是快速排序的实现...' },
      { role: 'user', content: '能加个注释吗？' },
    ]);
    const sid2 = getOrCreateSession('Anthropic', '/anthropic/v1/messages', body2, 'ClaudeCode');

    expect(sid1).toBe(sid2);
  });

  it('★ 含 tool_use 的多轮请求 → 仍为同一会话', () => {
    // 第 1 轮
    const body1 = makeAnthropicBody([
      { role: 'user', content: '列出当前目录的文件' },
    ]);
    const sid1 = getOrCreateSession('Anthropic', '/anthropic/v1/messages', body1, 'ClaudeCode');

    // 第 2 轮：assistant 调用了工具，返回结果后继续
    const body2 = makeAnthropicBody([
      { role: 'user', content: '列出当前目录的文件' },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tool_001', name: 'Bash', input: { command: 'ls' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tool_001', content: 'file1.txt\nfile2.txt' },
        ],
      },
    ]);
    const sid2 = getOrCreateSession('Anthropic', '/anthropic/v1/messages', body2, 'ClaudeCode');

    expect(sid1).toBe(sid2);
  });

  it('★ 第 3 轮追加对话 → 仍同会话', () => {
    const body1 = makeAnthropicBody([
      { role: 'user', content: 'hello world' },
    ]);
    const sid1 = getOrCreateSession('Anthropic', '/anthropic/v1/messages', body1, 'ClaudeCode');

    // 堆积很多轮之后
    const body3 = makeAnthropicBody([
      { role: 'user', content: 'hello world' },
      { role: 'assistant', content: 'Hi!' },
      { role: 'user', content: 'how are you' },
      { role: 'assistant', content: 'I am fine' },
      { role: 'user', content: 'great, now help me' },
    ]);
    const sid3 = getOrCreateSession('Anthropic', '/anthropic/v1/messages', body3, 'ClaudeCode');

    // 第一条 user 消息不同
    const bodyOther = makeAnthropicBody([
      { role: 'user', content: 'goodbye world' },
    ]);
    const sidOther = getOrCreateSession('Anthropic', '/anthropic/v1/messages', bodyOther, 'ClaudeCode');

    expect(sid1).toBe(sid3);
    expect(sid1).not.toBe(sidOther); // 不同聊天 → 不同会话
  });

  it('★ 系统提示变化（前300字符相同）→ 同会话', () => {
    const sysA = 'A'.repeat(350) + '_changed_tail_A';
    const sysB = 'A'.repeat(350) + '_changed_tail_B';
    const body1 = makeAnthropicBody([{ role: 'user', content: 'hi' }], sysA);
    const body2 = makeAnthropicBody([{ role: 'user', content: 'hi' }], sysB);

    const seed1 = extractConversationSeed(body1);
    const seed2 = extractConversationSeed(body2);
    expect(seed1).toBe(seed2); // 前300字符一致 → 种子相同
  });

  it('★ 系统提示变化（前300字符不同）→ 不同会话', () => {
    const sysA = 'X'.repeat(300) + 'AAAAAA';
    const sysB = 'Y'.repeat(300) + 'BBBBBB';
    const body1 = makeAnthropicBody([{ role: 'user', content: 'hi' }], sysA);
    const body2 = makeAnthropicBody([{ role: 'user', content: 'hi' }], sysB);

    const seed1 = extractConversationSeed(body1);
    const seed2 = extractConversationSeed(body2);
    expect(seed1).not.toBe(seed2);
  });

  it('★ 数组格式 system → 稳定种子', () => {
    const sysArr = [
      { type: 'text', text: 'You are Claude Code.', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'More instructions here...' },
    ];
    const body1 = makeAnthropicBody([{ role: 'user', content: 'hi' }], sysArr);
    const body2 = makeAnthropicBody([{ role: 'user', content: 'hi' }], sysArr);

    const seed1 = extractConversationSeed(body1);
    const seed2 = extractConversationSeed(body2);
    expect(seed1).toBe(seed2);
  });

  it('空 body → _empty_ 种子（同 provider 归为一组）', () => {
    const seed1 = extractConversationSeed({});
    const seed2 = extractConversationSeed(null);
    expect(seed1).toBe('_empty_');
    expect(seed2).toBe('_empty_');

    const sid1 = getOrCreateSession('Anthropic', '/v1/messages', {}, 'ClaudeCode');
    const sid2 = getOrCreateSession('Anthropic', '/v1/messages', {}, 'ClaudeCode');
    expect(sid1).toBe(sid2);
  });

  it('★ 真实场景：system 从字符串切换到数组（Claude Code 带缓存）→ 种子应相同', () => {
    const sysText = 'You are Claude Code, Anthropic\'s official CLI tool for software engineering tasks.\n\nYou are an interactive agent that helps users with software engineering tasks.';

    // Claude Code 第 1 轮请求：system 是纯字符串（完整系统提示）
    const body1 = {
      model: 'claude-sonnet-5-20250915',
      system: sysText + '\nAdditional instructions...',
      messages: [{ role: 'user', content: '帮我写代码' }],
      stream: true,
      max_tokens: 16000,
    };

    // Claude Code 第 2 轮请求（带 prompt caching）：system 拆分为数组
    // 文本内容与字符串格式完全相同，只是拆成了两个块
    const body2 = {
      model: 'claude-sonnet-5-20250915',
      system: [
        { type: 'text', text: sysText, cache_control: { type: 'ephemeral' } },
        { type: 'text', text: 'Additional instructions...' },
      ],
      messages: [
        { role: 'user', content: '帮我写代码' },
        { role: 'assistant', content: '好的，这是代码...' },
        { role: 'user', content: '继续' },
      ],
      stream: true,
      max_tokens: 16000,
    };

    const seed1 = extractConversationSeed(body1);
    const seed2 = extractConversationSeed(body2);

    // 归一化后相同文本内容 → 相同种子
    expect(seed1).toBe(seed2);
  });

  // ── URL 路径嵌入 /s/<id>/  → 按进程区分 ──

  it('★ 同一 knownSessionId 的多轮请求 → 同一会话', () => {
    const pendingId = createPendingSession('ClaudeCode');

    // 第 1 轮：首条消息
    const body1 = makeAnthropicBody([
      { role: 'user', content: '帮我写一段排序代码' },
    ]);
    const sid1 = getOrCreateSession('Anthropic', '/anthropic/v1/messages', body1, 'ClaudeCode', pendingId);

    // 第 2 轮：追问（同一 knownSessionId）
    const body2 = makeAnthropicBody([
      { role: 'user', content: '帮我写一段排序代码' },
      { role: 'assistant', content: '好的，这是快速排序的实现...' },
      { role: 'user', content: '能加个注释吗？' },
    ]);
    const sid2 = getOrCreateSession('Anthropic', '/anthropic/v1/messages', body2, 'ClaudeCode', pendingId);

    expect(sid1).toBe(sid2);
    expect(sid1).toBe(pendingId);
  });

  it('★ 不同 knownSessionId → 不同会话（即使首条消息相同）', () => {
    const pid1 = createPendingSession('ClaudeCode');
    const pid2 = createPendingSession('ClaudeCode');

    const body = makeAnthropicBody([
      { role: 'user', content: 'hello' },
    ]);

    const sid1 = getOrCreateSession('Anthropic', '/anthropic/v1/messages', body, 'ClaudeCode', pid1);
    const sid2 = getOrCreateSession('Anthropic', '/anthropic/v1/messages', body, 'ClaudeCode', pid2);

    // 不同进程 → 不同会话
    expect(sid1).not.toBe(sid2);
    expect(sid1).toBe(pid1);
    expect(sid2).toBe(pid2);
  });

  it('★ knownSessionId + 无 knownSessionId 混用：内容相同 → 不同会话', () => {
    const pendingId = createPendingSession('ClaudeCode');
    const body = makeAnthropicBody([
      { role: 'user', content: '测试消息' },
    ]);

    // 有 knownSessionId → 使用 pending 会话
    const sid1 = getOrCreateSession('Anthropic', '/anthropic/v1/messages', body, 'ClaudeCode', pendingId);

    // 无 knownSessionId → 指纹匹配，首次创建新会话
    const sid2 = getOrCreateSession('Anthropic', '/anthropic/v1/messages', body, 'ClaudeCode');

    // 两个会话不同（一个来自 URL 前缀，一个来自内容指纹）
    expect(sid1).not.toBe(sid2);
  });
});
