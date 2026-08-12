import { describe, it, expect } from 'vitest';
import { normalizeTokens, detectFormatFromTool } from '../proxy/normalizer.js';

describe('detectFormatFromTool', () => {
  it('ClaudeCode → anthropic', () => {
    expect(detectFormatFromTool('ClaudeCode')).toBe('anthropic');
    expect(detectFormatFromTool('claudecode')).toBe('anthropic');
  });

  it('其余工具 → openai（codex / DeepSeek / Kimi / GLM 等）', () => {
    expect(detectFormatFromTool('codex')).toBe('openai');
    expect(detectFormatFromTool('DeepSeek')).toBe('openai');
    expect(detectFormatFromTool('Kimi')).toBe('openai');
    expect(detectFormatFromTool('GLM')).toBe('openai');
    expect(detectFormatFromTool('unknown')).toBe('openai');
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

  it('OpenAI 归一化（含 codex / DeepSeek / Kimi / GLM）', () => {
    const r = normalizeTokens('openai', {
      usage: { prompt_tokens: 600, completion_tokens: 400, prompt_tokens_details: { cached_tokens: 300 } },
    });
    expect(r.prompt_tokens).toBe(600);
    expect(r.output_tokens).toBe(400);
    expect(r.cache_read_tokens).toBe(300);
    expect(r.cache_write_tokens).toBeNull();
    expect(r.uncached_input).toBe(300);
  });

  it('无缓存时字段为 null', () => {
    const r = normalizeTokens('openai', { usage: { prompt_tokens: 100, completion_tokens: 50 } });
    expect(r.cache_read_tokens).toBeNull();
    expect(r.uncached_input).toBe(100);
  });

  it('未知格式默认按 OpenAI 处理', () => {
    const r = normalizeTokens('unknown', { usage: { prompt_tokens: 100, completion_tokens: 50 } });
    expect(r.prompt_tokens).toBe(100);
    expect(r.output_tokens).toBe(50);
  });

  // ── OpenAI Responses API 格式（/responses 端点，Codex 等工具使用）──

  it('★ Responses API 格式归一化（input_tokens / output_tokens）', () => {
    const r = normalizeTokens('openai', {
      usage: { input_tokens: 700, output_tokens: 500, total_tokens: 1200 },
    });
    expect(r.prompt_tokens).toBe(700);
    expect(r.output_tokens).toBe(500);
    expect(r.uncached_input).toBe(700);
    expect(r.cache_read_tokens).toBeNull();
    expect(r.cache_write_tokens).toBeNull();
  });

  it('★ Responses API 带缓存字段', () => {
    const r = normalizeTokens('openai', {
      usage: { input_tokens: 1000, output_tokens: 600, total_tokens: 1600, input_tokens_details: { cached_tokens: 400 } },
    });
    expect(r.prompt_tokens).toBe(1000);
    expect(r.output_tokens).toBe(600);
    expect(r.cache_read_tokens).toBe(400);
    expect(r.uncached_input).toBe(600);
  });

  it('★ Responses API 优先使用 prompt_tokens（Chat Completions 兼容）', () => {
    // 当两种字段都存在时，prompt_tokens/completion_tokens 优先（现有一致行为）
    const r = normalizeTokens('openai', {
      usage: { prompt_tokens: 100, completion_tokens: 50, input_tokens: 999, output_tokens: 888 },
    });
    expect(r.prompt_tokens).toBe(100);
    expect(r.output_tokens).toBe(50);
  });
});
