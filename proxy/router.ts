/** 路由注册 — 代理路由 + /api/* 查询路由 */
import type { FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { forwardRequest, forwardStream } from './forwarder.js';
import { getOrCreateSession, computeFingerprint, extractConversationSeed } from './session.js';
import { randomUUID } from 'node:crypto';
import {
  listSessions, getSession, updateSessionLabel, updateSessionUpstream, updateSessionModel, mergeSessions, createPendingSession,
  listCalls as dbListCalls, getCall as dbGetCall, getStats,
  listPricing, upsertPricing, deletePricing,
  clearAllData, initDefaultProviders, cleanupOldCalls,
  listProviderConfigs, updateProviderConfig, getProviderConfig,
  addProviderConfig, deleteProviderConfig, getSetting, setSetting,
} from './db.js';
import { PORT, DATA_DIR, SESSION_TIMEOUT_SEC, AUTO_CLEANUP_DAYS } from './config.js';
import { getRates, getRatesUpdatedAt, refreshRates } from './rates.js';
import type { CallRecord } from '../shared/types.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

/** 上游 URL 映射（测试时可替换为 mock server 地址） */
export const UPSTREAMS: Record<string, string> = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com',
};

/** 从 provider_config 表加载上游配置 */
export function getConfiguredUpstream(provider: string, endpoint?: string): { base_url: string; api_key: string; enabled: boolean } {
  const config = getProviderConfig(provider);
  if (!config) {
    return { base_url: UPSTREAMS[provider] || '', api_key: '', enabled: true };
  }
  if (!config.enabled) {
    return { base_url: '', api_key: '', enabled: false };
  }
  // 根据端点格式选择 URL：含 /messages → Anthropic，否则 OpenAI
  const isAnthropic = endpoint?.includes('/messages');
  const url = isAnthropic && config.base_url_anthropic ? config.base_url_anthropic : config.base_url;
  return { base_url: url, api_key: config.api_key, enabled: true };
}

function cleanHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  const skip = new Set(['host', 'transfer-encoding', 'connection', 'content-length', 'content-encoding']);
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!skip.has(k.toLowerCase()) && typeof v === 'string') {
      result[k] = v;
    }
  }
  return result;
}

/** 从 API 端点路径反推下游工具类型和默认上游供应商（用于无 provider 前缀的请求）。
 *  path 不含前导 /。返回 { tool, upstream } — tool 用于会话，upstream 用于转发。 */
function detectFromPath(path: string): { tool: string; upstream: string } | null {
  const configs = listProviderConfigs().filter(c => c.enabled);
  if (path === 'v1/messages' || path.startsWith('v1/messages/')) {
    // 优先匹配内置 Anthropic，其次匹配 api_format 为 anthropic 的供应商
    const anthropic = configs.find(c => c.provider === 'Anthropic')
      || configs.find(c => (c.api_format || c.provider.toLowerCase()) === 'anthropic');
    return { tool: 'ClaudeCode', upstream: anthropic?.provider || 'Anthropic' };
  }
  if (path === 'v1/chat/completions' || path.startsWith('v1/chat/completions/')) {
    // 优先匹配内置 OpenAI，其次匹配 api_format 为 openai 的供应商
    const match = configs.find(c => c.provider === 'OpenAI')
      || configs.find(c => (c.api_format || c.provider.toLowerCase()) === 'openai');
    const p = match?.provider || 'OpenAI';
    return { tool: p === 'OpenAI' ? 'codex' : p, upstream: p };
  }
  return null;
}

/** recorder 入队函数引用（在 Task 10 中设置为实际实现） */
let _enqueueRef: ((record: CallRecord) => void) | null = null;
export function setEnqueueRef(fn: (record: CallRecord) => void): void {
  _enqueueRef = fn;
}

export async function registerProxyRoutes(app: FastifyInstance): Promise<void> {
  await _registerProxyRoutes(app);
}

/** 注册 API 查询路由（供面板端口单独挂载） */
export function registerApiRoutes(app: FastifyInstance): void {
  _registerApiRoutes(app);
  app.get('/api/health', async () => ({ status: 'ok', time: new Date().toISOString() }));
}

async function _registerProxyRoutes(app: FastifyInstance): Promise<void> {
  // 动态路由：/* 匹配所有非 /api 路径
  // 策略 1：URL 首段为已知 provider（如 /anthropic/v1/messages）→ 剥离首段后转发
  // 策略 2：URL 直接为 API 路径（如 /v1/messages）→ 从端点模式反推 provider，完整路径转发
  app.route({
    method: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    url: '/*',
    handler: async (request, reply) => {
      const hasBody = request.body != null;
      if (hasBody) {
        const model = (request.body as any)?.model || '?';
        console.log(`[proxy] ▶ model=${model} stream=${(request.body as any)?.stream ?? false}`);
      }
      const rawPath = (request.params as any)['*'] || '';
      if (!rawPath || rawPath === '/') {
        return reply.status(404).send('Not found');
      }

      const segments = rawPath.split('/').filter(Boolean);
      let provider = segments[0];
      let remaining = '';
      let tool = 'unknown';
      let providerConfig: ReturnType<typeof getProviderConfig>;

      // 非 API 路径 → 尝试识别 provider
      if (!provider || provider === 'api') {
        return reply.callNotFound();
      }

      providerConfig = getProviderConfig(provider);
      if (providerConfig) {
        // 策略 1：首段是已知供应商，剥离首段后转发
        provider = providerConfig.provider; // 规范化为配置名 e.g. 'anthropic'→'Anthropic'
        remaining = segments.slice(1).join('/') || '';
        const fmt = providerConfig.api_format || provider.toLowerCase();
        tool = fmt === 'anthropic' ? 'ClaudeCode' : fmt === 'openai' ? 'codex' : provider;
      } else {
        // 策略 2：首段不是已知供应商，从端点反推下游工具类型 → 使用默认上游
        const detected = detectFromPath(rawPath);
        if (detected) {
          provider = detected.upstream;
          tool = detected.tool;
          remaining = rawPath;
          providerConfig = getProviderConfig(provider);
          if (providerConfig) provider = providerConfig.provider;
        }
        if (!providerConfig) {
          reply.callNotFound();
          return;
        }
      }
      // provider 已统一规范化为配置名，后续指纹、会话、CallRecord 均使用统一名称

      if (!providerConfig.enabled) {
        return reply.status(503).send({ error: `Provider "${provider}" 已禁用` });
      }

      // 标准化端点路径：策略1 时 rawPath 首段是已知供应商（路径已含前缀），
      // 策略2 时 rawPath 首段不是供应商（如 v1/messages），需补上前缀
      const hasProviderPrefix = getProviderConfig(segments[0]) != null;
      const endpoint = hasProviderPrefix ? `/${rawPath}` : `/${provider}/${rawPath}`;

      // 提取请求头（用于转发）
      const reqHeaders = cleanHeaders(request.headers as any);
      const sourcePort = request.socket.remotePort || 0;
      const sourceIp = request.socket.remoteAddress || '127.0.0.1';
      const downstreamUrl = `http://${request.hostname || 'localhost'}:${PORT}${request.url}`;
      const bodyObj = (request.body ?? {}) as Record<string, any>;

      // 基于会话种子（首条消息）的会话识别：
      // 同一聊天 → 相同种子 → 同一会话；不同聊天 → 不同种子 → 不同会话
      // 若有 pending 会话 → 自动升级为 active
      const fp = computeFingerprint(provider, extractConversationSeed(bodyObj));
      const sessionId = getOrCreateSession(provider, endpoint, bodyObj, tool);
      const reqId = randomUUID().slice(0, 8);
      const t0 = performance.now();

      // 诊断日志 — 下游请求详情
      let model = bodyObj?.model || '?';
      const isStream = bodyObj?.stream === true;

      // 会话级上游覆盖：provider + model
      let upstreamProvider = provider;
      try {
        const session = getSession(sessionId);
        if (session?.upstream_provider) {
          upstreamProvider = session.upstream_provider;
          // model 覆写仅在指定了上游供应商时才生效
          if (session?.upstream_model && request.body != null) {
            bodyObj.model = session.upstream_model;
            request.body = bodyObj;
            model = session.upstream_model;
          }
        }
      } catch {}
      // provider 记录实际转发目标，非原始路径识别值
      const effectiveProvider = upstreamProvider;

      console.log(`[proxy] ▶ ${request.method} ${downstreamUrl}`);
      console.log(`         provider=${effectiveProvider} tool=${tool} model=${model} session=${sessionId} req=${reqId}`);

      const config = getConfiguredUpstream(upstreamProvider, `/${remaining}`);
      const upstream = config.base_url;
      // 验证上游 URL 有效
      if (!upstream || !upstream.startsWith('http')) {
        return reply.status(500).send({ error: `Provider "${upstreamProvider}" 未配置有效的 Base URL` });
      }
      const targetUrl = remaining ? `${upstream}/${remaining}` : upstream;

      if (config.api_key && config.api_key.startsWith('sk-')) {
        reqHeaders['authorization'] = `Bearer ${config.api_key}`;
      }

      const body = request.body ? Buffer.from(JSON.stringify(request.body)) : undefined;

      if (isStream) {
        const { stream, collectResult } = await forwardStream(request.method, targetUrl, reqHeaders, body);
        collectResult().then(result => {
          if (_enqueueRef) {
            _enqueueRef({
              provider: effectiveProvider, model, endpoint, method: request.method,
              target_url: targetUrl, downstream_url: downstreamUrl, source_ip: sourceIp,
              status_code: result.status, error_message: result.status >= 400 ? result.text.slice(0, 200) : null,
              duration_ms: result.durationMs, request_body: body?.toString('utf-8') || null, response_body: result.text,
              fingerprint: fp, source_port: sourcePort, session_id: sessionId,
              prompt_tokens: null, output_tokens: null, cache_read_tokens: null, cache_write_tokens: null, uncached_input: null,
              input_cost: 0, output_cost: 0, total_cost: 0, cache_savings: 0,
            });
          }
        });
        console.log(`[proxy] ◀ stream 已建立 | ${(performance.now() - t0).toFixed(0)}ms req=${reqId}`);
        return reply.type('text/event-stream').send(stream);
      } else {
        const result = await forwardRequest(request.method, targetUrl, reqHeaders, body);
        if (_enqueueRef) {
          _enqueueRef({
            provider: effectiveProvider, model, endpoint, method: request.method,
            target_url: targetUrl, downstream_url: downstreamUrl, source_ip: sourceIp,
            status_code: result.status, error_message: result.status >= 400 ? result.text.slice(0, 200) : null,
            duration_ms: result.durationMs, request_body: body?.toString('utf-8') || null, response_body: result.text,
            fingerprint: fp, source_port: sourcePort, session_id: sessionId,
            prompt_tokens: null, output_tokens: null, cache_read_tokens: null, cache_write_tokens: null, uncached_input: null,
            input_cost: 0, output_cost: 0, total_cost: 0, cache_savings: 0,
          });
        }
        console.log(`[proxy] ◀ status=${result.status} | ${(performance.now() - t0).toFixed(0)}ms req=${reqId}`);
        return reply.status(result.status).header('content-type', 'application/json').send(result.text);
      }
    },
  });
}

// ── /api/* 查询路由 ──

function _registerApiRoutes(app: FastifyInstance): void {
  // Sessions
  app.get('/api/sessions', async (req) => {
    const q = req.query as any;
    return listSessions(q?.tool, q?.status, q?.limit ? parseInt(q.limit) : 100);
  });
  app.get('/api/sessions/:id', async (req, reply) => {
    const s = getSession(parseInt((req.params as any).id));
    return s || reply.status(404).send('Not found');
  });
  app.put('/api/sessions/:id/label', async (req) => {
    updateSessionLabel(parseInt((req.params as any).id), (req.body as any).label);
    return { ok: true };
  });
  app.put('/api/sessions/:id/upstream', async (req) => {
    const { upstream_provider } = req.body as any;
    updateSessionUpstream(parseInt((req.params as any).id), upstream_provider || null);
    return { ok: true };
  });
  app.put('/api/sessions/:id/model', async (req) => {
    const { model } = req.body as any;
    updateSessionModel(parseInt((req.params as any).id), model || null);
    return { ok: true };
  });
  app.post('/api/sessions/merge', async (req) => {
    const { source_id, target_id } = req.body as any;
    mergeSessions(source_id, target_id);
    return { ok: true };
  });

  // 启动通知：CLI 包装脚本在启动工具前调用，预创建 pending 会话
  app.post('/api/sessions/start', async (req, reply) => {
    const { tool } = req.body as any;
    if (!tool) return reply.status(400).send({ error: 'tool 参数必填' });
    const id = createPendingSession(tool);
    return { id, tool, status: 'pending' };
  });

  // Calls
  app.get('/api/calls', async (req) => {
    const q = req.query as any;
    return dbListCalls(
      q?.session_id ? parseInt(q.session_id) : undefined,
      q?.provider || undefined,
      q?.tool || undefined,
      q?.limit ? parseInt(q.limit) : 50,
      q?.offset ? parseInt(q.offset) : 0,
    );
  });
  app.get('/api/calls/:id', async (req, reply) => {
    const c = dbGetCall(parseInt((req.params as any).id));
    return c || reply.status(404).send('Not found');
  });

  // Stats
  app.get('/api/stats', async (req) => {
    const q = req.query as any;
    return getStats(q?.group_by || 'provider', q?.provider || undefined, q?.tool || undefined);
  });

  // Pricing
  app.get('/api/pricing', async () => listPricing());
  app.post('/api/pricing', async (req) => {
    const { provider, model, input_price, cache_input_price, output_price, currency } = req.body as any;
    const id = upsertPricing(provider, model, input_price, cache_input_price, output_price, currency || 'CNY');
    return { id };
  });
  app.delete('/api/pricing/:id', async (req, reply) => {
    const result = deletePricing(parseInt((req.params as any).id));
    if (!result.ok) return reply.status(400).send(result);
    return result;
  });
  app.post('/api/pricing/default', async () => {
    const file = join(__dirname, 'data', 'default-pricing.json');
    const data = JSON.parse(readFileSync(file, 'utf-8'));
    let count = 0;
    for (const item of data) {
      upsertPricing(item.provider, item.model, item.input_price, item.cache_input_price, item.output_price, item.currency || 'CNY', true);
      count++;
    }
    return { imported: count };
  });

  // Data management
  app.post('/api/data/clear', async () => {
    clearAllData();
    initDefaultProviders();
    // 重新导入默认定价
    const pricingFile = join(__dirname, 'data', 'default-pricing.json');
    const data = JSON.parse(readFileSync(pricingFile, 'utf-8'));
    for (const item of data) {
      upsertPricing(item.provider, item.model, item.input_price, item.cache_input_price, item.output_price, item.currency || 'CNY', true);
    }
    return { ok: true };
  });
  app.post('/api/data/cleanup', async (req) => {
    const count = cleanupOldCalls((req.body as any).days);
    return { deleted: count };
  });

  // Provider Config
  app.get('/api/providers', async () => listProviderConfigs());
  app.put('/api/providers/:provider', async (req, reply) => {
    const data = req.body as any;
    const result = updateProviderConfig((req.params as any).provider, data);
    if (!result.ok) return reply.status(400).send(result);
    return result;
  });
  app.post('/api/providers', async (req, reply) => {
    const { provider, base_url, base_url_anthropic, api_key, api_format } = req.body as any;
    if (!provider) return reply.status(400).send({ error: 'provider name required' });
    const id = addProviderConfig(provider, base_url || '', base_url_anthropic || '', api_key || '', api_format || '');
    return { id };
  });
  app.delete('/api/providers/:provider', async (req, reply) => {
    const result = deleteProviderConfig((req.params as any).provider);
    if (!result.ok) return reply.status(400).send(result);
    return result;
  });

  // Config
  app.get('/api/config', async () => ({
    port: PORT, data_dir: DATA_DIR,
    session_timeout_sec: SESSION_TIMEOUT_SEC,
    auto_cleanup_days: AUTO_CLEANUP_DAYS,
    currency: getSetting('currency') || 'CNY',
    rates: getRates(),
    rates_updated_at: getRatesUpdatedAt(),
  }));
  app.put('/api/config', async (req) => {
    const { currency } = req.body as any;
    if (currency) setSetting('currency', currency);
    return { ok: true };
  });

  // Rates
  app.post('/api/rates/refresh', async () => {
    try {
      const result = await refreshRates();
      return { ok: true, ...result };
    } catch (err: any) {
      return { ok: false, error: err?.message || '刷新失败', rates: getRates(), rates_updated_at: getRatesUpdatedAt() || null };
    }
  });
}
