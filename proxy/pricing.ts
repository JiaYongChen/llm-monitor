/** 定价匹配 + 费用计算（定价数据源：provider_models 价格列，价格 0 = 无定价） */
import type { NormalizedTokens, ProviderModelRow, CostResult } from '../shared/types.js';

/** 定价匹配：provider 大小写不敏感等值 + 价格列 > 0（忽略 enabled/available 开关）+ 模型名最长前缀 */
export function matchPricing(provider: string, model: string, allModels: ProviderModelRow[]): ProviderModelRow | undefined {
  const candidates = allModels
    .filter(m => m.provider.toLowerCase() === provider.toLowerCase())
    .filter(m => m.input_price > 0 || m.output_price > 0)
    .sort((a, b) => b.model.length - a.model.length); // 最长前缀优先
  const lowerModel = model.toLowerCase();
  return candidates.find(m => lowerModel.startsWith(m.model.toLowerCase()));
}

export function calculateCost(
  tokens: NormalizedTokens,
  pricing: ProviderModelRow,
  rates?: Record<string, number>,
): CostResult {
  const uncached = tokens.uncached_input || 0;
  const cacheWrite = tokens.cache_write_tokens || 0;
  const cacheRead = tokens.cache_read_tokens || 0;
  const output = tokens.output_tokens || 0;

  // cache_input_price = 0 是「无缓存定价」哨兵（定价源未提供 cache_read 价）：
  // 按 0 计费会使命中缓存的调用系统性漏计，改为按 input_price 计费（不享受折扣，savings 为 0）
  const cacheReadPrice = pricing.cache_input_price > 0 ? pricing.cache_input_price : pricing.input_price;

  const uncachedCost = (uncached / 1_000_000) * pricing.input_price;
  const cacheWriteCost = (cacheWrite / 1_000_000) * pricing.input_price;
  const cacheReadCost = (cacheRead / 1_000_000) * cacheReadPrice;
  const outputCost = (output / 1_000_000) * pricing.output_price;

  let inputCost = uncachedCost + cacheWriteCost + cacheReadCost;
  let finalOutputCost = outputCost;
  let totalCost = inputCost + outputCost;
  let savings = (cacheRead / 1_000_000) * (pricing.input_price - cacheReadPrice);

  // 非 CNY 定价 → 换算为 CNY (1 CNY = rate FOREIGN → 1 FOREIGN = 1/rate CNY)
  if (pricing.currency && pricing.currency !== 'CNY') {
    const rate = rates?.[`CNY→${pricing.currency}`];
    if (!rate) {
      throw new Error(`缺少汇率: CNY→${pricing.currency}，无法计算费用`);
    }
    const multiplier = 1 / rate;
    inputCost *= multiplier;
    finalOutputCost *= multiplier;
    totalCost *= multiplier;
    savings *= multiplier;
  }

  return {
    input_cost: Math.round(inputCost * 1e8) / 1e8,
    output_cost: Math.round(finalOutputCost * 1e8) / 1e8,
    total_cost: Math.round(totalCost * 1e8) / 1e8,
    cache_savings: Math.round(savings * 1e8) / 1e8,
  };
}
