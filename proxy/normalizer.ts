/** Token 归一化模块 — 四家 provider usage → 统一字段 */
import type { NormalizedTokens } from '../shared/types.js';

/** 所有已注册的 API 格式（与 switch case 同步维护，供 recorder/router 复用） */
export const KNOWN_FORMATS = new Set(['anthropic', 'openai', 'deepseek', 'qwen']);

export function normalizeTokens(provider: string, responseBody: Record<string, any>): NormalizedTokens {
  const usage = responseBody.usage || {};
  switch (provider.toLowerCase()) {
    case 'anthropic': return normalizeAnthropic(usage);
    case 'openai': return normalizeOpenAI(usage);
    case 'deepseek': return normalizeDeepSeek(usage);
    case 'qwen': return normalizeQwen(usage);
    default: return { prompt_tokens: null, output_tokens: null, cache_read_tokens: null, cache_write_tokens: null, uncached_input: null };
  }
}

function normalizeAnthropic(u: any): NormalizedTokens {
  const input = u.input_tokens ?? null;
  const output = u.output_tokens ?? null;
  const cacheRead = u.cache_read_input_tokens || 0;
  const cacheWrite = u.cache_creation_input_tokens || 0;
  return {
    prompt_tokens: input, output_tokens: output,
    cache_read_tokens: cacheRead > 0 ? cacheRead : null,
    cache_write_tokens: cacheWrite > 0 ? cacheWrite : null,
    uncached_input: input != null ? input - cacheWrite : null,
  };
}

function normalizeOpenAI(u: any): NormalizedTokens {
  const input = u.prompt_tokens ?? null;
  const output = u.completion_tokens ?? null;
  const cached = u.prompt_tokens_details?.cached_tokens || 0;
  return {
    prompt_tokens: input, output_tokens: output,
    cache_read_tokens: cached > 0 ? cached : null,
    cache_write_tokens: null,
    uncached_input: input != null ? input - cached : null,
  };
}

function normalizeDeepSeek(u: any): NormalizedTokens {
  const input = u.prompt_tokens ?? null;
  const output = u.completion_tokens ?? null;
  const cacheHit = u.prompt_cache_hit_tokens || 0;
  const cacheMiss = u.prompt_cache_miss_tokens ?? null;
  return {
    prompt_tokens: input, output_tokens: output,
    cache_read_tokens: cacheHit > 0 ? cacheHit : null,
    cache_write_tokens: null,
    uncached_input: cacheMiss,
  };
}

function normalizeQwen(u: any): NormalizedTokens {
  const input = u.prompt_tokens ?? null;
  const output = u.completion_tokens ?? null;
  const details = u.prompt_tokens_details || {};
  const cached = details.cached_tokens || 0;
  const cacheCreate = details.cache_creation_input_tokens || 0;
  return {
    prompt_tokens: input, output_tokens: output,
    cache_read_tokens: cached > 0 ? cached : null,
    cache_write_tokens: cacheCreate > 0 ? cacheCreate : null,
    uncached_input: input != null ? input - cached - cacheCreate : null,
  };
}
