# 汇率换算功能 — 设计文档

**日期**：2026-08-07
**状态**：已确认

---

## 1. 目标

为 llm-monitor 实现真正的多币种汇率换算，替换当前仅切换货币符号/标签的伪实现。

---

## 2. 架构概览

```
┌─────────────────────────────────────────────────────┐
│  前端 (Web UI)                                       │
│  ┌──────────────┐    ┌─────────────────────────────┐│
│  │ 货币选择器    │───▶│ formatCost(value, currency,  ││
│  │ (Settings)   │    │   rates)  = 显示换算后金额    ││
│  └──────────────┘    └─────────────────────────────┘│
└──────────────────────┬──────────────────────────────┘
                       │ GET /api/config (含 rates)
┌──────────────────────┴──────────────────────────────┐
│  后端 (Proxy)                                        │
│  ┌────────────┐  ┌──────────┐  ┌──────────────────┐ │
│  │ 汇率缓存    │  │ calculate│  │ /api/config      │ │
│  │ (定时刷新)  │  │ Cost     │  │ 返回 rates 给前端 │ │
│  │            │  │ (→ CNY)  │  │                  │ │
│  └────────────┘  └──────────┘  └──────────────────┘ │
│                                                       │
│  ┌──────────────────────────────────────────────────┐│
│  │ SQLite                                           ││
│  │ • calls: 费用统一 CNY                            ││
│  │ • sessions: total_cost 统一 CNY                  ││
│  │ • pricing: currency 字段标记录入币种,原样展示     ││
│  │ • metadata: 汇率缓存 + 显示币种偏好               ││
│  └──────────────────────────────────────────────────┘│
└──────────────────────────────────────────────────────┘
```

**核心原则**：
- 数据库费用字段统一以 **CNY（元）** 存储
- 定价表 `pricing.currency` 标记录入时的原始币种（原样展示，不换算）
- 如果定价币种非 CNY，`calculateCost` 入库前先换算为 CNY
- 前端展示从 CNY 按用户偏好币种 + 汇率换算显示

---

## 3. 汇率模块 — `proxy/rates.ts`（新增）

### 3.1 数据源

使用 [Frankfurter API](https://www.frankfurter.dev)（免费、无需 API Key、HTTPS）：

- 请求：`GET https://api.frankfurter.dev/v1/latest?from=CNY&to=USD,EUR,JPY,GBP`
- 响应：`{ "base": "CNY", "rates": { "USD": 0.14817, "EUR": 0.12837, ... } }`

### 3.2 刷新策略

- **启动时**：立即拉取一次
- **定时刷新**：每天北京时间 09:30（`0 30 9 * * *` Asia/Shanghai 等效）
  - 启动时计算到下次 09:30 的毫秒间隔，设置一次性 `setTimeout`
  - 回调执行后立即设置下一个 24h 后的 `setTimeout`
- **手动刷新**：`POST /api/rates/refresh` 端点

### 3.3 缓存

写入 `metadata` 表：

| key | value |
|---|---|
| `exchange_rates` | `{"CNY→USD":0.1482,"CNY→EUR":0.1284,"CNY→JPY":23.39,"CNY→GBP":0.1100}` |
| `rates_updated_at` | `2026-08-07T09:30:00+08:00`（ISO 8601） |

### 3.4 容错

| 场景 | 处理 |
|---|---|
| API 超时/网络错误 | 记录日志（console.warn），使用上次缓存值 |
| 从未成功过（无缓存） | 使用硬编码兜底汇率 |
| 某币种不在汇率映射中 | `formatCost` 回退 1:1 显示 |

### 3.5 兜底汇率

硬编码于 `proxy/rates.ts`，以 1 CNY 为基准：

| 币种 | 汇率 (1 CNY ≈) |
|---|---|
| USD | 0.1482 |
| EUR | 0.1284 |
| JPY | 23.39 |
| GBP | 0.1100 |

### 3.6 导出接口

```ts
/** 获取当前汇率映射 { "CNY→USD": 0.1482, ... } */
export function getRates(): Record<string, number>;

/** 启动定时刷新调度（initDb 后调用一次） */
export function scheduleDailyRefresh(): void;

/** 手动强制刷新汇率（供 API 调用） */
export async function refreshRates(): Promise<{ rates: Record<string, number>; updatedAt: string }>;
```

---

## 4. 数据库变更

### 4.1 现有表

**无需 ALTER**。`pricing` 表的 `currency` 列已存在（默认 `'CNY'`），现在开始实际读写。

`calls` 和 `sessions` 的费用字段继续存 CNY（REAL），不变。

### 4.2 新增 metadata 行

| key | value 示例 |
|---|---|
| `exchange_rates` | `{"CNY→USD":0.1482,"CNY→EUR":0.1284,"CNY→JPY":23.39,"CNY→GBP":0.1100}` |
| `rates_updated_at` | `2026-08-07T09:30:00.000+08:00` |

---

## 5. 后端变更

### 5.1 `proxy/pricing.ts` — `calculateCost` 改造

新增 `rates` 参数。如果 `pricing.currency !== 'CNY'`，按汇率将费用转为 CNY 后返回：

```ts
export function calculateCost(
  tokens: NormalizedTokens,
  pricing: Pricing,
  rates: Record<string, number>,
): CostResult {
  // 原有计算逻辑不变
  // 如果 pricing.currency !== 'CNY'：
  //   rate = rates["CNY→" + pricing.currency] 的倒数 (1 CNY = X USD → 1 USD = 1/X CNY)
  //   各 cost 字段 *= rate，再 round 到 8 位小数
}
```

### 5.2 `proxy/router.ts` — API 变更

**`GET /api/config`**：返回中新增 `rates` 和 `rates_updated_at`：

```json
{
  "port": 3456,
  "currency": "CNY",
  "rates": { "CNY→USD": 0.1482, "CNY→EUR": 0.1284, "CNY→JPY": 23.39, "CNY→GBP": 0.1100 },
  "rates_updated_at": "2026-08-07T09:30:00+08:00",
  ...
}
```

**`POST /api/pricing`**：`upsertPricing` 读写 `currency` 字段，`unit` 字段继续忽略。

**`POST /api/rates/refresh`**：新增端点，调用 `refreshRates()` 并返回结果。

### 5.3 `proxy/db.ts` — upsertPricing 改造

当前 `upsertPricing` 函数签名不接收 `currency`。改为：

```ts
export function upsertPricing(
  provider: string, model: string,
  inputPrice: number, cacheInputPrice: number, outputPrice: number,
  currency?: string,  // 新增，默认 'CNY'
): number
```

INSERT/UPDATE SQL 包含 `currency` 列。

---

## 6. 前端变更

### 6.1 `webui/src/lib/currency.tsx`

`formatCost` 签名扩展：

```ts
export function formatCost(
  value: number,
  currency: CurrencyKey,
  rates?: Record<string, number>,
): string {
  if (rates && currency !== 'CNY') {
    const rate = rates["CNY→" + currency];
    if (rate) value = value * rate;
  }
  const c = CURRENCIES[currency] || CURRENCIES.CNY;
  return `${c.symbol}${value.toFixed(4)} ${c.label}`;
}
```

### 6.2 `webui/src/components/CurrencyProvider.tsx`

从 `/api/config` 中同时读取 `currency` 和 `rates`，扩展 Context：

```ts
interface CurrencyContextValue {
  currency: CurrencyKey;
  rates?: Record<string, number>;
  ratesUpdatedAt?: string;
}
```

### 6.3 `webui/src/pages/Settings.tsx`

货币选择器下方新增汇率信息行：

- 显示 `"汇率更新于 2026-08-07 09:30"`
- 旁边"刷新"按钮调用 `POST /api/rates/refresh` → 成功后 invalidate `['config']` query

### 6.4 `webui/src/components/PricingTable.tsx`

定价新增/编辑表单增加币种下拉框（从 `CURRENCIES` 取选项），默认 `CNY`。

### 6.5 其余组件

所有调用 `formatCost` 的组件（7 个）只需通过 Context 传入新增的 `rates` 参数，无需结构性改动：

- `Dashboard.tsx`
- `SessionDetail.tsx`
- `KpiCards.tsx`
- `CostPieChart.tsx`
- `CallTimeline.tsx`
- `CallDetailPanel.tsx`

### 6.6 `webui/src/api/client.ts`

新增：

```ts
export async function refreshRates() {
  return fetchJson('/rates/refresh', { method: 'POST' });
}
```

`getConfig` 返回类型扩展 `rates` 和 `rates_updated_at` 字段。

---

## 7. 错误处理矩阵

| 场景 | 处理 |
|---|---|
| 汇率 API 超时/网络错误 | `console.warn` 日志，保留上次缓存；无缓存用兜底汇率 |
| 兜底汇率也没有对应币种 | `formatCost` 回退 1:1 显示，console.warn |
| `calculateCost` 时定价币种无汇率 | 抛出错误，拒绝入库（调用方捕获并返回 500） |
| `POST /api/rates/refresh` 失败 | 返回 `{ error: string }` + 当前缓存状态，HTTP 200（不抛 500） |
| 服务器重启导致错过 09:30 | `scheduleDailyRefresh` 启动时重新计算间隔，如果当前已过 09:30 则在下一个 09:30 触发 |

---

## 8. 测试策略

### 8.1 单元测试 — `tests/rates.test.ts`（新增）

- `getRates()` 从 metadata 正确解析汇率
- 兜底汇率覆盖所有 4 个非 CNY 币种
- 定时调度计算：`scheduleDailyRefresh` 的间隔在合理范围内（09:30 前应 > 0，09:30 后应在 24h 内）
- `refreshRates()` 成功写入 metadata（mock fetch）

### 8.2 扩展 — `tests/pricing.test.ts`

- 非 CNY 定价 + 汇率转换 → 费用正确转为 CNY
- CNY 定价 + 汇率转换 → 费用不变（恒等）
- 定价币种无对应汇率 → 抛出错误

### 8.3 集成测试 — `tests/start-and-test.ts`

- 启动服务后 `GET /api/config` 返回 `rates` 字段
- `POST /api/rates/refresh` 返回成功
- 新建非 CNY 定价 → 发起调用 → calls 表中 total_cost 为 CNY 值

---

## 9. 实施文件清单

| 文件 | 操作 |
|---|---|
| `proxy/rates.ts` | **新增** — 汇率获取、缓存、定时刷新 |
| `proxy/pricing.ts` | **修改** — `calculateCost` 支持汇率换算 |
| `proxy/router.ts` | **修改** — `/api/config` 扩展、`/api/rates/refresh` 新增、`/api/pricing` 支持 currency |
| `proxy/db.ts` | **修改** — `upsertPricing` 支持 currency 参数 |
| `webui/src/lib/currency.tsx` | **修改** — `formatCost` 支持 rates |
| `webui/src/components/CurrencyProvider.tsx` | **修改** — Context 扩展 rates 下发 |
| `webui/src/pages/Settings.tsx` | **修改** — 汇率信息行 + 刷新按钮 |
| `webui/src/components/PricingTable.tsx` | **修改** — 币种下拉框 |
| `webui/src/api/client.ts` | **修改** — 新增 `refreshRates`、扩展返回类型 |
| `webui/src/components/KpiCards.tsx` | **修改** — 传入 rates |
| `webui/src/components/CostPieChart.tsx` | **修改** — 传入 rates |
| `webui/src/components/CallTimeline.tsx` | **修改** — 传入 rates |
| `webui/src/components/CallDetailPanel.tsx` | **修改** — 传入 rates |
| `webui/src/pages/Dashboard.tsx` | **修改** — 传入 rates |
| `webui/src/pages/SessionDetail.tsx` | **修改** — 传入 rates |
| `tests/rates.test.ts` | **新增** — 汇率模块单元测试 |
| `tests/pricing.test.ts` | **修改** — 扩展非 CNY 定价用例 |
