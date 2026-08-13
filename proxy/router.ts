/** 路由注册 — 代理路由 + /api/* 查询路由 */
import type { FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { forwardRequest, forwardStream } from './forwarder.js';
import { needsConversion, convertRequest, convertResponse, createResponseTransform } from './converter.js';
import { extractThinking } from '../shared/extractThinking.js';
import { formatThinkingFull } from './thinking-preview.js';
import { detectFormatFromUrl, detectFormatFromTool } from './normalizer.js';
import { getOrCreateSession, computeFingerprint, extractConversationSeed } from './session.js';
import { randomUUID } from 'node:crypto';
import {
  listSessions, getSession, updateSessionLabel, updateSessionUpstream, updateSessionModel, mergeSessions, createPendingSession, deleteSession,
  listToolConfigs, getToolConfig, updateToolConfig, normalizeToolName,
  listCalls as dbListCalls, countCalls as dbCountCalls, getCall as dbGetCall, getSessionTokenStats, getStats, getDailyStats,
  listPricing, upsertPricing, deletePricing,
  clearAllData, initDefaultProviders, cleanupOldCalls,
  deleteAllThirdPartyProviders, deleteAllSessions,
  listProviderConfigs, updateProviderConfig, getProviderConfig,
  addProviderConfig, deleteProviderConfig, getSetting, setSetting,
} from './db.js';
import { PORT, DATA_DIR, SESSION_TIMEOUT_SEC, AUTO_CLEANUP_DAYS, debugLog } from './config.js';
import { getRates, getRatesUpdatedAt, refreshRates } from './rates.js';
import type { CallRecord } from '../shared/types.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

/** 上游 URL 映射（测试时可替换为 mock server 地址） */
export const UPSTREAMS: Record<string, string> = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com',
};

/** 从 provider_config 表加载上游配置 */
export function getConfiguredUpstream(provider: string, tool?: string, endpoint?: string): { base_url: string; api_key: string; enabled: boolean } {
  const config = getProviderConfig(provider);
  if (!config) {
    return { base_url: UPSTREAMS[provider] || '', api_key: '', enabled: true };
  }
  if (!config.enabled) {
    return { base_url: '', api_key: '', enabled: false };
  }
  // 根据工具类型选择 URL：claudecode → Anthropic 格式 → base_url_anthropic，codex → OpenAI 格式 → base_url
  const isAnthropicTool = tool === 'claudecode';
  const url = isAnthropicTool && config.base_url_anthropic ? config.base_url_anthropic : config.base_url;
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

/** 创建 SSE 流中替换上游 model 为下游 model 的 TransformStream */
function createModelReplaceTransform(upstreamModel: string, downstreamModel: string): TransformStream<Uint8Array, Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  return new TransformStream({
    transform(chunk, controller) {
      const text = decoder.decode(chunk, { stream: true });
      // 直接替换 model 字符串（SSE 中 model 只出现在 JSON 的 "model" 字段中，不会误伤正文）
      const replaced = text.replaceAll(upstreamModel, downstreamModel);
      controller.enqueue(encoder.encode(replaced));
    },
  });
}

/** 非流式 JSON 响应中替换 model 字段 */
function replaceModelInJson(text: string, from: string, to: string): string {
  try {
    const obj = JSON.parse(text);
    // 遍历常见 model 字段位置
    if (obj.model && obj.model === from) obj.model = to;
    if (obj.response?.model && obj.response.model === from) obj.response.model = to;
    return JSON.stringify(obj);
  } catch {
    // 非 JSON → 直接字符串替换
    return text.replaceAll(from, to);
  }
}

export async function registerProxyRoutes(app: FastifyInstance): Promise<void> {
  await _registerProxyRoutes(app);
}

/** 注册 API 查询路由（供面板端口单独挂载） */
export function registerApiRoutes(app: FastifyInstance): void {
  _registerApiRoutes(app);
  app.get('/proxy/health', async () => ({ status: 'ok', time: new Date().toISOString() }));
}

async function _registerProxyRoutes(app: FastifyInstance): Promise<void> {
  // 启动通知：CLI 包装脚本在启动工具前调用，预创建 pending 会话
  app.post('/proxy/sessions/start', async (req, reply) => {
    const { tool } = req.body as any;
    if (!tool) return reply.status(400).send({ error: 'tool 参数必填' });
    const name = normalizeToolName(tool);
    const id = createPendingSession(name);
    return { id, tool: name, status: 'pending' };
  });

  // 动态路由：/* 匹配所有非 /api 路径
  // URL 首段为工具名（如 /codex、/claudecode）→ 映射到供应商 → 剥离首段后转发
  // 无 provider 前缀的请求直接 404
  app.route({
    method: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    url: '/*',
    handler: async (request, reply) => {
      let rawPath = (request.params as any)['*'] || '';
      if (!rawPath || rawPath === '/') {
        return reply.status(404).send('Not found');
      }

      // 检测 URL 路径嵌入 /s/<sessionId>/ 前缀 → 直接使用已知会话
      let knownSessionId: number | undefined;
      const sessionPrefixMatch = rawPath.match(/^s\/(\d+)\/(.+)/);
      if (sessionPrefixMatch) {
        knownSessionId = parseInt(sessionPrefixMatch[1]);
        rawPath = sessionPrefixMatch[2]; // 剥离 /s/<id>/ 前缀
      }
      const hasBody = request.body != null;
      const remotePort = request.socket.remotePort || 0;
      const bodyModel = hasBody ? (request.body as any)?.model || '?' : null;
      const bodyStream = hasBody ? (request.body as any)?.stream ?? false : null;
      if (hasBody) {
        debugLog(`[proxy] ▶ ${request.url} model=${bodyModel} stream=${bodyStream} port=${remotePort}`);
      } else {
        debugLog(`[proxy] ▶ ${request.url} (no body) port=${remotePort}`);
      }

      const segments = rawPath.split('/').filter(Boolean);
      let provider = segments[0];
      let remaining = '';
      let tool = 'unknown';
      let providerConfig: ReturnType<typeof getProviderConfig>;
      let hasProviderPrefix = false;

      // 非 API 路径 → 尝试识别
      if (!provider || provider === 'api') {
        return reply.callNotFound();
      }

      // 首段作为工具名匹配（大小写不敏感），再映射到供应商
      const rawTool = segments[0];
      const canonicalTool = normalizeToolName(rawTool);
      const toolConfig = getToolConfig(canonicalTool);

      // 向后兼容旧格式 /anthropic → claudecode，/openai → codex
      const lowerRaw = rawTool.toLowerCase();
      // 内置工具即使无 tool_config 行也走默认供应商映射（全新安装可直接使用）
      const isBuiltinTool = canonicalTool === 'claudecode' || canonicalTool === 'codex';
      providerConfig = getProviderConfig(provider);
      if (!toolConfig && (lowerRaw === 'anthropic' || lowerRaw === 'openai')) {
        const compatTool = lowerRaw === 'anthropic' ? 'claudecode' : 'codex';
        tool = compatTool;
        provider = lowerRaw === 'anthropic' ? 'anthropic' : 'openai';
        providerConfig = getProviderConfig(provider);
        hasProviderPrefix = true;
        remaining = segments.slice(1).join('/') || '';
      } else if (toolConfig || (isBuiltinTool && !providerConfig)) {
        // 策略 1：首段匹配已知工具名 → 映射到该工具的默认上游供应商
        // 内置工具无 tool_config 行且存在同名供应商时让位于供应商路径（策略 2），避免自定义同名供应商被遮蔽；
        // 有 tool_config 行时工具路径仍优先（显式配置视为用户意图）
        hasProviderPrefix = true;
        tool = canonicalTool;
        const upstream = toolConfig?.upstream_provider
          || (tool === 'claudecode' ? 'anthropic' : tool === 'codex' ? 'openai' : 'unknown');
        provider = upstream;
        providerConfig = getProviderConfig(upstream);
        remaining = segments.slice(1).join('/') || '';
      } else if (providerConfig) {
        // 策略 2：首段是供应商名（向后兼容其他自定义供应商路径）
        hasProviderPrefix = true;
        provider = providerConfig.provider;
        tool = provider === 'anthropic' ? 'claudecode' : provider === 'openai' ? 'codex' : provider;
        remaining = segments.slice(1).join('/') || '';
      } else {
        return reply.status(400).send({
          error: `无法识别的路径前缀 "/${segments[0]}"`,
          hint: `URL 应以工具名开头，如 /codex${rawPath} 或 /claudecode${rawPath}`,
        });
      }

      if (!providerConfig) {
        return reply.status(503).send({ error: `上游供应商 "${provider}" 未配置，请在面板中添加` });
      }
      if (!providerConfig.enabled) {
        return reply.status(503).send({ error: `Provider "${provider}" 已禁用` });
      }

      // 标准化端点路径：策略1 时 rawPath 首段是已知供应商（路径已含前缀），
      // 策略2 时 rawPath 首段不是供应商（如 v1/messages），需补上前缀
      const endpoint = hasProviderPrefix ? `/${rawPath}` : `/${provider}/${rawPath}`;

      // 提取请求头（用于转发）
      const reqHeaders = cleanHeaders(request.headers as any);
      const sourceIp = request.socket.remoteAddress || '127.0.0.1';
      const downstreamUrl = `http://${request.hostname || 'localhost'}:${PORT}${request.url}`;
      const bodyObjRaw = request.body ?? {};
      // Fastify 在 application/json 时自动解析，非 JSON content-type 时 body 可能已是字符串
      let bodyObj = (typeof bodyObjRaw === 'object' && bodyObjRaw !== null ? bodyObjRaw : {}) as Record<string, any>;

      // 基于会话种子的会话识别（URL 嵌入 /s/<id>/ 时优先使用已知 ID）
      // 同一聊天 → 相同种子 → 同一会话；不同聊天 → 不同种子 → 不同会话
      // 若有 pending 会话 → 自动升级为 active
      const fp = knownSessionId
        ? `url-session:${knownSessionId}`
        : computeFingerprint(provider, extractConversationSeed(bodyObj));
      const sessionId = getOrCreateSession(provider, endpoint, bodyObj, tool, knownSessionId);
      const reqId = randomUUID().slice(0, 8);
      const t0 = performance.now();

      // 诊断日志 — 下游请求详情
      const downstreamModel = bodyObj?.model || '?';  // 下游工具原始请求的 model（应答时需还原）
      let model = downstreamModel;
      const isStream = bodyObj?.stream === true;

      // 上游覆盖优先级：会话 > 工具 > URL 路径默认
      // 供应商名统一取 provider_config 中的规范名（大小写不敏感）
      const canonicalProvider = (name: string) => getProviderConfig(name)?.provider || name;
      let upstreamProvider = provider;
      try {
        const session = getSession(sessionId);
        if (session?.upstream_provider) {
          upstreamProvider = canonicalProvider(session.upstream_provider);
          if (session?.upstream_model && request.body != null) {
            bodyObj.model = session.upstream_model;
            request.body = bodyObj;
            model = session.upstream_model;
          }
        } else {
          // 会话未设 → 回退到工具级配置
          const tc = getToolConfig(tool);
          if (tc?.upstream_provider) {
            upstreamProvider = canonicalProvider(tc.upstream_provider);
            if (tc.upstream_model && request.body != null) {
              bodyObj.model = tc.upstream_model;
              request.body = bodyObj;
              model = tc.upstream_model;
            }
          }
        }
      } catch (e: any) {
        // 异常诊断日志不受 debug 开关控制：覆盖失败意味着请求可能发往错误的上游
        console.warn(`[proxy] ⚠ 上游覆盖失败: ${e?.message || e}`);
      }
      // provider 记录实际转发目标，非原始路径识别值
      const effectiveProvider = upstreamProvider;

      // 先获取上游 URL 用于格式检测
      let config = getConfiguredUpstream(upstreamProvider, tool, `/${remaining}`);
      let upstream = config.base_url;

      // 格式转换检测：源格式由工具推断，目标格式由上游 base_url 推断
      const sourceFormat = detectFormatFromTool(tool);
      const targetFormat = detectFormatFromUrl(upstream);
      const convert = needsConversion(sourceFormat, targetFormat);

      let actualRemaining = remaining;
      if (convert && hasBody) {
        const converted = convertRequest(JSON.stringify(bodyObj), sourceFormat, targetFormat);
        bodyObj = JSON.parse(converted.body);
        request.body = bodyObj;
        model = bodyObj.model || model;
        actualRemaining = converted.path.replace(/^\//, '');
        debugLog(`[proxy] 🔄 格式转换: ${sourceFormat} → ${targetFormat} | 路径: ${remaining} → ${actualRemaining}`);
        // 转换后路径已变，重新获取上游 URL
        config = getConfiguredUpstream(upstreamProvider, tool, `/${actualRemaining}`);
        upstream = config.base_url;
      }

/** 智能拼接 base URL 与路径，避免重复段（如 /v1/v1/） */
function joinUrlPath(base: string, path: string): string {
  const cleanBase = base.replace(/\/+$/, '');
  const cleanPath = path.replace(/^\/+/, '');
  if (!cleanPath) return cleanBase;
  const baseParts = cleanBase.split('/');
  const pathParts = cleanPath.split('/');
  if (baseParts.length > 0 && pathParts.length > 0 &&
      baseParts[baseParts.length - 1] === pathParts[0]) {
    return `${cleanBase}/${pathParts.slice(1).join('/')}`;
  }
  return `${cleanBase}/${cleanPath}`;
}

      // 验证上游 URL 有效
      if (!upstream || !upstream.startsWith('http')) {
        return reply.status(500).send({ error: `Provider "${upstreamProvider}" 未配置有效的 Base URL` });
      }
      const targetUrl = actualRemaining ? joinUrlPath(upstream, actualRemaining) : upstream;

      debugLog(`[proxy] ▶ ${request.method} ${targetUrl} | provider=${effectiveProvider} tool=${tool} model=${model} session=${sessionId} req=${reqId}`);

      // 覆盖 CLI 工具的伪 token：只要面板配置了 key（不限于 sk- 前缀，兼容智谱 GLM 等格式）就注入
      if (config.api_key) {
        reqHeaders['authorization'] = `Bearer ${config.api_key}`;
      }

      // 非 JSON body 时 request.body 可能已是字符串，先检查类型再序列化（避免双重序列化）
      const rawBody = request.body ?? undefined;
      const body = rawBody != null
        ? Buffer.from(typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody))
        : undefined;

      if (isStream) {
        const { stream, collectResult } = await forwardStream(request.method, targetUrl, reqHeaders, body);
        collectResult().then(result => {
          if (_enqueueRef) {
            _enqueueRef({
              provider: effectiveProvider, model, tool, endpoint, method: request.method,
              target_url: targetUrl, downstream_url: downstreamUrl, source_ip: sourceIp,
              status_code: result.status, error_message: result.status >= 400 ? result.text.slice(0, 200) : null,
              duration_ms: result.durationMs, request_body: body?.toString('utf-8') || null, response_body: result.text,
              fingerprint: fp, source_port: remotePort, session_id: sessionId,
              prompt_tokens: null, output_tokens: null, cache_read_tokens: null, cache_write_tokens: null, uncached_input: null,
              input_cost: 0, output_cost: 0, total_cost: 0, cache_savings: 0,
            });
          }
          // 终端实时输出思考过程（result.text 为干净结构 JSON，含 thinking 字段）
          const thinking = extractThinking(result.text);
          if (thinking) console.log(formatThinkingFull(thinking));
        });
        debugLog(`[proxy] ◀ stream 已建立 | ${(performance.now() - t0).toFixed(0)}ms req=${reqId}`);
        let responseStream = stream;
        if (convert) {
          responseStream = stream.pipeThrough(createResponseTransform(targetFormat, sourceFormat));
        }
        // 上游 model 与下游不一致时，应答中还原为下游工具请求的 model
        if (model !== downstreamModel) {
          debugLog(`[proxy] 🔄 应答 model 还原: ${model} → ${downstreamModel} req=${reqId}`);
          responseStream = responseStream.pipeThrough(createModelReplaceTransform(model, downstreamModel));
        }
        return reply.type('text/event-stream').send(responseStream);
      } else {
        const result = await forwardRequest(request.method, targetUrl, reqHeaders, body);
        let responseText = convert ? convertResponse(result.text, targetFormat, sourceFormat) : result.text;
        // 上游 model 与下游不一致时，应答中还原为下游工具请求的 model
        if (model !== downstreamModel) {
          debugLog(`[proxy] 🔄 应答 model 还原: ${model} → ${downstreamModel} req=${reqId}`);
          responseText = replaceModelInJson(responseText, model, downstreamModel);
        }
        if (_enqueueRef) {
          _enqueueRef({
            provider: effectiveProvider, model, tool, endpoint, method: request.method,
            target_url: targetUrl, downstream_url: downstreamUrl, source_ip: sourceIp,
            status_code: result.status, error_message: result.status >= 400 ? result.text.slice(0, 200) : null,
            duration_ms: result.durationMs, request_body: body?.toString('utf-8') || null, response_body: result.text,
            fingerprint: fp, source_port: remotePort, session_id: sessionId,
            prompt_tokens: null, output_tokens: null, cache_read_tokens: null, cache_write_tokens: null, uncached_input: null,
            input_cost: 0, output_cost: 0, total_cost: 0, cache_savings: 0,
          });
        }
        const thinking = extractThinking(result.text);
        if (thinking) console.log(formatThinkingFull(thinking));
        debugLog(`[proxy] ◀ status=${result.status} | ${(performance.now() - t0).toFixed(0)}ms req=${reqId}`);
        return reply.status(result.status).header('content-type', 'application/json').send(responseText);
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
  app.get('/api/sessions/:id/token-stats', async (req) => {
    return getSessionTokenStats(parseInt((req.params as any).id));
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
  app.delete('/api/sessions/:id', async (req) => {
    deleteSession(parseInt((req.params as any).id));
    return { ok: true };
  });

  // Tool Config
  app.get('/api/tool-configs', async () => listToolConfigs());
  app.put('/api/tool-configs/:tool', async (req) => {
    const { upstream_provider, upstream_model } = req.body as any;
    updateToolConfig((req.params as any).tool, upstream_provider || null, upstream_model || null);
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
  app.get('/api/calls/count', async (req) => {
    const q = req.query as any;
    return { count: dbCountCalls(
      q?.session_id ? parseInt(q.session_id) : undefined,
      q?.provider || undefined,
      q?.tool || undefined,
    ) };
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

  app.get('/api/stats/daily', async (req, reply) => {
    const q = req.query as any;
    // 向后兼容旧参数 group_by_model=1 → group_by=model
    const groupBy = q?.group_by || (q?.group_by_model === '1' ? 'model' : undefined);
    if (groupBy && !['tool', 'provider', 'model'].includes(groupBy)) {
      return reply.status(400).send({ error: `非法 group_by: ${groupBy}（可选 tool / provider / model）` });
    }
    return getDailyStats(
      q?.range || '30d',
      q?.provider || undefined,
      q?.tool || undefined,
      groupBy,
      q?.tz ? parseInt(q.tz) : 8,
    );
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
  app.post('/api/data/clear-providers', async () => {
    const count = deleteAllThirdPartyProviders();
    return { deleted: count };
  });
  app.post('/api/data/clear-sessions', async () => {
    const count = deleteAllSessions();
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
    const { provider, base_url, base_url_anthropic, api_key } = req.body as any;
    if (!provider) return reply.status(400).send({ error: 'provider name required' });
    try {
      const id = addProviderConfig(provider, base_url || '', base_url_anthropic || '', api_key || '');
      return { id };
    } catch (err) {
      return reply.status(400).send({ error: (err as Error).message });
    }
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
