import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { computeFingerprint, toolFromProvider, getOrCreateSession, extractConversationSeed } from '../proxy/session.js';
import { initDb, closeDb, createPendingSession, getSession, updateSessionUpstream } from '../proxy/db.js';
import { execute } from '../proxy/db-core.js';
import { createTempDb } from './setup.js';

const tmp = createTempDb();
beforeAll(async () => { await initDb(tmp.dbPath); });
afterAll(() => { closeDb(); tmp.cleanup(); });

// 模拟 Anthropic 请求 body
function anBody(msg: string) {
  return {
    model: 'claude-sonnet-5',
    system: 'You are a helpful assistant',
    messages: [
      { role: 'user', content: msg },
    ],
  };
}

describe('session', () => {
  it('相同 body → 相同会话（同一聊天多轮请求）', () => {
    const body = anBody('帮我写一段代码');
    const sid1 = getOrCreateSession('anthropic', '/v1/messages', body);
    const sid2 = getOrCreateSession('anthropic', '/v1/messages', body);
    expect(sid1).toBe(sid2);
  });

  it('不同 body（不同首条消息）→ 不同会话（不同聊天）', () => {
    const body1 = anBody('帮我写代码');
    const body2 = anBody('翻译这段文字');
    const sid1 = getOrCreateSession('anthropic', '/v1/messages', body1);
    const sid2 = getOrCreateSession('anthropic', '/v1/messages', body2);
    expect(sid1).not.toBe(sid2);
  });

  it('pending 会话被首次聊天请求自动升级', () => {
    // 模拟包装脚本预创建 pending 会话
    const pendingId = createPendingSession('ClaudeCode');
    const pending = getSession(pendingId);
    expect(pending!.status).toBe('pending');

    // 首次聊天请求 → 自动升级为 active
    const body = anBody('升级测试');
    const sid = getOrCreateSession('anthropic', '/v1/messages', body);

    // 应该复用 pending 会话（升级）
    expect(sid).toBe(pendingId);
    const upgraded = getSession(sid);
    expect(upgraded!.status).toBe('active');
    expect(upgraded!.fingerprint).not.toBe(pending!.fingerprint); // 指纹已升级
  });

  it('超过 5 分钟未认领的 pending 会话不被抢占（防跨终端误并）', () => {
    const pendingId = createPendingSession('ClaudeCode');
    // 回拨创建时间 10 分钟，模拟被遗忘的 pending
    execute('UPDATE sessions SET created_at = ? WHERE id = ?', [Date.now() - 10 * 60 * 1000, pendingId]);
    const body = anBody('全新的聊天消息');
    const sid = getOrCreateSession('anthropic', '/v1/messages', body);
    // 不应并入过期 pending，而是新建会话
    expect(sid).not.toBe(pendingId);
    expect(getSession(pendingId)!.status).toBe('pending');
  });

  it('升级 pending 会话时保留已有上游覆写（不无条件覆写）', () => {
    const pendingId = createPendingSession('ClaudeCode');
    updateSessionUpstream(pendingId, 'openai');
    const body = anBody('覆写保护测试');
    const sid = getOrCreateSession('anthropic', '/v1/messages', body);
    expect(sid).toBe(pendingId);
    expect(getSession(sid)!.upstream_provider).toBe('openai');
  });

  it('toolFromProvider 通过 URL 前缀区分工具', () => {
    expect(toolFromProvider('anthropic')).toBe('claudecode');
    expect(toolFromProvider('openai')).toBe('codex');
    expect(toolFromProvider('unknown')).toBe('unknown');
  });

  it('extractConversationSeed 从 body 提取稳定种子（全文哈希）', () => {
    const s1 = extractConversationSeed(anBody('你好世界'));
    const s2 = extractConversationSeed(anBody('你好世界'));
    expect(s1).toBe(s2);
    expect(s1).not.toBe('_empty_');
    // 哈希后不再包含明文
    expect(s1).not.toContain('你好世界');
  });

  it('system 仅 300 字符后才不同 → 不同种子（修复截断碰撞）', () => {
    // Claude Code 同项目会话的 system prompt 前段恒定，旧实现截前 300 字符导致碰撞
    const prefix = 'x'.repeat(400);
    const body1 = { model: 'm', system: prefix + 'A', messages: [{ role: 'user', content: 'same' }] };
    const body2 = { model: 'm', system: prefix + 'B', messages: [{ role: 'user', content: 'same' }] };
    expect(extractConversationSeed(body1)).not.toBe(extractConversationSeed(body2));
  });

  it('extractConversationSeed 相同消息生成相同种子', () => {
    const s1 = extractConversationSeed(anBody('test message'));
    const s2 = extractConversationSeed(anBody('test message'));
    expect(s1).toBe(s2);
  });

  it('extractConversationSeed 不同消息生成不同种子', () => {
    const s1 = extractConversationSeed(anBody('消息A'));
    const s2 = extractConversationSeed(anBody('消息B'));
    expect(s1).not.toBe(s2);
  });

  it('computeFingerprint 相同入参 → 相同指纹', () => {
    const fp1 = computeFingerprint('anthropic', 'seed1');
    const fp2 = computeFingerprint('anthropic', 'seed1');
    expect(fp1).toBe(fp2);
  });

  it('computeFingerprint 不同种子 → 不同指纹', () => {
    const fp1 = computeFingerprint('anthropic', 'seed1');
    const fp2 = computeFingerprint('anthropic', 'seed2');
    expect(fp1).not.toBe(fp2);
  });

  // ── URL 路径嵌入 /s/<id>/  → 已知会话 ID 直通 ──

  it('knownSessionId：复用已有 pending 会话并升级为 active', () => {
    const pendingId = createPendingSession('ClaudeCode');
    const body = anBody('任意消息');

    // 带 knownSessionId 调用 → 应复用 pending 会话
    const sid = getOrCreateSession('anthropic', '/v1/messages', body, undefined, pendingId);
    expect(sid).toBe(pendingId);

    const session = getSession(sid);
    expect(session!.status).toBe('active');
  });

  it('knownSessionId：多次调用返回同一会话', () => {
    const pendingId = createPendingSession('ClaudeCode');
    const body = anBody('hello');

    const sid1 = getOrCreateSession('anthropic', '/v1/messages', body, undefined, pendingId);
    const sid2 = getOrCreateSession('anthropic', '/v1/messages', body, undefined, pendingId);
    expect(sid1).toBe(sid2);
    expect(sid1).toBe(pendingId);
  });

  it('knownSessionId 不存在时回退到指纹匹配', () => {
    // 使用一个不存在的 session ID
    const body = anBody('测试消息');
    const sid1 = getOrCreateSession('anthropic', '/v1/messages', body, undefined, 99999);

    // 回退到指纹匹配：相同 body 再次调用应返回同一会话
    const sid2 = getOrCreateSession('anthropic', '/v1/messages', body);
    expect(sid1).toBe(sid2);
  });

  it('knownSessionId 区分不同进程', () => {
    const pid1 = createPendingSession('ClaudeCode');
    const pid2 = createPendingSession('ClaudeCode');
    const body = anBody('hello');

    const sid1 = getOrCreateSession('anthropic', '/v1/messages', body, undefined, pid1);
    const sid2 = getOrCreateSession('anthropic', '/v1/messages', body, undefined, pid2);

    // 不同 knownSessionId → 不同会话
    expect(sid1).not.toBe(sid2);
    expect(sid1).toBe(pid1);
    expect(sid2).toBe(pid2);
  });
});
