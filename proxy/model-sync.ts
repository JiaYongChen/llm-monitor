/**
 * 模型探测 + 定价自动同步 — 供应商配置（含 api_key）新增/更新后自动获取可用模型与定价
 * 仿照 rates.ts 模式：fetch + 10s 超时 + 调度；定价匹配复用 pricing-sources.ts
 */

import { getProviderConfig, upsertPricing, getSetting, setSetting, listProviderConfigs, normalizeProviderName, replaceProviderModels } from './db.js';
import { detectFormatFromUrl } from './normalizer.js';
import { fetchLiteLLMPricing, fetchModelsDevPricing, fetchAnthropicPricing, matchModelPricing, type ModelPrice } from './pricing-sources.js';

const DEFAULT_PROBE_TIMEOUT_MS = 10_000;

function probeTimeoutMs(): number {
  const v = Number(process.env.LLM_MONITOR_PROBE_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_PROBE_TIMEOUT_MS;
}

async function fetchJsonWithTimeout(url: string, init: RequestInit): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), probeTimeoutMs());
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}

/** 探测 OpenAI 兼容供应商：GET {baseUrl}/v1/models，Bearer 鉴权，返回小写模型名列表 */
export async function probeModelsOpenAI(baseUrl: string, apiKey: string): Promise<string[]> {
  const data = await fetchJsonWithTimeout(`${baseUrl.replace(/\/$/, '')}/v1/models`, {
    headers: { authorization: `Bearer ${apiKey}` },
  }) as { data?: { id?: string }[] };
  return [...new Set((data.data ?? [])
    .map(m => m.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0)
    .map(id => id.toLowerCase()))];
}

/** 探测 Anthropic 格式供应商：GET {baseUrl}/v1/models，x-api-key 鉴权，返回小写模型名列表 */
export async function probeModelsAnthropic(baseUrl: string, apiKey: string): Promise<string[]> {
  const data = await fetchJsonWithTimeout(`${baseUrl.replace(/\/$/, '')}/v1/models`, {
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
  }) as { data?: { id?: string }[] };
  return [...new Set((data.data ?? [])
    .map(m => m.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0)
    .map(id => id.toLowerCase()))];
}

// ── 同步状态（metadata 缓存，仿 rates.ts）──

export interface SyncStatus {
  updated_at: number;
  status: 'ok' | 'error' | 'no_key';
  error?: string;
  model_count: number;
  priced_count: number;
}

export interface SyncResult {
  status: 'ok' | 'error' | 'no_key';
  error?: string;
  model_count: number;
  priced_count: number;
}

/** 读取供应商最近一次同步状态（metadata modelsync_<provider>），无记录返回 null */
export function getSyncStatus(provider: string): SyncStatus | null {
  const raw = getSetting(`modelsync_${normalizeProviderName(provider)}`);
  if (!raw) return null;
  try { return JSON.parse(raw) as SyncStatus; } catch { return null; }
}

function setSyncStatus(provider: string, s: SyncStatus): void {
  setSetting(`modelsync_${normalizeProviderName(provider)}`, JSON.stringify(s));
}

/** 定价源拉取（按供应商分流 + 回落链），返回 null 表示全部源失败 */
async function fetchPricingFor(provider: string): Promise<Map<string, ModelPrice> | null> {
  if (provider === 'anthropic') {
    try { return await fetchAnthropicPricing(); }
    catch (err) { console.warn('anthropic 官方定价源失败，回落 liteLLM:', (err as Error).message); }
  }
  try {
    return await fetchLiteLLMPricing();
  } catch (err) {
    console.warn('liteLLM 定价源失败，回落 models.dev:', (err as Error).message);
    try { return await fetchModelsDevPricing(); }
    catch (err2) { console.warn('models.dev 定价源失败:', (err2 as Error).message); }
  }
  return null;
}

async function doSyncProvider(provider: string): Promise<SyncResult> {
  const config = getProviderConfig(provider);
  if (!config || !config.enabled) {
    return { status: 'error', error: '供应商不存在或已停用', model_count: 0, priced_count: 0 };
  }
  if (!config.api_key) {
    setSyncStatus(provider, { updated_at: Date.now(), status: 'no_key', model_count: 0, priced_count: 0 });
    return { status: 'no_key', model_count: 0, priced_count: 0 };
  }

  // 1. 探测（两个 base_url 都配置时两边探测合并；失败保留已有数据）
  const models = new Set<string>();
  const errors: string[] = [];
  if (config.base_url_anthropic) {
    try { (await probeModelsAnthropic(config.base_url_anthropic, config.api_key)).forEach(m => models.add(m)); }
    catch (err) { errors.push(`anthropic 端点: ${(err as Error).message}`); }
  }
  if (config.base_url) {
    try {
      const probe = detectFormatFromUrl(config.base_url) === 'anthropic' ? probeModelsAnthropic : probeModelsOpenAI;
      (await probe(config.base_url, config.api_key)).forEach(m => models.add(m));
    } catch (err) { errors.push(`openai 端点: ${(err as Error).message}`); }
  }
  if (models.size === 0 && errors.length > 0) {
    const error = errors.join('; ');
    setSyncStatus(provider, { updated_at: Date.now(), status: 'error', error, model_count: 0, priced_count: 0 });
    return { status: 'error', error, model_count: 0, priced_count: 0 };
  }

  // 2. 标记式更新 provider_models（探测失败时不会走到这里，已有数据不动）
  const now = Date.now();
  replaceProviderModels(provider, [...models], now);

  // 3. 定价匹配 + 全部覆盖写入
  const prices = await fetchPricingFor(provider);
  let priced = 0;
  if (prices && prices.size > 0) {
    for (const model of models) {
      const price = matchModelPricing(model, prices);
      if (price) {
        upsertPricing(provider, model, price.input_price, price.cache_input_price, price.output_price, 'USD');
        priced++;
      }
    }
  }

  const status: SyncStatus = { updated_at: now, status: 'ok', model_count: models.size, priced_count: priced };
  setSyncStatus(provider, status);
  return { ...status };
}

// in-flight 去重：同一供应商并发触发只跑一次
const inflight = new Map<string, Promise<SyncResult>>();

/** 同步单个供应商（并发去重；探测/定价失败不抛错，状态落 metadata） */
export function syncProvider(provider: string): Promise<SyncResult> {
  const name = normalizeProviderName(provider);
  const running = inflight.get(name);
  if (running) return running;
  const p = doSyncProvider(name).finally(() => inflight.delete(name));
  inflight.set(name, p);
  return p;
}

/** 同步全部启用供应商（逐个隔离，失败不影响其他供应商） */
export async function syncAllProviders(): Promise<void> {
  const providers = listProviderConfigs() as any[];
  for (const p of providers) {
    if (!p.enabled) continue;
    try { await syncProvider(p.provider); }
    catch (err) { console.error(`供应商 "${p.provider}" 模型同步失败:`, (err as Error).message); }
  }
}
