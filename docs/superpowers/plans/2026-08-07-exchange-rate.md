# 汇率换算功能 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 llm-monitor 实现真正的多币种汇率换算，替换当前仅切换货币符号/标签的伪实现。

**Architecture:** 新增 `proxy/rates.ts` 模块负责汇率获取与缓存（Frankfurter API + metadata 表）；改造 `calculateCost` 在非 CNY 定价时按汇率转 CNY 入库；前端 Context 下发 rates，`formatCost` 按用户偏好币种换算显示。

**Tech Stack:** TypeScript, Fastify, React + TanStack Query, SQLite (sql.js), Frankfurter API

## Global Constraints

- 数据库费用字段统一以 CNY（元）存储
- 定价表 `pricing.currency` 标记录入币种，原样展示
- 前端展示从 CNY 按用户偏好币种 + 汇率换算
- 汇率每天北京时间 09:30 刷新，启动时立即拉取
- API 失败用缓存兜底，无缓存用硬编码兜底汇率
- 兜底汇率（2026-08-06 实时值）：USD 0.1482, EUR 0.1284, JPY 23.39, GBP 0.1100
- API 地址：`https://api.frankfurter.dev/v1/latest?from=CNY&to=USD,EUR,JPY,GBP`

---

## File Map

| 文件 | 操作 | 职责 |
|---|---|---|
| `proxy/rates.ts` | **Create** | 汇率获取、缓存、定时刷新、兜底汇率 |
| `proxy/db.ts` | Modify | `upsertPricing` 读写 `currency` 列 |
| `proxy/pricing.ts` | Modify | `calculateCost` 支持非 CNY → CNY 换算 |
| `proxy/recorder.ts` | Modify | `processRecord` 传入 rates |
| `proxy/router.ts` | Modify | `/api/config` 扩展、`/api/rates/refresh`、`/api/pricing` 传 currency |
| `proxy/main.ts` | Modify | 启动时调用 `scheduleDailyRefresh()` |
| `webui/src/lib/currency.tsx` | Modify | `formatCost` 支持 rates；Context 类型扩展 |
| `webui/src/components/CurrencyProvider.tsx` | Modify | Context 下发 rates |
| `webui/src/api/client.ts` | Modify | 新增 `refreshRates`，`getConfig` 类型扩展 |
| `webui/src/pages/Settings.tsx` | Modify | 汇率信息行 + 刷新按钮 |
| `webui/src/components/PricingTable.tsx` | Modify | 表单新增币种下拉框 |
| `webui/src/components/KpiCards.tsx` | Modify | 传入 rates |
| `webui/src/components/CostPieChart.tsx` | Modify | 传入 rates |
| `webui/src/components/CallTimeline.tsx` | Modify | 传入 rates |
| `webui/src/components/CallDetailPanel.tsx` | Modify | 传入 rates |
| `webui/src/pages/Dashboard.tsx` | Modify | 传入 rates |
| `webui/src/pages/SessionDetail.tsx` | Modify | 传入 rates |
| `tests/rates.test.ts` | **Create** | 汇率模块单元测试 |
| `tests/pricing.test.ts` | Modify | 扩展非 CNY 定价 + 汇率转换用例 |

---

### Task 1: 汇率模块 `proxy/rates.ts`

**Files:**
- Create: `proxy/rates.ts`
- Create: `tests/rates.test.ts`

**Interfaces:**
- Produces:
  - `getRates(): Record<string, number>` — 返回 `{ "CNY→USD": 0.1482, ... }`
  - `scheduleDailyRefresh(): void` — 启动定时调度
  - `refreshRates(): Promise<{ rates: Record<string, number>; updatedAt: string }>` — 手动刷新
  - `FALLBACK_RATES: Record<string, number>` — 兜底汇率常量（供测试引用）

- [ ] **Step 1: 编写失败测试**

```ts
// tests/rates.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// 我们需要测试纯函数逻辑：格式转换、兜底汇率、定时计算
// 注意：直接 import 会触发模块顶层代码（如 request），所以测试用动态 import + mock

const FALLBACK_RATES = {
  'CNY→USD': 0.1482,
  'CNY→EUR': 0.1284,
  'CNY→JPY': 23.39,
  'CNY→GBP': 0.1100,
};

describe('rates', () => {
  it('兜底汇率覆盖 4 个非 CNY 币种', () => {
    const currencies = ['USD', 'EUR', 'JPY', 'GBP'];
    for (const c of currencies) {
      const key = `CNY→${c}`;
      expect(FALLBACK_RATES[key]).toBeDefined();
      expect(FALLBACK_RATES[key]).toBeGreaterThan(0);
    }
  });

  it('getRates 从 metadata 解析汇率', async () => {
    // mock getSetting 返回 JSON 字符串
    const mockGetSetting = vi.fn((key: string) => {
      if (key === 'exchange_rates') return JSON.stringify(FALLBACK_RATES);
      return null;
    });
    vi.doMock('./db.js', () => ({ getSetting: mockGetSetting }));

    const { getRates } = await import('../proxy/rates.js');
    const rates = getRates();
    expect(rates['CNY→USD']).toBe(0.1482);
    expect(rates['CNY→EUR']).toBe(0.1284);
  });

  it('getRates 无缓存时返回兜底汇率', async () => {
    const mockGetSetting = vi.fn(() => null);
    vi.doMock('./db.js', () => ({ getSetting: mockGetSetting }));

    const { getRates } = await import('../proxy/rates.js');
    const rates = getRates();
    expect(rates['CNY→USD']).toBe(0.1482);
  });

  it('scheduleDailyRefresh 计算到下次 09:30 的间隔', () => {
    // 直接测试计算逻辑：根据"当前时间"算出到 09:30 CST 的毫秒数
    // 用固定 UTC 时间验证
    // 09:30 CST = 01:30 UTC
    function msUntilNext0930(nowCST: Date): number {
      const target = new Date(nowCST);
      target.setHours(9, 30, 0, 0);
      if (target <= nowCST) {
        target.setDate(target.getDate() + 1);
      }
      return target.getTime() - nowCST.getTime();
    }

    // 早上 08:00 → 应等 1.5 小时 = 5400000ms
    const morning = new Date('2026-08-07T08:00:00+08:00');
    const diff1 = msUntilNext0930(morning);
    expect(diff1).toBe(90 * 60 * 1000); // 1.5h

    // 早上 10:00 → 应等到次日 09:30 = 23.5 小时
    const afterTarget = new Date('2026-08-07T10:00:00+08:00');
    const diff2 = msUntilNext0930(afterTarget);
    expect(diff2).toBeGreaterThan(0);
    expect(diff2).toBeLessThan(24 * 60 * 60 * 1000);
    // 23.5h = 84600000ms
    expect(diff2).toBe(23.5 * 60 * 60 * 1000);
  });

  it('refreshRates 成功时写入 metadata', async () => {
    const mockSetSetting = vi.fn();
    const mockGetSetting = vi.fn(() => null);
    vi.doMock('./db.js', () => ({
      getSetting: mockGetSetting,
      setSetting: mockSetSetting,
    }));

    // mock fetch
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        base: 'CNY',
        date: '2026-08-06',
        rates: { USD: 0.14817, EUR: 0.12837, JPY: 23.386, GBP: 0.11002 },
      }),
    });

    const { refreshRates } = await import('../proxy/rates.js');
    const result = await refreshRates();

    expect(result.rates['CNY→USD']).toBeCloseTo(0.1482, 3);
    expect(result.rates['CNY→EUR']).toBeCloseTo(0.1284, 3);
    expect(result.rates['CNY→JPY']).toBeCloseTo(23.39, 1);
    expect(result.rates['CNY→GBP']).toBeCloseTo(0.1100, 3);
    expect(mockSetSetting).toHaveBeenCalledTimes(2); // exchange_rates + rates_updated_at
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
npx vitest run tests/rates.test.ts
```
Expected: FAIL — module `../proxy/rates.js` not found.

- [ ] **Step 3: 实现 `proxy/rates.ts`**

```ts
/** 汇率模块 — Frankfurter API + metadata 缓存 + 定时刷新 */

import { getSetting, setSetting } from './db.js';

// ── 兜底汇率（2026-08-06 Frankfurter 实时值） ──

export const FALLBACK_RATES: Record<string, number> = {
  'CNY→USD': 0.1482,
  'CNY→EUR': 0.1284,
  'CNY→JPY': 23.39,
  'CNY→GBP': 0.1100,
};

const FRANKFURTER_URL = 'https://api.frankfurter.dev/v1/latest?from=CNY&to=USD,EUR,JPY,GBP';

// ── 公开接口 ──

/** 获取当前汇率映射，优先缓存 → 兜底 */
export function getRates(): Record<string, number> {
  const cached = getSetting('exchange_rates');
  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch { /* 解析失败，回退兜底 */ }
  }
  return { ...FALLBACK_RATES };
}

/** 获取汇率更新时间 */
export function getRatesUpdatedAt(): string | null {
  return getSetting('rates_updated_at');
}

/** 手动拉取汇率并写入缓存，返回最新汇率 */
export async function refreshRates(): Promise<{ rates: Record<string, number>; updatedAt: string }> {
  let rates: Record<string, number> = { ...FALLBACK_RATES };

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    const res = await fetch(FRANKFURTER_URL, { signal: controller.signal });
    clearTimeout(timeout);

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = (await res.json()) as { base: string; rates: Record<string, number> };
    rates = {};
    for (const [currency, rate] of Object.entries(data.rates)) {
      rates[`CNY→${currency}`] = Math.round(rate * 1e8) / 1e8;
    }
  } catch (err) {
    console.warn('汇率刷新失败，使用缓存/兜底值:', err);
    // 尝试读缓存
    const cached = getSetting('exchange_rates');
    if (cached) {
      try { rates = JSON.parse(cached); } catch { /* keep fallback */ }
    }
  }

  // 写入缓存
  setSetting('exchange_rates', JSON.stringify(rates));
  const updatedAt = new Date().toISOString();
  setSetting('rates_updated_at', updatedAt);

  return { rates, updatedAt };
}

// ── 定时调度 ──

let refreshTimer: ReturnType<typeof setTimeout> | null = null;

/** 计算到下一个北京时间 09:30 的毫秒数 */
function msUntilNext0930CST(): number {
  const now = new Date();
  // 获取当前北京时间的小时和分钟（用 UTC 偏移计算，避免依赖时区）
  // Asia/Shanghai = UTC+8
  const cstNow = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const target = new Date(cstNow);
  target.setUTCHours(9, 30, 0, 0);

  if (target <= cstNow) {
    target.setUTCDate(target.getUTCDate() + 1);
  }

  return target.getTime() - cstNow.getTime();
}

/** 启动每日定时刷新（initDb 后调用一次） */
export function scheduleDailyRefresh(): void {
  // 启动时立即拉取一次
  refreshRates().then(({ rates, updatedAt }) => {
    console.log(`汇率已初始化 (${updatedAt}):`, rates);
  });

  // 计算到下次 09:30 的间隔并设置定时器
  const schedule = () => {
    if (refreshTimer) clearTimeout(refreshTimer);
    const delay = msUntilNext0930CST();
    console.log(`下次汇率刷新: ${Math.round(delay / 1000 / 60)} 分钟后`);
    refreshTimer = setTimeout(() => {
      refreshRates().then(({ rates, updatedAt }) => {
        console.log(`汇率已刷新 (${updatedAt}):`, rates);
      });
      // 设置下一个 24h 后的定时器
      refreshTimer = setTimeout(() => {
        schedule(); // 重新调度
      }, 24 * 60 * 60 * 1000);
    }, delay);
  };

  // 首次拉取后立即安排到明天 09:30（不在首次拉取的同时设 24h timer）
  // 延迟 1 秒确保首次 refreshRates 完成
  setTimeout(schedule, 2000);
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
npx vitest run tests/rates.test.ts
```
Expected: 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add proxy/rates.ts tests/rates.test.ts
git commit -m "feat: 新增汇率模块 — Frankfurter API + 缓存 + 每日 09:30 定时刷新"
```

---

### Task 2: 改造 `proxy/db.ts` — upsertPricing 支持 currency

**Files:**
- Modify: `proxy/db.ts:426-446`

**Interfaces:**
- Consumes: nothing new
- Produces: `upsertPricing(provider, model, inputPrice, cacheInputPrice, outputPrice, currency?)` — 新增可选 `currency` 参数

- [ ] **Step 1: 修改 upsertPricing 签名和 SQL**

在 `proxy/db.ts` 中找到 `upsertPricing` 函数（约第 426 行），修改签名和 SQL：

```ts
export function upsertPricing(
  provider: string, model: string,
  inputPrice: number, cacheInputPrice: number, outputPrice: number,
  currency?: string,
): number {
  const cur = currency || 'CNY';
  const existing = queryOne(
    'SELECT id FROM pricing WHERE provider = ? AND model = ? AND effective_from IS NULL',
    [provider, model],
  );
  if (existing) {
    execute(
      'UPDATE pricing SET input_price = ?, cache_input_price = ?, output_price = ?, currency = ? WHERE id = ?',
      [inputPrice, cacheInputPrice, outputPrice, cur, existing.id],
    );
    return Number(existing.id);
  }
  return executeInsert(
    'INSERT INTO pricing (provider, model, input_price, cache_input_price, output_price, currency) VALUES (?, ?, ?, ?, ?, ?) RETURNING id',
    [provider, model, inputPrice, cacheInputPrice, outputPrice, cur],
  );
}
```

- [ ] **Step 2: 确认现有调用仍然兼容**

`proxy/main.ts` 和 `proxy/router.ts` 中 `upsertPricing` 的调用不传 `currency`，应默认为 `'CNY'`。

检查 `proxy/main.ts:24` 和 `proxy/router.ts:224` 的调用，确认不加参数仍可编译。

- [ ] **Step 3: Commit**

```bash
git add proxy/db.ts
git commit -m "feat: upsertPricing 支持 currency 参数，默认 CNY"
```

---

### Task 3: 改造 `proxy/pricing.ts` — calculateCost 支持汇率换算

**Files:**
- Modify: `proxy/pricing.ts`
- Modify: `tests/pricing.test.ts`

**Interfaces:**
- Consumes: `getRates()` from Task 1
- Produces: `calculateCost(tokens, pricing, rates?)` — 新增可选 `rates` 参数；`pricing.currency !== 'CNY'` 时换算

- [ ] **Step 1: 扩展测试**

在 `tests/pricing.test.ts` 中新增以下测试用例（在现有 `describe('pricing')` 块内末尾添加）：

```ts
// 新增：import { describe, it, expect } 已有，无需改动

// 在 SAMPLE 数组中新增一个 CNY 定价条目
const SAMPLE_CNY: Pricing = { id: 3, provider: 'openai', model: 'gpt-4o-cny', input_price: 2.5, cache_input_price: 1.25, output_price: 10, unit: 'per_1M_tokens', currency: 'CNY', effective_from: null };

const RATES = {
  'CNY→USD': 0.1482,  // 1 CNY = 0.1482 USD, so 1 USD = 1/0.1482 ≈ 6.748 CNY
};

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
  const r = calculateCost(tokens, SAMPLE_CNY);
  expect(r.input_cost).toBeCloseTo(2.5, 4);
});
```

- [ ] **Step 2: 运行测试确认新增用例失败**

```bash
npx vitest run tests/pricing.test.ts
```
Expected: 新增的 4 个测试 FAIL（`calculateCost` 还不支持 rates 参数）。

- [ ] **Step 3: 修改 `calculateCost`**

```ts
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
  let totalCost = inputCost + outputCost;
  const savings = (cacheRead / 1_000_000) * (pricing.input_price - pricing.cache_input_price);

  // 非 CNY 定价 → 换算为 CNY
  if (pricing.currency && pricing.currency !== 'CNY') {
    const rate = rates?.[`CNY→${pricing.currency}`];
    if (!rate) {
      throw new Error(`缺少汇率: CNY→${pricing.currency}，无法计算费用`);
    }
    const multiplier = 1 / rate; // 1 USD = 1/rate CNY
    inputCost *= multiplier;
    totalCost *= multiplier;
  }

  return {
    input_cost: Math.round(inputCost * 1e8) / 1e8,
    output_cost: Math.round(outputCost * multiplier ?? outputCost * 1e8) / 1e8, // FIXME: need correct output scaling
  };
}
```

Wait — the output cost also needs multiplier. Let me re-think:

Actually, I need to be more careful. The `outputCost` also needs to be converted, and the savings too. Let me rewrite step 3 with correct logic:

```ts
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
  let totalCost = inputCost + outputCost;
  let savings = (cacheRead / 1_000_000) * (pricing.input_price - pricing.cache_input_price);

  // 非 CNY 定价 → 换算为 CNY
  if (pricing.currency && pricing.currency !== 'CNY') {
    const rate = rates?.[`CNY→${pricing.currency}`];
    if (!rate) {
      throw new Error(`缺少汇率: CNY→${pricing.currency}，无法计算费用`);
    }
    const multiplier = 1 / rate; // e.g. 1 CNY = 0.1482 USD → 1 USD = 1/0.1482 CNY
    inputCost *= multiplier;
    totalCost *= multiplier;
    savings *= multiplier;
  }

  // outputCost 在 totalCost 中已包含，但要单独返回 output_cost
  // 所以也要换算 output_cost
  const finalOutputCost = pricing.currency && pricing.currency !== 'CNY'
    ? outputCost * (1 / (rates?.[`CNY→${pricing.currency}`] || 1))
    : outputCost;

  return {
    input_cost: Math.round(inputCost * 1e8) / 1e8,
    output_cost: Math.round(finalOutputCost * 1e8) / 1e8,
    total_cost: Math.round(totalCost * 1e8) / 1e8,
    cache_savings: Math.round(savings * 1e8) / 1e8,
  };
}
```

Hmm, the savings also need conversion. Let me be cleaner about this:

```ts
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
  let totalCost = inputCost + outputCost;
  let savings = (cacheRead / 1_000_000) * (pricing.input_price - pricing.cache_input_price);
  // outputCost 也需要单独换算（它是 CostResult 的独立字段）
  let finalOutputCost = outputCost;

  // 非 CNY 定价 → 换算为 CNY
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
```

This is clean. Let me use this in the plan.

Actually wait — I need to be more careful with the plan. The plan format says I should include actual code. Let me just write the plan steps with the correct code. Let me continue.

- [ ] **Step 3: 修改 `calculateCost`**

Replace the function in `proxy/pricing.ts`:

```ts
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
```

- [ ] **Step 4: 运行测试确认通过**

```bash
npx vitest run tests/pricing.test.ts
```
Expected: ALL tests PASS.

- [ ] **Step 5: Commit**

```bash
git add proxy/pricing.ts tests/pricing.test.ts
git commit -m "feat: calculateCost 支持非 CNY 定价按汇率换算为 CNY 入库"
```

---

### Task 4: 改造 `proxy/recorder.ts` — processRecord 传入 rates

**Files:**
- Modify: `proxy/recorder.ts:44-76`

**Interfaces:**
- Consumes: `getRates()` from Task 1, `calculateCost` 新签名 from Task 3

- [ ] **Step 1: 修改 processRecord 中 calculateCost 调用**

在 `proxy/recorder.ts` 顶部 import 行追加：

```ts
import { getRates } from './rates.js';
```

修改 `processRecord` 函数中的费用计算段（约第 70 行）：

```ts
// 2. 定价匹配 + 费用计算
if (record.prompt_tokens != null || record.output_tokens != null) {
  const allPricing = listPricing() as Pricing[];
  const pricing = matchPricing(record.provider, record.model, allPricing);
  if (pricing) {
    const tokens: NormalizedTokens = {
      prompt_tokens: record.prompt_tokens,
      output_tokens: record.output_tokens,
      cache_read_tokens: record.cache_read_tokens,
      cache_write_tokens: record.cache_write_tokens,
      uncached_input: record.uncached_input,
    };
    const rates = getRates();
    const costs = calculateCost(tokens, pricing, rates);
    record.input_cost = costs.input_cost;
    record.output_cost = costs.output_cost;
    record.total_cost = costs.total_cost;
    record.cache_savings = costs.cache_savings;
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add proxy/recorder.ts
git commit -m "feat: recorder 调用 calculateCost 时传入汇率"
```

---

### Task 5: 改造 `proxy/router.ts` — API 端点变更

**Files:**
- Modify: `proxy/router.ts:161-267`

**Interfaces:**
- Consumes: `getRates()`, `getRatesUpdatedAt()`, `refreshRates()` from Task 1
- Produces: `GET /api/config` 返回 `rates` + `rates_updated_at`；`POST /api/rates/refresh`；`POST /api/pricing` 传 `currency`

- [ ] **Step 1: 添加 import**

在 `proxy/router.ts` 顶部 import 行追加：

```ts
import { getRates, getRatesUpdatedAt, refreshRates } from './rates.js';
```

- [ ] **Step 2: 扩展 GET /api/config（约第 256 行）**

将返回对象改为：

```ts
app.get('/api/config', async () => ({
  port: PORT, data_dir: DATA_DIR,
  session_timeout_sec: SESSION_TIMEOUT_SEC,
  auto_cleanup_days: AUTO_CLEANUP_DAYS,
  currency: getSetting('currency') || 'CNY',
  rates: getRates(),
  rates_updated_at: getRatesUpdatedAt() || null,
}));
```

- [ ] **Step 3: 新增 POST /api/rates/refresh**

在 `// Config` 段之后、`}` 结束函数之前添加：

```ts
// Rates
app.post('/api/rates/refresh', async () => {
  try {
    const result = await refreshRates();
    return { ok: true, ...result };
  } catch (err: any) {
    return { ok: false, error: err?.message || '刷新失败', rates: getRates(), rates_updated_at: getRatesUpdatedAt() };
  }
});
```

- [ ] **Step 4: POST /api/pricing 传递 currency（约第 210 行）**

将：

```ts
const { provider, model, input_price, cache_input_price, output_price } = req.body as any;
const id = upsertPricing(provider, model, input_price, cache_input_price, output_price);
```

改为：

```ts
const { provider, model, input_price, cache_input_price, output_price, currency } = req.body as any;
const id = upsertPricing(provider, model, input_price, cache_input_price, output_price, currency || 'CNY');
```

同样修改 `POST /api/pricing/default`（第 219 行）中 `upsertPricing` 的调用，`default-pricing.json` 中的条目无 `currency` 字段，默认 `'CNY'`（无需修改，因为 `upsertPricing` 的 `currency` 参数是可选的）。

- [ ] **Step 5: Commit**

```bash
git add proxy/router.ts
git commit -m "feat: API — /api/config 返回汇率、/api/rates/refresh 强制刷新、/api/pricing 支持 currency"
```

---

### Task 6: 改造 `proxy/main.ts` — 启动时初始化汇率

**Files:**
- Modify: `proxy/main.ts:33-36`

**Interfaces:**
- Consumes: `scheduleDailyRefresh()` from Task 1

- [ ] **Step 1: 添加 import**

在 `proxy/main.ts` 顶部 import 行追加：

```ts
import { scheduleDailyRefresh } from './rates.js';
```

- [ ] **Step 2: 在 createApp 中调用**

在 `await initDb();` 之后添加：

```ts
scheduleDailyRefresh();
```

完整代码段：

```ts
export async function createApp(): Promise<FastifyInstance> {
  await initDb();
  scheduleDailyRefresh();
  await importDefaultPricingIfEmpty();
  startRecorder();
  setEnqueueRef(enqueueRecord);
  // ...
}
```

- [ ] **Step 3: Commit**

```bash
git add proxy/main.ts
git commit -m "feat: 启动时初始化汇率定时刷新调度"
```

---

### Task 7: 改造前端 `currency.tsx` — formatCost + Context 类型扩展

**Files:**
- Modify: `webui/src/lib/currency.tsx`

**Interfaces:**
- Produces:
  - `CurrencyContextValue` 新类型 `{ currency: CurrencyKey; rates?: Record<string, number>; ratesUpdatedAt?: string }`
  - `useCurrency()` 返回 `CurrencyContextValue`（不再是裸 `CurrencyKey`）
  - `formatCost(value, currency, rates?)` — 新增 rates 参数

- [ ] **Step 1: 替换 `webui/src/lib/currency.tsx` 全文**

```tsx
import { createContext, useContext } from 'react';

export const CURRENCIES: Record<string, { symbol: string; label: string }> = {
  CNY: { symbol: '￥', label: 'CNY' },
  USD: { symbol: '$', label: 'USD' },
  EUR: { symbol: '€', label: 'EUR' },
  JPY: { symbol: '¥', label: '円' },
  GBP: { symbol: '£', label: 'GBP' },
};

export type CurrencyKey = keyof typeof CURRENCIES;

export interface CurrencyContextValue {
  currency: CurrencyKey;
  rates?: Record<string, number>;
  ratesUpdatedAt?: string;
}

export const CurrencyContext = createContext<CurrencyContextValue>({ currency: 'CNY' });

export function useCurrency(): CurrencyContextValue {
  return useContext(CurrencyContext);
}

export function formatCost(value: number, currency: CurrencyKey, rates?: Record<string, number>): string {
  let displayValue = value;
  if (rates && currency !== 'CNY') {
    const rate = rates[`CNY→${currency}`];
    if (rate) {
      displayValue = value * rate;
    }
  }
  const c = CURRENCIES[currency] || CURRENCIES.CNY;
  return `${c.symbol}${displayValue.toFixed(4)} ${c.label}`;
}
```

- [ ] **Step 2: 更新所有受影响组件 — 解构 useCurrency() 返回值**

现在 `useCurrency()` 返回 `{ currency, rates, ratesUpdatedAt }` 而非裸字符串。需要更新所有使用方。在此 Task 中先更新签名层，具体组件适配在 Task 10-12 中完成。

先确认项目能编译（会有类型错误，因为其他组件还在用旧 API）：

```bash
cd webui && npx tsc --noEmit 2>&1 | head -30
```

Expected: 类型错误（组件还在用 `const currency = useCurrency()` 当作字符串），但 currency.tsx 本身无编译错误。这些错误将在后续 Task 修复。

- [ ] **Step 3: Commit**

```bash
git add webui/src/lib/currency.tsx
git commit -m "feat: CurrencyContext 扩展 rates 下发，formatCost 支持汇率换算"
```

---

### Task 8: 改造前端 `CurrencyProvider.tsx` — Context 下发 rates

**Files:**
- Modify: `webui/src/components/CurrencyProvider.tsx`

- [ ] **Step 1: 替换 `CurrencyProvider.tsx`**

```tsx
import { useQuery } from '@tanstack/react-query';
import * as api from '../api/client';
import { CurrencyContext, type CurrencyKey, type CurrencyContextValue } from '../lib/currency';
import type { ReactNode } from 'react';

export default function CurrencyProvider({ children }: { children: ReactNode }) {
  const { data: config } = useQuery({ queryKey: ['config'], queryFn: api.getConfig, staleTime: 60000 });

  const value: CurrencyContextValue = {
    currency: (config?.currency as CurrencyKey) || 'CNY',
    rates: config?.rates as Record<string, number> | undefined,
    ratesUpdatedAt: config?.rates_updated_at as string | undefined,
  };

  return (
    <CurrencyContext.Provider value={value}>
      {children}
    </CurrencyContext.Provider>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add webui/src/components/CurrencyProvider.tsx
git commit -m "feat: CurrencyProvider 从 /api/config 下发 rates 到 Context"
```

---

### Task 9: 改造前端 `api/client.ts` — 新增 refreshRates + 类型扩展

**Files:**
- Modify: `webui/src/api/client.ts`

- [ ] **Step 1: 在文件末尾（`// ── Config ──` 段之后）新增**

```ts
// ── Rates ──
export async function refreshRates() {
  return fetchJson('/rates/refresh', { method: 'POST' });
}
```

- [ ] **Step 2: Commit**

```bash
git add webui/src/api/client.ts
git commit -m "feat: 前端 API 客户端新增 refreshRates"
```

---

### Task 10: 改造 `Settings.tsx` — 汇率信息行 + 刷新按钮

**Files:**
- Modify: `webui/src/pages/Settings.tsx`

- [ ] **Step 1: 在 `CurrencySelector` 组件中解构 rates 和 ratesUpdatedAt**

找到 `CurrencySelector` 函数（约第 274 行），修改：

```tsx
function CurrencySelector() {
  const qc = useQueryClient();
  const { currency, ratesUpdatedAt } = useCurrency();
  const configMut = useMutation({
    mutationFn: (c: string) => api.updateConfig({ currency: c }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['config'] }),
  });

  const ratesMut = useMutation({
    mutationFn: () => api.refreshRates(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['config'] }),
  });

  const formatTime = (iso?: string) => {
    if (!iso) return '未知';
    try {
      const d = new Date(iso);
      return d.toLocaleString('zh-CN', { hour12: false });
    } catch { return iso; }
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3">
        <span className="text-xs text-gray-500">选择价格单位，页面上所有费用将同步切换：</span>
        <select
          className="text-sm border border-[#e5e5ea] rounded-lg px-3 py-1.5 bg-white focus:outline-none focus:ring-2 focus:ring-[#0071e3]"
          value={currency}
          onChange={e => configMut.mutate(e.target.value)}
        >
          {Object.entries(CURRENCIES).map(([key, val]) => (
            <option key={key} value={key}>{val.symbol} {key} ({val.label})</option>
          ))}
        </select>
      </div>
      <div className="flex items-center gap-2 text-xs text-gray-400">
        <span>汇率更新于 {formatTime(ratesUpdatedAt)}</span>
        <button
          onClick={() => ratesMut.mutate()}
          disabled={ratesMut.isPending}
          className="text-[#0071e3] hover:underline disabled:opacity-50"
        >
          {ratesMut.isPending ? '刷新中...' : '刷新'}
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 确认 import 中已包含 useMutation**

`Settings.tsx` 顶部已有 `useMutation` 的 import（用于其他 mutation），确认 `refreshRates` 已导入。

检查 Settings.tsx 顶部 import：需追加 `api` 已经引入（检查第 11 行附近），确认即可。

- [ ] **Step 3: Commit**

```bash
git add webui/src/pages/Settings.tsx
git commit -m "feat: Settings 页面新增汇率刷新时间显示和手动刷新按钮"
```

---

### Task 11: 改造 `PricingTable.tsx` — 币种下拉框

**Files:**
- Modify: `webui/src/components/PricingTable.tsx`

- [ ] **Step 1: form state 增加 currency 字段**

将第 28 行：

```tsx
const [form, setForm] = useState({ provider: '', model: '', input_price: 0, cache_input_price: 0, output_price: 0 });
```

改为：

```tsx
const [form, setForm] = useState({ provider: '', model: '', input_price: 0, cache_input_price: 0, output_price: 0, currency: 'CNY' as string });
```

- [ ] **Step 2: 在表单中添加币种下拉框**

在第 110 行"输出价"输入框和"添加"按钮之间插入：

```tsx
<div className="w-18">
  <div className="text-[10px] font-medium mb-1" style={{ color: '#646478' }}>币种</div>
  <select
    value={form.currency}
    onChange={e => setForm({ ...form, currency: (e.target as HTMLSelectElement).value })}
    className="w-full px-2 py-1.5 text-[11px]"
  >
    {Object.keys(CURRENCIES).map(k => (
      <option key={k} value={k}>{k}</option>
    ))}
  </select>
</div>
```

- [ ] **Step 3: addMut.mutationFn 传递 currency**

将第 21 行：

```tsx
mutationFn: (f: any) => api.upsertPricing(f),
```

改为：

```tsx
mutationFn: (f: any) => api.upsertPricing({ ...f, currency: f.currency || 'CNY' }),
```

- [ ] **Step 4: 用定价行自身的币种符号替换全局符号**

删除第 8 行 `const sym = CURRENCIES[currency].symbol;`（不再需要统一的 display currency 符号替换定价行）。

将第 64 行 `{sym}{p.input_price.toFixed(3)}` 改为：

```tsx
{CURRENCIES[p.currency || 'CNY']?.symbol || '￥'}{p.input_price.toFixed(3)}
```

同理修改第 68 行（缓存价）和第 72 行（输出价）的 `{sym}` → `{CURRENCIES[p.currency || 'CNY']?.symbol || '￥'}`。

- [ ] **Step 5: 列表展示中显示币种列**

在表头第 51 行之后（`<th className="w-10" />` 之前）插入币种列表头：

在 `<thead>` 中，`<th className="w-10" />` 前添加：

```tsx
<th className="text-right py-2.5 px-3 font-medium text-[11px] uppercase tracking-wider" style={{ color: '#646478' }}>币种</th>
```

在 `<tbody>` 的每行中（第 74 行 `</td>` 后 `<td className="py-2.5 text-center">` 前）添加：

```tsx
<td className="py-2.5 px-3 text-right">
  <span className="text-[10px] font-mono" style={{ color: '#4a4a5a' }}>{p.currency || 'CNY'}</span>
</td>
```

- [ ] **Step 5: upsertPricing API 类型扩展**

修改 `webui/src/api/client.ts` 中 `upsertPricing` 的参数类型：

```tsx
export async function upsertPricing(p: { provider: string; model: string; input_price: number; cache_input_price: number; output_price: number; currency?: string }) {
  return fetchJson('/pricing', { method: 'POST', body: JSON.stringify(p) });
}
```

- [ ] **Step 6: Commit**

```bash
git add webui/src/components/PricingTable.tsx webui/src/api/client.ts
git commit -m "feat: PricingTable 支持录入和展示币种"
```

---

### Task 12: 改造其余 6 个前端组件 — 传入 rates

**Files:**
- Modify: `webui/src/components/KpiCards.tsx`
- Modify: `webui/src/components/CostPieChart.tsx`
- Modify: `webui/src/components/CallTimeline.tsx`
- Modify: `webui/src/components/CallDetailPanel.tsx`
- Modify: `webui/src/pages/Dashboard.tsx`
- Modify: `webui/src/pages/SessionDetail.tsx`

**变更模式**：每个文件将 `const currency = useCurrency()` 改为 `const { currency, rates } = useCurrency()`，并将 `formatCost(x, currency)` 改为 `formatCost(x, currency, rates)`。

- [ ] **Step 1: KpiCards.tsx**

```tsx
export default function KpiCards({ totalCalls, totalCost, totalTokens, cacheHitRate }: {
  totalCalls: number; totalCost: number; totalTokens: number; cacheHitRate?: number;
}) {
  const { currency, rates } = useCurrency();
  const cards = [
    { label: '总调用', value: totalCalls.toLocaleString(), icon: 'M13 7h8m0 0v8m0-8l-8 8-4-4-6 6', color: '#6366f1' },
    { label: '总费用', value: formatCost(totalCost, currency, rates), icon: 'M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z', color: '#f59e0b' },
    { label: '总 Token', value: `${(totalTokens / 1000).toFixed(1)}K`, icon: 'M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z', color: '#22c55e' },
    { label: '缓存命中率', value: cacheHitRate != null ? `${(cacheHitRate * 100).toFixed(0)}%` : '--', icon: 'M4 7v10c0 2 1 3 3 3h10c2 0 3-1 3-3V7M4 7c0-2 1-3 3-3h10c2 0 3 1 3 3M4 7h16M9 3v4m6-4v4', color: '#8b5cf6' },
  ];
  // ... rest unchanged
}
```

- [ ] **Step 2: CostPieChart.tsx**

```tsx
export default function CostPieChart({ stats }: { stats: { key: string; total_cost: number }[] }) {
  const { currency, rates } = useCurrency();
  // ...
  <Tooltip formatter={(v: number) => formatCost(v, currency, rates)} />
```

- [ ] **Step 3: CallTimeline.tsx**

```tsx
export default function CallTimeline({ calls }: { calls: any[] }) {
  const { currency, rates } = useCurrency();
  // ...
  <span className="...">{c.total_cost > 0 ? formatCost(c.total_cost, currency, rates) : '--'}</span>
```

- [ ] **Step 4: CallDetailPanel.tsx**

将文件中 3 处 `formatCost(call.xxx, currency)` 全部改为 `formatCost(call.xxx, currency, rates)`：

```tsx
export default function CallDetailPanel({ call }: { call: any }) {
  const { currency, rates } = useCurrency();
  // 三处 formatCost 调用：
  // formatCost(call.input_cost, currency, rates)
  // formatCost(call.output_cost, currency, rates)
  // formatCost(call.total_cost, currency, rates)
  // formatCost(call.cache_savings, currency, rates) — 如果有的话
```

- [ ] **Step 5: Dashboard.tsx**

```tsx
const { currency, rates } = useCurrency();
// formatCost(totalCost, currency, rates)
// formatCost(totalCost / totalCalls, currency, rates)
// formatCost(s.total_cost, currency, rates)
```

- [ ] **Step 6: SessionDetail.tsx**

```tsx
const { currency, rates } = useCurrency();
// formatCost(s.total_cost, currency, rates)
```

- [ ] **Step 7: 验证编译通过**

```bash
cd webui && npx tsc --noEmit
```
Expected: No type errors.

- [ ] **Step 8: Commit**

```bash
git add webui/src/components/KpiCards.tsx webui/src/components/CostPieChart.tsx webui/src/components/CallTimeline.tsx webui/src/components/CallDetailPanel.tsx webui/src/pages/Dashboard.tsx webui/src/pages/SessionDetail.tsx
git commit -m "feat: 所有费用展示组件传入 rates 参数实现汇率换算"
```

---

### Task 13: 构建验证

**Files:** None (verification only)

- [ ] **Step 1: Debug 构建后端**

```bash
npx tsc -p proxy/tsconfig.json --noEmit
```
Expected: No errors.

- [ ] **Step 2: Debug 构建前端**

```bash
cd webui && npx tsc --noEmit
```
Expected: No errors.

- [ ] **Step 3: 运行全部单元测试**

```bash
npx vitest run tests/
```
Expected: ALL tests PASS.

- [ ] **Step 4: 启动服务做冒烟测试**

```bash
npx tsx proxy/main.ts --dev
```

然后手动验证：
1. `curl http://localhost:9400/api/config` 返回 `rates` 和 `rates_updated_at`
2. `curl -X POST http://localhost:9400/api/rates/refresh` 返回更新后的汇率
3. 打开浏览器 `http://localhost:9400`，Settings 页面显示汇率刷新时间
4. 新增一条 USD 定价 → 发起一次 API 调用 → Dashboard 显示费用（CNY 换算后）

- [ ] **Step 5: 停止服务**

```bash
# Ctrl+C
```
