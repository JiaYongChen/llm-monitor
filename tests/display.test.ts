/** displayName 显示函数测试 — 映射表 + 特殊词 + 分词算法 */
import { describe, it, expect } from 'vitest';
import { displayName } from '../webui/src/lib/display';

describe('displayName', () => {
  it('空值与空串返回空串', () => {
    expect(displayName(null)).toBe('');
    expect(displayName(undefined)).toBe('');
    expect(displayName('')).toBe('');
  });

  it('整体名称映射表命中（大小写不敏感）', () => {
    expect(displayName('claudecode')).toBe('ClaudeCode');
    expect(displayName('CLAUDEcode')).toBe('ClaudeCode');
    expect(displayName('codex')).toBe('Codex');
    expect(displayName('anthropic')).toBe('Anthropic');
    expect(displayName('openai')).toBe('OpenAI');
    expect(displayName('chatgpt')).toBe('ChatGPT');
  });

  it('特殊词整词命中 → 全大写', () => {
    expect(displayName('gpt-5-mini')).toBe('GPT-5-Mini');
    expect(displayName('glm-4.5')).toBe('GLM-4.5');
    expect(displayName('my-api-tool')).toBe('My-API-Tool');
    expect(displayName('llm_proxy')).toBe('LLM_Proxy');
  });

  it('非特殊词 token 首字母大写，数字开头保持原样', () => {
    expect(displayName('gpt-4o')).toBe('GPT-4o');
    expect(displayName('claude-sonnet-4-5')).toBe('Claude-Sonnet-4-5');
    expect(displayName('deepseek')).toBe('Deepseek');
    expect(displayName('my-tool')).toBe('My-Tool');
  });

  it('特殊词须整词匹配（前缀命中不算）', () => {
    expect(displayName('my-glms-tool')).toBe('My-Glms-Tool');
    expect(displayName('apiservice')).toBe('Apiservice');
  });

  it('空格与点分隔符', () => {
    expect(displayName('my tool')).toBe('My Tool');
    expect(displayName('v1.2')).toBe('V1.2');
  });
});
