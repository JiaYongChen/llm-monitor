import { describe, it, expect } from 'vitest';
import { normalizeTokens, detectFormatFromProvider } from '../proxy/normalizer.js';

describe('detectFormatFromProvider', () => {
  it('Anthropic → anthropic', () => {
    expect(detectFormatFromProvider('Anthropic')).toBe('anthropic');
    expect(detectFormatFromProvider('anthropic')).toBe('anthropic');
  });

  it('DeepSeek → deepseek', () => {
    expect(detectFormatFromProvider('DeepSeek')).toBe('deepseek');
  });

  it('Qwen → qwen', () => {
    expect(detectFormatFromProvider('Qwen')).toBe('qwen');
    expect(detectFormatFromProvider('tongyi')).toBe('qwen');
  });

  it('OpenAI / Kimi / GLM → openai', () => {
    expect(detectFormatFromProvider('OpenAI')).toBe('openai');
    expect(detectFormatFromProvider('Kimi')).toBe('openai');
    expect(detectFormatFromProvider('GLM')).toBe('openai');
  });

  it('未知供应商默认 openai', () => {
    expect(detectFormatFromProvider('unknown')).toBe('openai');
  });
});

describe('normalizeTokens', () => {
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

  it('OpenAI 归一化（含 Kimi / GLM）', () => {
    const r = normalizeTokens('openai', {
      usage: { prompt_tokens: 600, completion_tokens: 400, prompt_tokens_details: { cached_tokens: 300 } },
    });
    expect(r.prompt_tokens).toBe(600);
    expect(r.output_tokens).toBe(400);
    expect(r.cache_read_tokens).toBe(300);
    expect(r.cache_write_tokens).toBeNull();
    expect(r.uncached_input).toBe(300);
  });

  it('DeepSeek 归一化', () => {
    const r = normalizeTokens('deepseek', {
      usage: { prompt_tokens: 1200, completion_tokens: 500, prompt_cache_hit_tokens: 800, prompt_cache_miss_tokens: 400 },
    });
    expect(r.prompt_tokens).toBe(1200);
    expect(r.output_tokens).toBe(500);
    expect(r.cache_read_tokens).toBe(800);
    expect(r.uncached_input).toBe(400);
  });

  it('Qwen 归一化', () => {
    const r = normalizeTokens('qwen', {
      usage: { prompt_tokens: 800, completion_tokens: 350, prompt_tokens_details: { cached_tokens: 400, cache_creation_input_tokens: 200 } },
    });
    expect(r.prompt_tokens).toBe(800);
    expect(r.output_tokens).toBe(350);
    expect(r.cache_read_tokens).toBe(400);
    expect(r.cache_write_tokens).toBe(200);
    expect(r.uncached_input).toBe(200);
  });

  it('无缓存时字段为 null', () => {
    const r = normalizeTokens('openai', { usage: { prompt_tokens: 100, completion_tokens: 50 } });
    expect(r.cache_read_tokens).toBeNull();
    expect(r.uncached_input).toBe(100);
  });
});
