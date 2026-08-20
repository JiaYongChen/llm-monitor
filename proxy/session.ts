/** 会话识别模块 — 指纹 + 会话生命周期 */
import { createHash } from 'node:crypto';
import { upsertSession, getSession, activateSession } from './db.js';

// ── Provider → 工具名映射 ──

/** 通过 URL 中的 provider 确定工具名称（大小写不敏感，返回小写工具名） */
export function toolFromProvider(provider: string): string {
  switch (provider.toLowerCase()) {
    case 'anthropic': return 'claudecode';
    case 'openai':    return 'codex';
    default:          return provider;
  }
}

// ── 会话种子提取 ──

/** 标准化消息内容为字符串（支持纯文本和内容块数组两种格式） */
function normalizeContent(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((b: any) => b?.text ?? JSON.stringify(b)).join('\n');
  }
  return String(content ?? '');
}

/** 从 system/instructions 字段提取文本（兼容字符串和内容块数组两种格式） */
function normalizeSystem(system: any): string {
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) {
    return system.map((b: any) => b?.text ?? '').join('\n');
  }
  return JSON.stringify(system ?? '');
}

/** 从消息数组中找第一条匹配角色（system/developer/user）的消息文本（已归一化） */
function findFirstMessageText(msgs: any[], roles: string[]): string | null {
  if (!Array.isArray(msgs)) return null;
  const msg = msgs.find((m: any) => roles.includes(m?.role));
  if (msg?.content == null) return null;
  return normalizeContent(msg.content);
}

/** 提取用户消息文本（用于标签）— 单行、去空白、前 40 字 */
function extractUserText(msgs: any[]): string | null {
  const text = findFirstMessageText(msgs, ['user']);
  if (!text) return null;
  const cleaned = text.replace(/\s+/g, ' ').trim();
  return cleaned.slice(0, 40) || null;
}

/** 获取消息数组（Chat Completions 用 messages，Responses API 用 input） */
function getMessageArrays(body: any): any[] {
  const sources: any[] = [];
  if (Array.isArray(body?.messages)) sources.push(body.messages);
  if (Array.isArray(body?.input)) sources.push(body.input);
  return sources;
}

/** 从请求 body 中提取会话标签（首条用户消息前 40 字），无用户消息时返回 null。
 *  兼容 Chat Completions API（messages 数组）和 Responses API（input 数组）。 */
function extractSessionLabel(body: any): string | null {
  try {
    for (const msgs of getMessageArrays(body)) {
      const text = extractUserText(msgs);
      if (text) return text;
    }
    return null;
  } catch {
    return null;
  }
}

/** 种子片段全文摘要：截断前缀会使 Claude Code 等工具的同项目会话（system prompt
 *  前段恒定）互相碰撞，故对全文取 SHA256（定长，也避免种子过长） */
function seedDigest(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** 从请求 body 中提取会话特征种子。
 *  兼容 Chat Completions API（messages + system）和 Responses API（input + instructions）。
 *  同一聊天的多轮请求共享相同的 system prompt + 第一条用户消息 → 相同种子；
 *  不同聊天的第一条用户消息不同 → 不同种子。
 *  注意：system 与首条消息完全相同的两个聊天仍会碰撞（内容指纹的固有限制），
 *  但全文哈希已消除「前 300 字符相同即碰撞」这一高频场景。 */
export function extractConversationSeed(body: any): string {
  try {
    const parts: string[] = [];

    // 顶层 system / instructions 字段（全文哈希）
    if (body?.system != null) parts.push(seedDigest(normalizeSystem(body.system)));
    if (body?.instructions != null) parts.push(seedDigest(normalizeSystem(body.instructions)));

    // 消息数组中的 system/developer + 用户消息（两类 API 共用一个循环，全文哈希）
    for (const msgs of getMessageArrays(body)) {
      const sysText = findFirstMessageText(msgs, ['system', 'developer']);
      if (sysText) parts.push(seedDigest(sysText));

      const userText = findFirstMessageText(msgs, ['user']);
      if (userText) parts.push(seedDigest(userText));
    }

    return parts.join('||') || '_empty_';
  } catch {
    return '_empty_';
  }
}

// ── 指纹 ──

/** 基于 provider + 会话种子生成指纹。
 *  同一聊天 → 相同种子 → 相同指纹 → 同一会话；
 *  不同聊天 → 种子不同 → 不同指纹 → 不同会话。 */
export function computeFingerprint(provider: string, conversationSeed: string): string {
  const seedHash = createHash('sha256').update(conversationSeed).digest('hex').slice(0, 16);
  const raw = `${provider}:${seedHash}`;
  return createHash('sha256').update(raw).digest('hex').slice(0, 24);
}

// ── 会话生命周期 ──

/**
 * 查找或创建会话：
 * 0. knownSessionId 已提供（URL 路径嵌入 /s/<id>/）→ 直接激活并复用
 * 1. 用完整指纹精确匹配 → 命中则复用（同一聊天的后续请求）
 * 2. 未命中且有 pending 会话 → 升级并复用（包装脚本预创建的启动会话）
 * 3. 都不命中 → 新建会话
 *
 * 会话不会自动过期，一直保持 active 直到用户手动结束或清理。
 */
export function getOrCreateSession(
  provider: string,
  endpoint: string,
  body: any,
  toolOverride?: string,
  knownSessionId?: number,
): number {
  // URL 路径嵌入 /s/<id>/ → 直接使用已知会话 ID
  if (knownSessionId != null) {
    const session = getSession(knownSessionId);
    if (session) {
      activateSession(knownSessionId);
      return knownSessionId;
    }
    // 会话不存在（异常情况）→ 走正常指纹流程兜底
    console.warn(`[session] 会话 ${knownSessionId} 不存在，回退到指纹匹配`);
  }

  let seed = extractConversationSeed(body);
  // 无消息体的请求用端点路径区分，避免全部混入同一会话
  if (seed === '_empty_') {
    seed = `_req_:${endpoint}`;
  }
  const fingerprint = computeFingerprint(provider, seed);
  const tool = toolOverride || toolFromProvider(provider);
  // 从请求体提取会话标签（首条用户消息简介）
  const label = extractSessionLabel(body);
  return upsertSession(fingerprint, tool, endpoint, label);
}
