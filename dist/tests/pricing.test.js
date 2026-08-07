import { describe, it, expect } from 'vitest';
import { matchPricing, calculateCost } from '../proxy/pricing.js';
const SAMPLE = [
    { id: 1, provider: 'anthropic', model: 'claude-opus-5', input_price: 15, cache_input_price: 1.5, output_price: 75, unit: 'per_1M_tokens', currency: 'USD', effective_from: null },
    { id: 2, provider: 'openai', model: 'gpt-4o', input_price: 2.5, cache_input_price: 1.25, output_price: 10, unit: 'per_1M_tokens', currency: 'USD', effective_from: null },
];
describe('pricing', () => {
    it('前缀匹配', () => {
        const p = matchPricing('anthropic', 'claude-opus-5-20260101', SAMPLE);
        expect(p?.input_price).toBe(15);
    });
    it('无匹配返回 undefined', () => {
        expect(matchPricing('unknown', 'x', SAMPLE)).toBeUndefined();
    });
    it('费用计算：全无缓存', () => {
        const tokens = { prompt_tokens: 1000, output_tokens: 500, cache_read_tokens: null, cache_write_tokens: null, uncached_input: 1000 };
        const r = calculateCost(tokens, SAMPLE[1]);
        expect(r.input_cost).toBeCloseTo(0.0025, 6);
        expect(r.output_cost).toBeCloseTo(0.005, 6);
        expect(r.total_cost).toBeCloseTo(0.0075, 6);
    });
    it('费用计算：混合缓存', () => {
        const tokens = { prompt_tokens: 1500, output_tokens: 800, cache_read_tokens: 1000, cache_write_tokens: 200, uncached_input: 300 };
        const r = calculateCost(tokens, SAMPLE[0]);
        expect(r.input_cost).toBeCloseTo(0.009, 6);
        expect(r.output_cost).toBeCloseTo(0.06, 6);
        expect(r.total_cost).toBeCloseTo(0.069, 6);
        expect(r.cache_savings).toBeCloseTo(0.0135, 6);
    });
});
//# sourceMappingURL=pricing.test.js.map