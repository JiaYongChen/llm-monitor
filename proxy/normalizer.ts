/** Token 归一化模块 — 两种 API 格式 usage → 统一字段 */
import type { NormalizedTokens } from '../shared/types.js';

/**
 * 从上游 URL 检测 API 格式（供格式转换使用）。
 * 精确匹配 /anthropic 路径段落 + 域名含 anthropic（含 anthropic-mirror 等变体），
 * 仅排除路径中 anthropic- 前缀的非 Anthropic 网关（如 /anthropic-compat）。
 */
export function detectFormatFromUrl(url: string): string {
  const lower = url.toLowerCase();
  try {
    const host = new URL(url).hostname;
    // 域名含 anthropic → 几乎肯定是 Anthropic 格式网关
    if (host.includes('anthropic')) return 'anthropic';
  } catch {}
  // 路径精确匹配 /anthropic 作为独立段落（不以 - 继续，避免误判 /anthropic-compat）
  return /\/anthropic(?:\/|$|\?|#)/.test(lower) ? 'anthropic' : 'openai';
}

/** 根据下游工具名映射到归一化格式（仅两种：claudecode→anthropic，其余→openai） */
export function detectFormatFromTool(name: string): string {
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
    uncached_input: input != null ? Math.max(0, input - cacheWrite) : null,
  };
}

function normalizeOpenAI(u: any): NormalizedTokens {
  // Chat Completions 优先，Responses API 字段 (input/output_tokens) 作 fallback
  const input = u.prompt_tokens ?? u.input_tokens ?? null;
  const output = u.completion_tokens ?? u.output_tokens ?? null;
  // 缓存字段：Chat Completions → prompt_tokens_details.cached_tokens，Responses API → input_tokens_details.cached_tokens
  const cached = u.prompt_tokens_details?.cached_tokens ?? u.input_tokens_details?.cached_tokens ?? 0;
  return {
    prompt_tokens: input, output_tokens: output,
    cache_read_tokens: cached > 0 ? cached : null,
    cache_write_tokens: null,
    uncached_input: input != null ? Math.max(0, input - cached) : null,
  };
}
