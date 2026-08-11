/** Token 归一化模块 — 两种 API 格式 usage → 统一字段 */
import type { NormalizedTokens } from '../shared/types.js';

/**
 * 从上游 URL 检测 API 格式（供格式转换使用）。
 * 规则：URL 含 anthropic → anthropic，其余默认 openai。
 */
export function detectFormatFromUrl(url: string): string {
  return url.toLowerCase().includes('anthropic') ? 'anthropic' : 'openai';
}

/** 根据下游工具名映射到归一化格式（仅两种：ClaudeCode→anthropic，其余→openai） */
export function detectFormatFromProvider(name: string): string {
  return name.toLowerCase() === 'claudecode' ? 'anthropic' : 'openai';
}

export function normalizeTokens(format: string, responseBody: Record<string, any>): NormalizedTokens {
  const usage = responseBody.usage || {};
  if (format === 'anthropic') return normalizeAnthropic(usage);
  return normalizeOpenAI(usage);
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
