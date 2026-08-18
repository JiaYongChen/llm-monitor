/**
 * 内置供应商预置模型种子导入 — 启动时仅当 provider_models 不存在同 (provider, model) 行时才写入
 * （enabled=1, available=1, 带价格），不覆盖自动同步写入的价格，保证「自动定价为权威」的覆盖语义
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { seedProviderModels } from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface DefaultPricingItem {
  provider: string;
  model: string;
  input_price: number;
  cache_input_price: number;
  output_price: number;
  currency: string;
}

/** 种子导入内置预置模型（seed-if-absent：已有同 provider+model 行一律跳过，含自动同步行） */
export async function importDefaultPricing(): Promise<void> {
  try {
    const file = join(__dirname, 'data', 'default-pricing.json');
    const data = JSON.parse(readFileSync(file, 'utf-8')) as DefaultPricingItem[];
    const seeded = seedProviderModels(data, Date.now());
    console.log(`已种子导入 ${seeded} 条预置模型（${data.length - seeded} 条已存在跳过）`);
  } catch (err) {
    console.warn('同步预置模型失败:', err);
  }
}
