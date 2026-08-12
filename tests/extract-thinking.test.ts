import { describe, it, expect } from 'vitest';
import { extractThinking } from '../shared/extractThinking.js';

describe('extractThinking', () => {
  it('形态 1：干净结构 {thinking} 直接提取', () => {
    expect(extractThinking(JSON.stringify({ model: 'x', content: '正文', thinking: '思考全文' }))).toBe('思考全文');
  });

  it('形态 2：Anthropic 原始结构 content 数组中的 thinking 块拼接提取', () => {
    const raw = JSON.stringify({
      content: [
        { type: 'thinking', thinking: '第一段' },
        { type: 'thinking', thinking: '第二段' },
        { type: 'text', text: '答案' },
      ],
    });
    expect(extractThinking(raw)).toBe('第一段第二段');
  });

  it('形态 3：OpenAI 原始结构 reasoning_content 提取', () => {
    const raw = JSON.stringify({ choices: [{ message: { role: 'assistant', reasoning_content: '推导过程', content: '答案' } }] });
    expect(extractThinking(raw)).toBe('推导过程');
  });

  it('无思考的响应返回 null', () => {
    expect(extractThinking(JSON.stringify({ model: 'x', content: '正文' }))).toBeNull();
    expect(extractThinking(JSON.stringify({ choices: [{ message: { content: '答案' } }] }))).toBeNull();
    expect(extractThinking(null)).toBeNull();
    expect(extractThinking('')).toBeNull();
  });

  it('非法 JSON 返回 null', () => {
    expect(extractThinking('not-json')).toBeNull();
    expect(extractThinking('{"broken":')).toBeNull();
  });
});
