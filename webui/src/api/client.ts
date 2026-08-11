/** API 客户端 */

const BASE = '/api';

async function fetchJson(url: string, init?: RequestInit): Promise<any> {
  const hasBody = init?.body != null;
  const res = await fetch(`${BASE}${url}`, {
    headers: hasBody ? { 'Content-Type': 'application/json', ...init?.headers } : init?.headers,
    ...init,
  });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

// ── Sessions ──
export async function listSessions(tool?: string, status?: string) {
  const params = new URLSearchParams();
  if (tool) params.set('tool', tool);
  if (status) params.set('status', status);
  return fetchJson(`/sessions?${params}`);
}

export async function getSession(id: number) {
  return fetchJson(`/sessions/${id}`);
}

export async function renameSession(id: number, label: string) {
  return fetchJson(`/sessions/${id}/label`, { method: 'PUT', body: JSON.stringify({ label }) });
}

export async function mergeSessions(sourceId: number, targetId: number) {
  return fetchJson('/sessions/merge', { method: 'POST', body: JSON.stringify({ source_id: sourceId, target_id: targetId }) });
}

export async function updateSessionUpstream(id: number, upstreamProvider: string | null) {
  return fetchJson(`/sessions/${id}/upstream`, { method: 'PUT', body: JSON.stringify({ upstream_provider: upstreamProvider }) });
}

export async function updateSessionModel(id: number, model: string | null) {
  return fetchJson(`/sessions/${id}/model`, { method: 'PUT', body: JSON.stringify({ model }) });
}

export async function deleteSession(id: number) {
  return fetchJson(`/sessions/${id}`, { method: 'DELETE' });
}

// ── Tool Config ──

export async function listToolConfigs() {
  return fetchJson('/tool-configs');
}

export async function updateToolConfig(tool: string, upstreamProvider: string | null, upstreamModel: string | null) {
  return fetchJson(`/tool-configs/${tool}`, { method: 'PUT', body: JSON.stringify({ upstream_provider: upstreamProvider, upstream_model: upstreamModel }) });
}

// ── Calls ──
export async function listCalls(sessionId?: number, provider?: string, tool?: string, limit = 50, offset = 0) {
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  if (sessionId) params.set('session_id', String(sessionId));
  if (provider) params.set('provider', provider);
  if (tool) params.set('tool', tool);
  return fetchJson(`/calls?${params}`);
}

export async function getCall(id: number) {
  return fetchJson(`/calls/${id}`);
}

// ── Stats ──
export async function getStats(groupBy = 'model', provider?: string, tool?: string) {
  const params = new URLSearchParams({ group_by: groupBy });
  if (provider) params.set('provider', provider);
  if (tool) params.set('tool', tool);
  return fetchJson(`/stats?${params}`);
}

export async function getDailyStats(provider?: string, tool?: string, days = 30) {
  const params = new URLSearchParams();
  if (provider) params.set('provider', provider);
  if (tool) params.set('tool', tool);
  params.set('days', String(days));
  return fetchJson(`/stats/daily?${params}`);
}

// ── Pricing ──
export async function listPricing() {
  return fetchJson('/pricing');
}

export async function upsertPricing(p: { provider: string; model: string; input_price: number; cache_input_price: number; output_price: number; currency?: string }) {
  return fetchJson('/pricing', { method: 'POST', body: JSON.stringify(p) });
}

export async function deletePricing(id: number) {
  return fetchJson(`/pricing/${id}`, { method: 'DELETE' });
}

export async function importDefaultPricing() {
  return fetchJson('/pricing/default', { method: 'POST' });
}

// ── Data ──
export async function clearAllData() {
  return fetchJson('/data/clear', { method: 'POST' });
}

export async function clearThirdPartyProviders() {
  return fetchJson('/data/clear-providers', { method: 'POST' });
}

export async function clearAllSessions() {
  return fetchJson('/data/clear-sessions', { method: 'POST' });
}

// ── Providers ──
export async function listProviders() {
  return fetchJson('/providers');
}

export async function updateProvider(provider: string, data: { enabled?: boolean; api_key?: string; base_url?: string; base_url_anthropic?: string }) {
  return fetchJson(`/providers/${provider}`, { method: 'PUT', body: JSON.stringify(data) });
}

export async function addProvider(data: { provider: string; base_url: string; base_url_anthropic: string; api_key: string }) {
  return fetchJson('/providers', { method: 'POST', body: JSON.stringify(data) });
}

export async function deleteProvider(provider: string) {
  return fetchJson(`/providers/${provider}`, { method: 'DELETE' });
}

// ── Config ──
export async function getConfig() {
  return fetchJson('/config');
}

export async function updateConfig(data: { currency: string }) {
  return fetchJson('/config', { method: 'PUT', body: JSON.stringify(data) });
}

// ── Rates ──
export async function refreshRates() {
  return fetchJson('/rates/refresh', { method: 'POST' });
}
