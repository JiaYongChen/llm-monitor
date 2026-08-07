/** 会话识别模块 — 三元组指纹 + 会话生命周期 */
import { createHash } from 'node:crypto';
import { upsertSession } from './db.js';

const TOOL_MAP: Record<string, string> = {
  anthropic: 'ClaudeCode',
  openai: 'codex',
};

export function toolFromProvider(provider: string): string {
  return TOOL_MAP[provider] || provider;
}

export function computeFingerprint(
  provider: string,
  sourcePort: number,
  authHeader: string | null,
): string {
  let keyPrefix = '';
  if (authHeader) {
    const parts = authHeader.split(/\s+/);
    if (parts.length >= 2) keyPrefix = parts[1].slice(0, 12);
  }
  const raw = `${provider}:${sourcePort}:${keyPrefix}`;
  return createHash('sha256').update(raw).digest('hex').slice(0, 24);
}

export function getOrCreateSession(
  provider: string,
  sourcePort: number,
  authHeader: string | null,
  endpoint: string,
): number {
  const fingerprint = computeFingerprint(provider, sourcePort, authHeader);
  const tool = toolFromProvider(provider);
  return upsertSession(fingerprint, tool, endpoint);
}
