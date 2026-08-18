import { describe, it, expect } from 'vitest';
import { matchPricing, calculateCost } from '../proxy/pricing.js';
import type { ProviderModelRow } from '../shared/types.js';

const row = (provider: string, model: string, input: number, output: number, cache = 0, enabled = 1, available = 1): ProviderModelRow => ({
  provider, model, enabled, available,
  input_price: input, cache_input_price: cache, output_price: output, currency: 'USD',
  created_at: 0, updated_at: 0,
});

const SAMPLE: ProviderModelRow[] = [
  row('anthropic', 'claude-opus-5', 15, 75, 1.5),
  row('openai', 'gpt-4o', 2.5, 10, 1.25),
];
const SAMPLE_CNY: ProviderModelRow = { ...row('openai', 'gpt-4o-cny', 2.5, 10, 1.25), currency: 'CNY' };

const RATES = {
  'CNY→USD': 0.1482,  // 1 CNY = 0.1482 USD, so 1 USD = 1/0.1482 ≈ 6.748 CNY
};

describe('pricing', () => {
  it('前缀匹配', () => {
    const p = matchPricing('anthropic', 'claude-opus-5-20260101', SAMPLE);
    expect(p?.input_price).toBe(15);
  });

  it('前缀匹配大小写不敏感（provider 与 model）', () => {
    const p = matchPricing('ANTHROPIC', 'Claude-Opus-5-20260101', SAMPLE);
    expect(p?.input_price).toBe(15);
  });

  it('无匹配返回 undefined', () => {
    expect(matchPricing('unknown', 'x', SAMPLE)).toBeUndefined();
  });

  it('价格 0 的行不参与匹配（无定价）', () => {
    expect(matchPricing('prov', 'gpt-x', [row('prov', 'gpt-x', 0, 0)])).toBeUndefined();
  });

  it('enabled=0 / available=0 的行仍参与计费匹配（开关只影响 UI）', () => {
    const m = matchPricing('prov', 'gpt-x-2025', [row('prov', 'gpt-x', 5, 30, 0, 0, 0)]);
    expect(m?.model).toBe('gpt-x');
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
    const unknownPricing: ProviderModelRow = { ...SAMPLE[0], currency: 'XXX' as any };
    expect(() => calculateCost(tokens, unknownPricing, RATES)).toThrow('CNY→XXX');
  });

  it('不传 rates 且 pricing.currency=CNY 正常计算', () => {
    const tokens = { prompt_tokens: 1_000_000, output_tokens: 0, cache_read_tokens: null, cache_write_tokens: null, uncached_input: 1_000_000 };
    const r = calculateCost(tokens, SAMPLE_CNY);  // 不传 rates
    expect(r.input_cost).toBeCloseTo(2.5, 4);
  });
});
