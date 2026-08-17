/**
 * 预置定价种子导入 — 启动时仅当 pricing 表不存在同 (provider, model) 行时才写入，
 * 不覆盖自动同步（pricing-sources → model-sync）写入的价格，保证「自动定价为权威」的覆盖语义
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listPricing, upsertPricing } from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface DefaultPricingItem {
  provider: string;
  model: string;
  input_price: number;
  cache_input_price: number;
  output_price: number;
  currency?: string;
}

/** 种子导入预置定价（seed-if-absent：已有同 provider+model 条目一律跳过，含自动同步价） */
export async function importDefaultPricing(): Promise<void> {
  try {
    const file = join(__dirname, 'data', 'default-pricing.json');
    const data = JSON.parse(readFileSync(file, 'utf-8')) as DefaultPricingItem[];
    const existing = new Set(
      listPricing().map(p => `${p.provider}:${String(p.model).toLowerCase()}`),
    );
    let seeded = 0;
    for (const item of data) {
      const key = `${item.provider.toLowerCase()}:${item.model.toLowerCase()}`;
      if (existing.has(key)) continue; // 已有条目（自动同步价等）不被覆盖
      upsertPricing(item.provider, item.model, item.input_price, item.cache_input_price, item.output_price, item.currency || 'CNY', true);
      seeded++;
    }
    console.log(`已种子导入 ${seeded} 条预置定价（${data.length - seeded} 条已存在跳过）`);
  } catch (err) {
    console.warn('同步预置定价失败:', err);
  }
}
