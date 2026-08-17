/**
 * 定价源拉取与解析 — liteLLM 价格表 / models.dev 目录 / Anthropic 官方定价文档
 * 纯函数解析 + 薄 fetch 包装（fetch 支持 urlOverride 便于测试注入 mock 服务器）
 * 统一输出 ModelPrice（USD / 1M tokens，cache_input_price 为缓存读价格）
 */

export interface ModelPrice {
  input_price: number;
  cache_input_price: number;
  output_price: number;
}

const LITELLM_URL = 'https://cdn.jsdelivr.net/gh/BerriAI/litellm@main/model_prices_and_context_window.json';
const LITELLM_URL_FALLBACK = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const MODELS_DEV_URL = 'https://models.dev/api.json';
const TIMEOUT_MS = 10_000;

/** liteLLM 价格表解析：per-token 字段 ×1e6 → per-1M；无 input/output 定价的条目跳过 */
export function parseLiteLLM(json: unknown): Map<string, ModelPrice> {
  const out = new Map<string, ModelPrice>();
  if (!json || typeof json !== 'object' || Array.isArray(json)) return out;
  for (const [key, v] of Object.entries(json as Record<string, any>)) {
    if (key === 'sample_spec' || !v || typeof v !== 'object') continue;
    if (typeof v.input_cost_per_token !== 'number' || typeof v.output_cost_per_token !== 'number') continue;
    out.set(key.toLowerCase(), {
      input_price: v.input_cost_per_token * 1e6,
      cache_input_price: (typeof v.cache_read_input_token_cost === 'number' ? v.cache_read_input_token_cost : 0) * 1e6,
      output_price: v.output_cost_per_token * 1e6,
    });
  }
  return out;
}

/** models.dev 解析：按 provider 展开模型，cost 字段即 per-1M 单价；无 cost 的跳过 */
export function parseModelsDev(json: unknown): Map<string, ModelPrice> {
  const out = new Map<string, ModelPrice>();
  if (!json || typeof json !== 'object' || Array.isArray(json)) return out;
  for (const prov of Object.values(json as Record<string, any>)) {
    const models = prov?.models;
    if (!models || typeof models !== 'object') continue;
    for (const [model, m] of Object.entries(models as Record<string, any>)) {
      const c = m?.cost;
      if (!c || typeof c.input !== 'number' || typeof c.output !== 'number') continue;
      out.set(model.toLowerCase(), {
        input_price: c.input,
        cache_input_price: typeof c.cache_read === 'number' ? c.cache_read : 0,
        output_price: c.output,
      });
    }
  }
  return out;
}

/** 候选 key 归一化：剥离首个 / 或 . 前缀后小写（如 moonshot/kimi-k2 → kimi-k2、anthropic.claude-opus-4-6-v1 → claude-opus-4-6-v1） */
function candidateKeys(key: string): string[] {
  const lower = key.toLowerCase();
  const candidates = [lower];
  const slash = lower.indexOf('/');
  if (slash >= 0) candidates.push(lower.slice(slash + 1));
  const dot = lower.indexOf('.');
  if (dot >= 0) candidates.push(lower.slice(dot + 1));
  return candidates;
}

/** 匹配策略：精确 → 前缀（候选 key 归一化后最长优先，同 matchPricing 前缀思想） */
export function matchModelPricing(model: string, prices: Map<string, ModelPrice>): ModelPrice | undefined {
  const lowerModel = model.toLowerCase();
  const exact = prices.get(lowerModel);
  if (exact) return exact;
  let best: { key: string; price: ModelPrice } | null = null;
  for (const [key, price] of prices) {
    for (const cand of candidateKeys(key)) {
      if (cand === lowerModel) return price;
      // 双向前缀：探测名可能是 key 的超集（如带日期后缀），也可能是子集（如 bedrock 风格 key 带版本后缀）
      if ((lowerModel.startsWith(cand) || cand.startsWith(lowerModel)) && (!best || cand.length > best.key.length)) {
        best = { key: cand, price };
      }
    }
  }
  return best?.price;
}

/** 带 10s 超时的 fetch JSON 包装 */
async function fetchJsonWithTimeout(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}

/** 拉取 liteLLM 价格表（jsdelivr 镜像为主，GitHub raw 备份） */
export async function fetchLiteLLMPricing(urlOverride?: string): Promise<Map<string, ModelPrice>> {
  try {
    return parseLiteLLM(await fetchJsonWithTimeout(urlOverride ?? LITELLM_URL));
  } catch (err) {
    console.warn('liteLLM 主源拉取失败，尝试备份源:', (err as Error).message);
    return parseLiteLLM(await fetchJsonWithTimeout(LITELLM_URL_FALLBACK));
  }
}

/** 拉取 models.dev 目录（fallback 定价源） */
export async function fetchModelsDevPricing(urlOverride?: string): Promise<Map<string, ModelPrice>> {
  return parseModelsDev(await fetchJsonWithTimeout(urlOverride ?? MODELS_DEV_URL));
}

const ANTHROPIC_PRICING_URL = 'https://platform.claude.com/docs/en/pricing.md';

/** 显示名 → 模型 ID：归一化 "Claude " 前缀、小写、空白与点号转连字符（"Claude Opus 4.8" → "claude-opus-4-8"） */
function displayNameToModelId(name: string): string {
  return name.replace(/^Claude\s+/i, 'claude-').toLowerCase().replace(/[\s.]+/g, '-');
}

/** Anthropic 官方定价文档解析：扫描 markdown 表格中首列以 Claude 开头的行，
 *  依次提取 $ 价格列 [输入, 输出, 缓存读(可选)]；缓存读缺失回落 input × 0.1 */
export function parseAnthropicPricing(markdown: string): Map<string, ModelPrice> {
  const out = new Map<string, ModelPrice>();
  for (const line of markdown.split('\n')) {
    if (!/^\s*\|/.test(line) || !/Claude/i.test(line)) continue;
    const cells = line.split('|').map(c => c.trim()).filter(Boolean);
    if (cells.length < 3) continue;
    const modelId = displayNameToModelId(cells[0]);
    if (!/^claude-/.test(modelId)) continue;
    const prices = cells.flatMap(c => [...c.matchAll(/\$([\d.]+)/g)].map(m => parseFloat(m[1])));
    if (prices.length < 2 || !Number.isFinite(prices[0]) || !Number.isFinite(prices[1])) continue;
    const cacheRead = prices.length >= 3 && Number.isFinite(prices[2]) ? prices[2] : prices[0] * 0.1;
    out.set(modelId, { input_price: prices[0], cache_input_price: cacheRead, output_price: prices[1] });
  }
  return out;
}

/** 拉取 Anthropic 官方定价文档（运行时直连；WebFetch 类爬虫被 404 属已知现象，失败由调用方回落其他源） */
export async function fetchAnthropicPricing(urlOverride?: string): Promise<Map<string, ModelPrice>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(urlOverride ?? ANTHROPIC_PRICING_URL, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${urlOverride ?? ANTHROPIC_PRICING_URL}`);
    return parseAnthropicPricing(await res.text());
  } finally {
    clearTimeout(timeout);
  }
}
