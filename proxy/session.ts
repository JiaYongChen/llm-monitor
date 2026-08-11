/** 会话识别模块 — 指纹 + 会话生命周期 */
import { createHash } from 'node:crypto';
import { upsertSession, getSession, activateSession } from './db.js';

// ── Provider → 工具名映射 ──

/** 通过 URL 中的 provider 确定工具名称 */
export function toolFromProvider(provider: string): string {
  switch (provider) {
    case 'anthropic': return 'ClaudeCode';
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

/** 从 system 字段提取文本（兼容字符串和内容块数组两种格式）。
 *  归一化后确保同一 system prompt 产生相同种子，无论 API 调用中使用哪种格式。 */
function normalizeSystem(system: any): string {
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) {
    // 内容块数组格式：[{type: "text", text: "..."}, ...]
    return system.map((b: any) => b?.text ?? '').join('\n');
  }
  return JSON.stringify(system ?? '');
}

/** 从请求 body 中提取会话标签（首条用户消息前 40 字） */
function extractSessionLabel(body: any): string {
  try {
    const msgs = body?.messages;
    if (Array.isArray(msgs)) {
      const userMsg = msgs.find((m: any) => m?.role === 'user');
      if (userMsg?.content != null) {
        const text = typeof userMsg.content === 'string'
          ? userMsg.content
          : Array.isArray(userMsg.content)
            ? userMsg.content.map((b: any) => b?.text ?? '').join(' ').trim()
            : '';
        const cleaned = text.replace(/\s+/g, ' ').trim();
        return cleaned.slice(0, 40) || null;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** 从请求 body 中提取会话特征种子。
 *  同一聊天的多轮请求共享相同的 system prompt + 第一条用户消息 → 相同种子；
 *  不同聊天的第一条用户消息不同 → 不同种子。 */
export function extractConversationSeed(body: any): string {
  try {
    const parts: string[] = [];

    // system 字段：统一归一化（字符串 / 内容块数组 → 相同文本）
    if (body?.system != null) {
      parts.push(normalizeSystem(body.system).slice(0, 300));
    }

    const messages = body?.messages;
    if (Array.isArray(messages)) {
      // OpenAI：messages 数组中的第一条 system 消息
      const sysMsg = messages.find((m: any) => m?.role === 'system');
      if (sysMsg?.content != null) {
        parts.push(normalizeContent(sysMsg.content).slice(0, 300));
      }

      // 第一条用户消息（多轮对话中也始终是同一个）
      const userMsg = messages.find((m: any) => m?.role === 'user');
      if (userMsg?.content != null) {
        parts.push(normalizeContent(userMsg.content).slice(0, 300));
      }
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
