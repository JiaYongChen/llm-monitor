/** 汇率模块 — Frankfurter API 拉取 + metadata 缓存 + 每日 09:30 (CST) 定时刷新 */
import { getSetting, setSetting } from './db.js';

// ── 兜底汇率（2026-08-06 Frankfurter 实时值，以 1 CNY 为基准） ──

export const FALLBACK_RATES: Record<string, number> = {
  'CNY→USD': 0.1482,
  'CNY→EUR': 0.1284,
  'CNY→JPY': 23.39,
  'CNY→GBP': 0.1100,
};

const FRANKFURTER_URL = 'https://api.frankfurter.dev/v1/latest?from=CNY&to=USD,EUR,JPY,GBP';

// ── 公开接口 ──

/** 获取当前汇率映射，优先读 metadata 缓存；缓存不可用（缺失或解析失败）时回退兜底汇率 */
export function getRates(): Record<string, number> {
  const cached = getSetting('exchange_rates');
  if (cached) {
    try {
      const parsed = JSON.parse(cached) as Record<string, number>;
      if (parsed && typeof parsed === 'object') return parsed;
    } catch { /* 缓存解析失败，回退兜底 */ }
  }
  return { ...FALLBACK_RATES };
}

/** 获取汇率更新时间（Unix 毫秒时间戳），尚未刷新时返回 null */
export function getRatesUpdatedAt(): number | null {
  const v = getSetting('rates_updated_at');
  if (!v) return null;
  // 兼容旧版 ISO 字符串格式
  const parsed = parseInt(v);
  if (!isNaN(parsed) && parsed > 1_000_000_000_000) {
    // 毫秒时间戳（> 2001-09-09）：直接返回
    return parsed;
  }
  if (!isNaN(parsed) && parsed > 1_000_000_000) {
    // 秒级时间戳（> 2001-09-09）：转为毫秒
    return parsed * 1000;
  }
  // 尝试解析 ISO 字符串
  const fromISO = Date.parse(v);
  return isNaN(fromISO) ? null : fromISO;
}

/** 手动拉取汇率并写入 metadata 缓存（exchange_rates + rates_updated_at） */
export async function refreshRates(): Promise<{ rates: Record<string, number>; updatedAt: number }> {
  let rates: Record<string, number> = { ...FALLBACK_RATES };

  try {
    // 请求超时 10s
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const res = await fetch(FRANKFURTER_URL, { signal: controller.signal });
      if (!res.ok) throw new Error(`Frankfurter HTTP ${res.status}`);

      const data = (await res.json()) as { base: string; rates: Record<string, number> };
      // 响应 rates 转换为内部格式（如 { "CNY→USD": 0.14817 }），值保留 8 位小数
      rates = {};
      for (const [currency, rate] of Object.entries(data.rates)) {
        rates[`CNY→${currency}`] = Math.round(rate * 1e8) / 1e8;
      }
    } finally {
      clearTimeout(timeout);
    }
  } catch (err) {
    // API 失败 → 警告 + 读缓存；缓存为空则保持兜底汇率
    console.warn('汇率刷新失败，使用缓存/兜底值:', err);
    const cached = getSetting('exchange_rates');
    if (cached) {
      try {
        rates = JSON.parse(cached) as Record<string, number>;
      } catch { /* 缓存解析失败，保持兜底 */ }
    }
  }

  setSetting('exchange_rates', JSON.stringify(rates));
  const updatedAt = Date.now();
  setSetting('rates_updated_at', String(updatedAt));

  return { rates, updatedAt };
}

// ── 定时调度 ──

let refreshTimer: ReturnType<typeof setTimeout> | null = null;

/** 计算到下一个北京时间 09:30 的毫秒数（基于 UTC+8 计算，不依赖系统时区） */
function msUntilNext0930CST(): number {
  const now = new Date();
  const cstNow = new Date(now.getTime() + 8 * 60 * 60 * 1000); // 当前 UTC 时间转为 CST (UTC+8)
  const target = new Date(cstNow);
  target.setUTCHours(9, 30, 0, 0); // 今日 09:30 CST

  if (target <= cstNow) {
    target.setUTCDate(target.getUTCDate() + 1); // 已过 09:30 → 顺延一天
  }

  return target.getTime() - cstNow.getTime();
}

/** 启动每日定时刷新：立即拉取一次，之后每天北京时间 09:30 刷新（initDb 后调用一次） */
export function scheduleDailyRefresh(): void {
  // 启动时立即拉取一次
  refreshRates().then(({ rates, updatedAt }) => {
    console.log(`汇率已初始化 (${new Date(updatedAt).toLocaleString('zh-CN', { hour12: false })}):`, rates);
  }).catch(() => {});

  // 计算到下次 09:30 的间隔并设置定时器，触发后设置下一个 24h 的定时器（届时重新调度）
  const schedule = () => {
    if (refreshTimer) clearTimeout(refreshTimer);
    const delay = msUntilNext0930CST();
    console.log(`下次汇率刷新: ${Math.round(delay / 1000 / 60)} 分钟后`);
    refreshTimer = setTimeout(() => {
      refreshRates().then(({ rates, updatedAt }) => {
        console.log(`汇率已刷新 (${new Date(updatedAt).toLocaleString('zh-CN', { hour12: false })}):`, rates);
      }).catch(() => {}); // 关闭后 DB 不可用，静默忽略
      refreshTimer = setTimeout(schedule, 24 * 60 * 60 * 1000);
    }, delay);
  };

  // 延迟 2 秒安排首个定时器，避免与启动时的首次拉取冲突
  initTimer = setTimeout(schedule, 2000);
}

let initTimer: ReturnType<typeof setTimeout> | null = null;

/** 停止每日定时刷新（关闭服务器时调用） */
export function stopDailyRefresh(): void {
  if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
  if (initTimer) { clearTimeout(initTimer); initTimer = null; }
}
