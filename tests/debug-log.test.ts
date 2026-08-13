/** debugLog 测试 — 调试日志默认静默，--debug / --dev / LLM_MONITOR_DEBUG=1 时输出 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { debugLog } from '../proxy/config.js';

describe('debugLog', () => {
  // 外部环境可能预设 LLM_MONITOR_DEBUG → 每个用例前清理，保证「默认静默」断言可靠
  beforeEach(() => {
    delete process.env.LLM_MONITOR_DEBUG;
  });
  afterEach(() => {
    delete process.env.LLM_MONITOR_DEBUG;
    vi.restoreAllMocks();
  });

  it('默认不输出', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    debugLog('[proxy] 测试');
    expect(spy).not.toHaveBeenCalled();
  });

  it('LLM_MONITOR_DEBUG=1 时输出', () => {
    process.env.LLM_MONITOR_DEBUG = '1';
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    debugLog('[proxy] 测试', 123);
    expect(spy).toHaveBeenCalledWith('[proxy] 测试', 123);
  });

  it('LLM_MONITOR_DEBUG 为其他值时不输出', () => {
    process.env.LLM_MONITOR_DEBUG = '0';
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    debugLog('[proxy] 测试');
    expect(spy).not.toHaveBeenCalled();
  });

  it('开发模式（--dev）下输出', () => {
    process.argv.push('--dev');
    try {
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      debugLog('[proxy] 测试');
      expect(spy).toHaveBeenCalledWith('[proxy] 测试');
    } finally {
      process.argv.pop();
    }
  });
});
