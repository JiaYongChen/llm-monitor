/**
 * 模型探测 + 定价自动同步 — 供应商配置（含 api_key）新增/更新后自动获取可用模型与定价
 * 仿照 rates.ts 模式：fetch + 10s 超时 + 调度；定价匹配复用 pricing-sources.ts
 */

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
