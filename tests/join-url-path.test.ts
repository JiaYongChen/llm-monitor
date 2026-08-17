import { describe, it, expect } from 'vitest';
import { joinUrlPath } from '../shared/joinUrlPath.js';

describe('joinUrlPath', () => {
  it('普通拼接：base 不含重复尾段', () => {
    expect(joinUrlPath('https://api.deepseek.com', '/v1/models')).toBe('https://api.deepseek.com/v1/models');
  });
  it('base 含 /v1 尾段时去重（阿里云百炼兼容模式写法），不产生 /v1/v1', () => {
    expect(joinUrlPath('https://maas.example.com/compatible-mode/v1', '/v1/models')).toBe('https://maas.example.com/compatible-mode/v1/models');
  });
  it('base 尾斜杠先归一化再拼接', () => {
    expect(joinUrlPath('https://maas.example.com/compatible-mode/v1/', '/v1/models')).toBe('https://maas.example.com/compatible-mode/v1/models');
  });
  it('路径首斜杠与尾斜杠归一化', () => {
    expect(joinUrlPath('https://api.openai.com/v1/', '/chat/completions')).toBe('https://api.openai.com/v1/chat/completions');
  });
  it('空路径直接返回去尾斜杠的 base', () => {
    expect(joinUrlPath('https://api.openai.com/', '')).toBe('https://api.openai.com');
  });
  it('只去重首段，后续重复段保留（路径语义原样）', () => {
    expect(joinUrlPath('https://x.com/v1', '/v1/responses')).toBe('https://x.com/v1/responses');
  });
});
