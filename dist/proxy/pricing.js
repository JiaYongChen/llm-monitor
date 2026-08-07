export function matchPricing(provider, model, allPricing) {
    const candidates = allPricing
        .filter(p => p.provider === provider)
        .sort((a, b) => b.model.length - a.model.length); // 最长前缀优先
    return candidates.find(p => model.startsWith(p.model));
}
export function calculateCost(tokens, pricing) {
    const uncached = tokens.uncached_input || 0;
    const cacheWrite = tokens.cache_write_tokens || 0;
    const cacheRead = tokens.cache_read_tokens || 0;
    const output = tokens.output_tokens || 0;
    const uncachedCost = (uncached / 1_000_000) * pricing.input_price;
    const cacheWriteCost = (cacheWrite / 1_000_000) * pricing.input_price;
    const cacheReadCost = (cacheRead / 1_000_000) * pricing.cache_input_price;
    const outputCost = (output / 1_000_000) * pricing.output_price;
    const inputCost = uncachedCost + cacheWriteCost + cacheReadCost;
    const totalCost = inputCost + outputCost;
    const savings = (cacheRead / 1_000_000) * (pricing.input_price - pricing.cache_input_price);
    return {
        input_cost: Math.round(inputCost * 1e8) / 1e8,
        output_cost: Math.round(outputCost * 1e8) / 1e8,
        total_cost: Math.round(totalCost * 1e8) / 1e8,
        cache_savings: Math.round(savings * 1e8) / 1e8,
    };
}
//# sourceMappingURL=pricing.js.map