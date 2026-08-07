import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { forwardRequest, forwardStream } from './forwarder.js';
import { getOrCreateSession, computeFingerprint } from './session.js';
import { listSessions, getSession, updateSessionLabel, mergeSessions, listCalls as dbListCalls, getCall as dbGetCall, getStats, listPricing, upsertPricing, deletePricing, clearAllCalls, cleanupOldCalls, listProviderConfigs, updateProviderConfig, getProviderConfig, addProviderConfig, deleteProviderConfig, } from './db.js';
import { PORT, DATA_DIR, SESSION_TIMEOUT_SEC, AUTO_CLEANUP_DAYS } from './config.js';
const __dirname = fileURLToPath(new URL('.', import.meta.url));
/** 上游 URL 映射（测试时可替换为 mock server 地址） */
export const UPSTREAMS = {
    anthropic: 'https://api.anthropic.com',
    openai: 'https://api.openai.com',
    deepseek: 'https://api.deepseek.com',
    qwen: 'https://dashscope.aliyuncs.com',
};
/** 从 provider_config 表加载上游配置 */
export function getConfiguredUpstream(provider) {
    const config = getProviderConfig(provider);
    if (!config || !config.enabled) {
        return { base_url: UPSTREAMS[provider] || '', api_key: '', enabled: config?.enabled ?? true };
    }
    return config;
}
function cleanHeaders(headers) {
    const skip = new Set(['host', 'transfer-encoding', 'connection', 'content-length', 'content-encoding']);
    const result = {};
    for (const [k, v] of Object.entries(headers)) {
        if (!skip.has(k.toLowerCase()) && typeof v === 'string') {
            result[k] = v;
        }
    }
    return result;
}
/** recorder 入队函数引用（在 Task 10 中设置为实际实现） */
let _enqueueRef = null;
export function setEnqueueRef(fn) {
    _enqueueRef = fn;
}
export async function registerProxyRoutes(app) {
    // 注册代理路由 + 查询 API
    await _registerProxyRoutes(app);
    _registerApiRoutes(app);
}
async function _registerProxyRoutes(app) {
    // 动态路由：/* 匹配所有非 /api 路径，按第一段路径识别 provider
    app.route({
        method: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
        url: '/*',
        handler: async (request, reply) => {
            const rawPath = request.params['*'] || '';
            if (!rawPath || rawPath === '/') {
                return reply.status(404).send('Not found');
            }
            const segments = rawPath.split('/').filter(Boolean);
            const provider = segments[0];
            if (!provider || provider === 'api') {
                return reply.status(404).send('Not found');
            }
            const remaining = segments.slice(1).join('/') || '';
            const sourcePort = request.socket.remotePort || 0;
            const authHeader = request.headers.authorization || null;
            const sessionId = getOrCreateSession(provider, sourcePort, authHeader, `/${remaining}`);
            const config = getConfiguredUpstream(provider);
            if (!config || !config.enabled) {
                return reply.status(503).send({ error: `Provider "${provider}" 不存在或已禁用` });
            }
            const upstream = config.base_url;
            // 验证上游 URL 有效
            if (!upstream || !upstream.startsWith('http')) {
                return reply.status(500).send({ error: `Provider "${provider}" 未配置有效的 Base URL` });
            }
            const targetUrl = remaining ? `${upstream}/${remaining}` : upstream;
            const reqHeaders = cleanHeaders(request.headers);
            if (config.api_key && config.api_key.startsWith('sk-')) {
                reqHeaders['authorization'] = `Bearer ${config.api_key}`;
            }
            const body = request.body ? Buffer.from(JSON.stringify(request.body)) : undefined;
            const isStream = request.body?.stream === true;
            let model = 'unknown';
            try {
                model = request.body?.model || 'unknown';
            }
            catch { }
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
            }
            else {
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
function _registerApiRoutes(app) {
    // Sessions
    app.get('/api/sessions', async (req) => {
        const q = req.query;
        return listSessions(q?.tool, q?.status, q?.limit ? parseInt(q.limit) : 100);
    });
    app.get('/api/sessions/:id', async (req, reply) => {
        const s = getSession(parseInt(req.params.id));
        return s || reply.status(404).send('Not found');
    });
    app.put('/api/sessions/:id/label', async (req) => {
        updateSessionLabel(parseInt(req.params.id), req.body.label);
        return { ok: true };
    });
    app.post('/api/sessions/merge', async (req) => {
        const { source_id, target_id } = req.body;
        mergeSessions(source_id, target_id);
        return { ok: true };
    });
    // Calls
    app.get('/api/calls', async (req) => {
        const q = req.query;
        return dbListCalls(q?.session_id ? parseInt(q.session_id) : undefined, q?.limit ? parseInt(q.limit) : 50, q?.offset ? parseInt(q.offset) : 0);
    });
    app.get('/api/calls/:id', async (req, reply) => {
        const c = dbGetCall(parseInt(req.params.id));
        return c || reply.status(404).send('Not found');
    });
    // Stats
    app.get('/api/stats', async (req) => {
        const q = req.query;
        return getStats(q?.group_by || 'provider');
    });
    // Pricing
    app.get('/api/pricing', async () => listPricing());
    app.post('/api/pricing', async (req) => {
        const { provider, model, input_price, cache_input_price, output_price } = req.body;
        const id = upsertPricing(provider, model, input_price, cache_input_price, output_price);
        return { id };
    });
    app.delete('/api/pricing/:id', async (req) => {
        deletePricing(parseInt(req.params.id));
        return { ok: true };
    });
    app.post('/api/pricing/default', async () => {
        const file = join(__dirname, '..', 'data', 'default-pricing.json');
        const data = JSON.parse(readFileSync(file, 'utf-8'));
        let count = 0;
        for (const item of data) {
            upsertPricing(item.provider, item.model, item.input_price, item.cache_input_price, item.output_price);
            count++;
        }
        return { imported: count };
    });
    // Data management
    app.post('/api/data/clear', async () => { clearAllCalls(); return { ok: true }; });
    app.post('/api/data/cleanup', async (req) => {
        const count = cleanupOldCalls(req.body.days);
        return { deleted: count };
    });
    // Provider Config
    app.get('/api/providers', async () => listProviderConfigs());
    app.put('/api/providers/:provider', async (req) => {
        const { base_url, api_key, enabled } = req.body;
        updateProviderConfig(req.params.provider, base_url || '', api_key || '', enabled !== false);
        return { ok: true };
    });
    app.post('/api/providers', async (req, reply) => {
        const { provider, base_url, api_key } = req.body;
        if (!provider)
            return reply.status(400).send({ error: 'provider name required' });
        const id = addProviderConfig(provider, base_url || '', api_key || '');
        return { id };
    });
    app.delete('/api/providers/:provider', async (req) => {
        deleteProviderConfig(req.params.provider);
        return { ok: true };
    });
    // Config
    app.get('/api/config', async () => ({
        port: PORT, data_dir: DATA_DIR,
        session_timeout_sec: SESSION_TIMEOUT_SEC,
        auto_cleanup_days: AUTO_CLEANUP_DAYS,
    }));
}
//# sourceMappingURL=router.js.map