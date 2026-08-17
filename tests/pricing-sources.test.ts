import { describe, it, expect } from 'vitest';
import { parseLiteLLM, parseModelsDev, matchModelPricing } from '../proxy/pricing-sources.js';

// liteLLM 字段：per-token 单位 → 解析后 ×1e6 转为 per-1M
const LITELLM_FIXTURE = {
  sample_spec: { input_cost_per_token: 0, output_cost_per_token: 0 },
  'gpt-5.6-sol': { input_cost_per_token: 5e-6, output_cost_per_token: 30e-6, cache_read_input_token_cost: 2.5e-6 },
  'claude-sonnet-5': { input_cost_per_token: 3e-6, output_cost_per_token: 15e-6, cache_read_input_token_cost: 0.3e-6 },
  'claude-haiku-4-5-20251001': { input_cost_per_token: 1e-6, output_cost_per_token: 5e-6 },
  'moonshot/kimi-k2': { input_cost_per_token: 0.5e-6, output_cost_per_token: 1.5e-6 },
  'anthropic.claude-opus-4-6-v1': { input_cost_per_token: 5e-6, output_cost_per_token: 25e-6, cache_read_input_token_cost: 0.5e-6 },
};

const MODELS_DEV_FIXTURE = {
  anthropic: { models: { 'claude-sonnet-5': { cost: { input: 3, output: 15, cache_read: 0.3 } } } },
  'qiniu-ai': { models: { 'qwen3-30b': { cost: { input: 0.14, output: 0.28, cache_read: 0.028 } } } },
};

describe('parseLiteLLM', () => {
  it('解析 per-token 字段 ×1e6，含缓存读价格', () => {
    const m = parseLiteLLM(LITELLM_FIXTURE);
    expect(m.get('gpt-5.6-sol')).toEqual({ input_price: 5, cache_input_price: 2.5, output_price: 30 });
  });
  it('无缓存读字段时 cache_input_price 为 0', () => {
    const m = parseLiteLLM(LITELLM_FIXTURE);
    expect(m.get('claude-haiku-4-5-20251001')?.cache_input_price).toBe(0);
  });
  it('忽略 sample_spec 与无定价字段的条目', () => {
    const m = parseLiteLLM({ sample_spec: {}, 'x-model': { foo: 1 } });
    expect(m.size).toBe(0);
  });
  it('非对象入参返回空 Map', () => {
    expect(parseLiteLLM(null).size).toBe(0);
  });
});

describe('parseModelsDev', () => {
  it('按 provider → models 展开，cost 单位为 per-1M 直接采用', () => {
    const m = parseModelsDev(MODELS_DEV_FIXTURE);
    expect(m.get('claude-sonnet-5')).toEqual({ input_price: 3, cache_input_price: 0.3, output_price: 15 });
    expect(m.get('qwen3-30b')?.input_price).toBe(0.14);
  });
  it('无 cost 字段的模型跳过', () => {
    const m = parseModelsDev({ anthropic: { models: { 'x': { limit: 100 } } } });
    expect(m.size).toBe(0);
  });
});

describe('matchModelPricing', () => {
  const prices = parseLiteLLM(LITELLM_FIXTURE);
  it('精确匹配（小写）', () => {
    expect(matchModelPricing('gpt-5.6-sol', prices)?.input_price).toBe(5);
  });
  it('前缀匹配最长优先（探测名带日期后缀）', () => {
    expect(matchModelPricing('claude-haiku-4-5-20251001', prices)?.input_price).toBe(1);
  });
  it('剥离 / 前缀（供应商路由风格 key）', () => {
    expect(matchModelPricing('kimi-k2', prices)?.input_price).toBe(0.5);
  });
  it('剥离 . 前缀（bedrock 风格 key）后前缀匹配', () => {
    expect(matchModelPricing('claude-opus-4-6', prices)?.input_price).toBe(5);
  });
  it('无匹配返回 undefined', () => {
    expect(matchModelPricing('unknown-model', prices)).toBeUndefined();
  });
});
