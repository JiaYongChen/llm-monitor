/** 定价匹配 + 费用计算 */
import type { NormalizedTokens, Pricing, CostResult } from '../shared/types.js';
export declare function matchPricing(provider: string, model: string, allPricing: Pricing[]): Pricing | undefined;
export declare function calculateCost(tokens: NormalizedTokens, pricing: Pricing): CostResult;
