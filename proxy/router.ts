/** 路由注册 — 代理路由 + /api/* 查询路由 */
import type { FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { forwardRequest, forwardStream } from './forwarder.js';
import { getOrCreateSession, computeFingerprint } from './session.js';
import {
  listSessions, getSession, updateSessionLabel, updateSessionUpstream, mergeSessions,
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

/** recorder 入队函数引用（在 Task 10 中设置为实际实现） */
let _enqueueRef: ((record: CallRecord) => void) | null = null;
export function setEnqueueRef(fn: (record: CallRecord) => void): void {
  _enqueueRef = fn;
}

export async function registerProxyRoutes(app: FastifyInstance): Promise<void> {
  // 先注册 API 路由（精确匹配优先）
  _registerApiRoutes(app);
  // 再注册通配代理路由（兜底）
  await _registerProxyRoutes(app);
}

async function _registerProxyRoutes(app: FastifyInstance): Promise<void> {
  // 动态路由：/* 匹配所有非 /api 路径，按第一段路径识别 provider
  app.route({
    method: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    url: '/*',
    handler: async (request, reply) => {
      const rawPath = (request.params as any)['*'] || '';
      if (!rawPath || rawPath === '/') {
        return reply.status(404).send('Not found');
      }

      const segments = rawPath.split('/').filter(Boolean);
      const provider = segments[0];
      // 非 API 路径且非已知 provider → 交给静态文件 / SPA
      if (!provider || provider === 'api') {
        return reply.callNotFound();
      }
      const providerConfig = getProviderConfig(provider);
      if (!providerConfig) {
        return reply.callNotFound();  // 未注册的路径 → 前端路由
      }
      if (!providerConfig.enabled) {
        return reply.status(503).send({ error: `Provider "${provider}" 已禁用` });
      }

      const remaining = segments.slice(1).join('/') || '';
      const sourcePort = request.socket.remotePort || 0;
      const authHeader = request.headers.authorization || null;
      const sessionId = getOrCreateSession(provider, sourcePort, authHeader, `/${remaining}`);

      // 会话级上游覆盖：查会话是否绑定了不同的 provider
      let upstreamProvider = provider;
      try {
        const session = getSession(sessionId);
        if (session?.upstream_provider) {
          upstreamProvider = session.upstream_provider;
        }
      } catch {}

      const config = getConfiguredUpstream(upstreamProvider, `/${remaining}`);
      const upstream = config.base_url;
      // 验证上游 URL 有效
      if (!upstream || !upstream.startsWith('http')) {
        return reply.status(500).send({ error: `Provider "${upstreamProvider}" 未配置有效的 Base URL` });
      }
      const targetUrl = remaining ? `${upstream}/${remaining}` : upstream;
      const reqHeaders = cleanHeaders(request.headers as any);

      if (config.api_key && config.api_key.startsWith('sk-')) {
        reqHeaders['authorization'] = `Bearer ${config.api_key}`;
      }

      const body = request.body ? Buffer.from(JSON.stringify(request.body)) : undefined;
      const isStream = (request.body as any)?.stream === true;

      let model = 'unknown';
      try { model = (request.body as any)?.model || 'unknown'; } catch {}

      if (isStream) {
        const { stream, collectResult } = await forwardStream(request.method, targetUrl, reqHeaders, body);
        collectResult().then(result => {
          if (_enqueueRef) {
            const fp = computeFingerprint(provider, sourcePort, authHeader);
            _enqueueRef({
              provider, model, endpoint: `/${remaining}`, method: request.method,
              status_code: result.status, error_message: result.status >= 400 ? result.text.slice(0, 200) : null,
              duration_ms: result.durationMs, request_body: body?.toString('utf-8') || null, response_body: result.text,
              fingerprint: fp, source_port: sourcePort, session_id: sessionId,
              prompt_tokens: null, output_tokens: null, cache_read_tokens: null, cache_write_tokens: null, uncached_input: null,
              input_cost: 0, output_cost: 0, total_cost: 0, cache_savings: 0,
            });
          }
        });
        return reply.type('text/event-stream').send(stream);
      } else {
        const result = await forwardRequest(request.method, targetUrl, reqHeaders, body);
        if (_enqueueRef) {
          const fp = computeFingerprint(provider, sourcePort, authHeader);
          _enqueueRef({
            provider, model, endpoint: `/${remaining}`, method: request.method,
            status_code: result.status, error_message: result.status >= 400 ? result.text.slice(0, 200) : null,
            duration_ms: result.durationMs, request_body: body?.toString('utf-8') || null, response_body: result.text,
            fingerprint: fp, source_port: sourcePort, session_id: sessionId,
            prompt_tokens: null, output_tokens: null, cache_read_tokens: null, cache_write_tokens: null, uncached_input: null,
            input_cost: 0, output_cost: 0, total_cost: 0, cache_savings: 0,
          });
        }
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
  app.post('/api/sessions/merge', async (req) => {
    const { source_id, target_id } = req.body as any;
    mergeSessions(source_id, target_id);
    return { ok: true };
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
  app.put('/api/providers/:provider', async (req) => {
    const data = req.body as any;
    updateProviderConfig((req.params as any).provider, data);
    return { ok: true };
  });
  app.post('/api/providers', async (req, reply) => {
    const { provider, base_url, base_url_anthropic, api_key, api_format } = req.body as any;
    if (!provider) return reply.status(400).send({ error: 'provider name required' });
    const id = addProviderConfig(provider, base_url || '', base_url_anthropic || '', api_key || '', api_format || '');
    return { id };
  });
  app.delete('/api/providers/:provider', async (req) => {
    deleteProviderConfig((req.params as any).provider);
    return { ok: true };
  });

  // Config
  app.get('/api/config', async () => ({
    port: PORT, data_dir: DATA_DIR,
    session_timeout_sec: SESSION_TIMEOUT_SEC,
    auto_cleanup_days: AUTO_CLEANUP_DAYS,
    currency: getSetting('currency') || 'CNY',
    rates: getRates(),
    rates_updated_at: getRatesUpdatedAt() || null,
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
      return { ok: false, error: err?.message || '刷新失败', rates: getRates(), rates_updated_at: getRatesUpdatedAt() };
    }
  });
}
