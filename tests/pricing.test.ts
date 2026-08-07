import { describe, it, expect } from 'vitest';
import { matchPricing, calculateCost } from '../proxy/pricing.js';
import type { Pricing } from '../shared/types.js';

const SAMPLE: Pricing[] = [
  { id: 1, provider: 'anthropic', model: 'claude-opus-5', input_price: 15, cache_input_price: 1.5, output_price: 75, unit: 'per_1M_tokens', currency: 'USD', effective_from: null },
  { id: 2, provider: 'openai', model: 'gpt-4o', input_price: 2.5, cache_input_price: 1.25, output_price: 10, unit: 'per_1M_tokens', currency: 'USD', effective_from: null },
];

const SAMPLE_CNY: Pricing = { id: 3, provider: 'openai', model: 'gpt-4o-cny', input_price: 2.5, cache_input_price: 1.25, output_price: 10, unit: 'per_1M_tokens', currency: 'CNY', effective_from: null };

const RATES = {
  'CNY→USD': 0.1482,  // 1 CNY = 0.1482 USD, so 1 USD = 1/0.1482 ≈ 6.748 CNY
};

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
    const r = calculateCost(tokens, SAMPLE_CNY); // 与 SAMPLE[1] 价格一致，CNY 币种免换算
    expect(r.input_cost).toBeCloseTo(0.0025, 6);
    expect(r.output_cost).toBeCloseTo(0.005, 6);
    expect(r.total_cost).toBeCloseTo(0.0075, 6);
  });

  it('费用计算：混合缓存', () => {
    const tokens = { prompt_tokens: 1500, output_tokens: 800, cache_read_tokens: 1000, cache_write_tokens: 200, uncached_input: 300 };
    const r = calculateCost(tokens, { ...SAMPLE[0], currency: 'CNY' }); // 价格不变，CNY 币种免换算
    expect(r.input_cost).toBeCloseTo(0.009, 6);
    expect(r.output_cost).toBeCloseTo(0.06, 6);
    expect(r.total_cost).toBeCloseTo(0.069, 6);
    expect(r.cache_savings).toBeCloseTo(0.0135, 6);
  });

  it('CNY 定价无换算（恒等）', () => {
    const tokens = { prompt_tokens: 1000, output_tokens: 500, cache_read_tokens: null, cache_write_tokens: null, uncached_input: 1000 };
    const r = calculateCost(tokens, SAMPLE_CNY, RATES);
    expect(r.input_cost).toBeCloseTo(0.0025, 6);
    expect(r.output_cost).toBeCloseTo(0.005, 6);
  });

  it('USD 定价换算为 CNY', () => {
    const tokens = { prompt_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_tokens: null, cache_write_tokens: null, uncached_input: 1_000_000 };
    const r = calculateCost(tokens, SAMPLE[1], RATES); // SAMPLE[1] = gpt-4o, USD
    // input: 2.5 USD/1M × 1M tokens = 2.5 USD → CNY: 2.5 / 0.1482 ≈ 16.869 CNY
    expect(r.input_cost).toBeCloseTo(16.869, 2);
    // output: 10 USD/1M × 1M tokens = 10 USD → CNY: 10 / 0.1482 ≈ 67.476 CNY
    expect(r.output_cost).toBeCloseTo(67.476, 2);
    expect(r.total_cost).toBeCloseTo(84.345, 2);
  });

  it('定价币种无对应汇率时抛出错误', () => {
    const tokens = { prompt_tokens: 1000, output_tokens: 500, cache_read_tokens: null, cache_write_tokens: null, uncached_input: 1000 };
    const unknownPricing: Pricing = { ...SAMPLE[0], currency: 'XXX' as any };
    expect(() => calculateCost(tokens, unknownPricing, RATES)).toThrow('CNY→XXX');
  });

  it('不传 rates 且 pricing.currency=CNY 正常计算', () => {
    const tokens = { prompt_tokens: 1_000_000, output_tokens: 0, cache_read_tokens: null, cache_write_tokens: null, uncached_input: 1_000_000 };
    const r = calculateCost(tokens, SAMPLE_CNY);  // 不传 rates
    expect(r.input_cost).toBeCloseTo(2.5, 4);
  });
});
