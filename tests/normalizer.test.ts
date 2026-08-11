import { describe, it, expect } from 'vitest';
import { normalizeTokens } from '../proxy/normalizer.js';

describe('normalizer', () => {
  it('Anthropic 归一化', () => {
    const r = normalizeTokens('anthropic', {
      usage: { input_tokens: 500, output_tokens: 300, cache_creation_input_tokens: 100, cache_read_input_tokens: 200 },
    });
    expect(r.prompt_tokens).toBe(500);
    expect(r.output_tokens).toBe(300);
    expect(r.cache_read_tokens).toBe(200);
    expect(r.cache_write_tokens).toBe(100);
    expect(r.uncached_input).toBe(400);
  });

  it('OpenAI 归一化', () => {
    const r = normalizeTokens('openai', {
      usage: { prompt_tokens: 600, completion_tokens: 400, prompt_tokens_details: { cached_tokens: 300 } },
    });
    expect(r.cache_read_tokens).toBe(300);
    expect(r.cache_write_tokens).toBeNull();
    expect(r.uncached_input).toBe(300);
  });

  it('未知格式回退 OpenAI 归一化', () => {
    const r = normalizeTokens('unknown', {
      usage: { prompt_tokens: 1200, completion_tokens: 500 },
    });
    expect(r.prompt_tokens).toBe(1200);
    expect(r.output_tokens).toBe(500);
  });

  it('无缓存时字段为 null', () => {
    const r = normalizeTokens('openai', { usage: { prompt_tokens: 100, completion_tokens: 50 } });
    expect(r.cache_read_tokens).toBeNull();
    expect(r.uncached_input).toBe(100);
  });
});
