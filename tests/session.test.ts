import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { computeFingerprint, toolFromProvider, getOrCreateSession } from '../proxy/session.js';
import { initDb, closeDb } from '../proxy/db.js';
import { createTempDb } from './setup.js';

const tmp = createTempDb();
beforeAll(async () => { await initDb(tmp.dbPath); });
afterAll(() => { closeDb(); tmp.cleanup(); });

describe('session', () => {
  it('同一指纹返回相同会话', () => {
    const sid1 = getOrCreateSession('anthropic', 54321, 'Bearer sk-ant-test123', '/v1/messages');
    const sid2 = getOrCreateSession('anthropic', 54321, 'Bearer sk-ant-test123', '/v1/messages');
    expect(sid1).toBe(sid2);
  });

  it('不同端口返回不同会话', () => {
    const sid1 = getOrCreateSession('anthropic', 54321, 'Bearer sk-test', '/v1/messages');
    const sid2 = getOrCreateSession('anthropic', 54322, 'Bearer sk-test', '/v1/messages');
    expect(sid1).not.toBe(sid2);
  });

  it('toolFromProvider 映射正确', () => {
    expect(toolFromProvider('anthropic')).toBe('ClaudeCode');
    expect(toolFromProvider('openai')).toBe('codex');
    expect(toolFromProvider('unknown')).toBe('unknown');
  });
});
