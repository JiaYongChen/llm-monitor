/** 定价匹配 + 费用计算 */
import type { NormalizedTokens, Pricing, CostResult } from '../shared/types.js';

export function matchPricing(provider: string, model: string, allPricing: Pricing[]): Pricing | undefined {
  const candidates = allPricing
    .filter(p => p.provider.toLowerCase() === provider.toLowerCase())
    .sort((a, b) => b.model.length - a.model.length); // 最长前缀优先
  const lowerModel = model.toLowerCase();
  return candidates.find(p => lowerModel.startsWith(p.model.toLowerCase()));
}

export function calculateCost(
  tokens: NormalizedTokens,
  pricing: Pricing,
  rates?: Record<string, number>,
): CostResult {
  const uncached = tokens.uncached_input || 0;
  const cacheWrite = tokens.cache_write_tokens || 0;
  const cacheRead = tokens.cache_read_tokens || 0;
  const output = tokens.output_tokens || 0;

  const uncachedCost = (uncached / 1_000_000) * pricing.input_price;
  const cacheWriteCost = (cacheWrite / 1_000_000) * pricing.input_price;
  const cacheReadCost = (cacheRead / 1_000_000) * pricing.cache_input_price;
  const outputCost = (output / 1_000_000) * pricing.output_price;

  let inputCost = uncachedCost + cacheWriteCost + cacheReadCost;
  let finalOutputCost = outputCost;
  let totalCost = inputCost + outputCost;
  let savings = (cacheRead / 1_000_000) * (pricing.input_price - pricing.cache_input_price);

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
