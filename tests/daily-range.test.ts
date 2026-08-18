/** getDailyStats 季度/年度范围窗口边界与粒度测试 — 月/周桶用 vi 固定"现在"，任意时刻可跑 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { initDb, closeDb, getDailyStats, upsertHourlyStat } from '../proxy/db.js';
import { createTempDb } from './setup.js';

const tmp = createTempDb();

beforeAll(async () => { await initDb(tmp.dbPath); });
afterAll(() => { closeDb(); tmp.cleanup(); });
afterEach(() => { vi.useRealTimers(); });

/** 固定"现在"：2026-08-18 12:00 UTC（周二；UTC+8 目标时区下为当天 20:00，仍属 8 月 18 日） */
const NOW_MS = Date.UTC(2026, 7, 18, 12, 0, 0);
/** 目标时区（UTC+8）午夜的 UTC 毫秒（本地日期组件 = 目标时区日期，与旧版 dayMs 同法） */
const dayMs = (y: number, m: number, d: number) => Date.UTC(y, m, d);

describe('getDailyStats 年档位（按月聚合）', () => {
  it('thisYear：月标签、同月多天合并、当年行命中', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    upsertHourlyStat('Ymthis', 'm1', 'codex', 0.01, 1, 10, 20, 30, dayMs(2026, 0, 15));
    upsertHourlyStat('Ymthis', 'm2', 'codex', 0.01, 1, 10, 20, 30, dayMs(2026, 0, 20));
    upsertHourlyStat('Ymthis', 'm3', 'codex', 0.01, 1, 10, 20, 30, dayMs(2026, 7, 18));
    const rows = getDailyStats('thisYear', 'Ymthis');
    const jan = rows.find((r: any) => r.date === '2026-01');
    expect(jan).toBeDefined();
    expect(jan!.count).toBe(2);   // 1 月两行合并进同一月桶
    expect(rows.find((r: any) => r.date === '2026-08')).toBeDefined();
    expect(rows.every((r: any) => /^\d{4}-\d{2}$/.test(r.date))).toBe(true);
  });

  it('lastYear：去年行命中、今年行排除', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    upsertHourlyStat('Ymlast', 'm1', 'codex', 0.01, 1, 10, 20, 30, dayMs(2025, 11, 31));
    upsertHourlyStat('Ymlast', 'm2', 'codex', 0.01, 1, 10, 20, 30, dayMs(2026, 7, 18));
    const rows = getDailyStats('lastYear', 'Ymlast');
    expect(rows.find((r: any) => r.date === '2025-12')).toBeDefined();
    expect(rows.find((r: any) => r.date === '2026-08')).toBeUndefined();
  });
});

describe('getDailyStats 季档位（按 ISO 周聚合）', () => {
  it('thisQuarter：周标签、同周多天合并、首周只含季内数据', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    // 同一 ISO 周两天（2026-08-17 周一 / 08-18 周二）→ 合并进 '2026-W34'
    upsertHourlyStat('Wkthis', 'm1', 'codex', 0.01, 1, 10, 20, 30, dayMs(2026, 7, 17));
    upsertHourlyStat('Wkthis', 'm2', 'codex', 0.01, 1, 10, 20, 30, dayMs(2026, 7, 18));
    // W27（起于 2026-06-29 周一）：7-01 周三在 Q3 内、6-30 周二在 Q2 外 → 首周桶只含季内数据
    upsertHourlyStat('Wkthis', 'm3', 'codex', 0.01, 1, 10, 20, 30, dayMs(2026, 6, 1));
    upsertHourlyStat('Wkthis', 'm4', 'codex', 0.01, 1, 10, 20, 30, dayMs(2026, 5, 30));
    const rows = getDailyStats('thisQuarter', 'Wkthis');
    const w34 = rows.find((r: any) => r.date === '2026-W34');
    expect(w34).toBeDefined();
    expect(w34!.count).toBe(2);
    const w27 = rows.find((r: any) => r.date === '2026-W27');
    expect(w27).toBeDefined();
    expect(w27!.count).toBe(1);   // 6-30（Q2）被窗口裁剪
    expect(rows.every((r: any) => /^\d{4}-W\d{2}$/.test(r.date))).toBe(true);
  });

  it('lastQuarter：上季周标签命中、本季行排除', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    upsertHourlyStat('Wklast', 'm1', 'codex', 0.01, 1, 10, 20, 30, dayMs(2026, 5, 30)); // 6-30 周二，W27（Q2 末日所在周）
    upsertHourlyStat('Wklast', 'm2', 'codex', 0.01, 1, 10, 20, 30, dayMs(2026, 7, 18)); // 本季行 → 排除
    const rows = getDailyStats('lastQuarter', 'Wklast');
    expect(rows.find((r: any) => r.date === '2026-W27')).toBeDefined();
    expect(rows.find((r: any) => r.date === '2026-W34')).toBeUndefined();
  });

  it('跨年季：lastQuarter 的 ISO 年与周号正确（%G 维度）', () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 1, 15, 12, 0, 0)); // 2026-02-15 → 本季度 Q1，lastQuarter = 2025 Q4
    upsertHourlyStat('Wkcross', 'm1', 'codex', 0.01, 1, 10, 20, 30, dayMs(2025, 11, 28)); // 周日 → 2025-W52
    upsertHourlyStat('Wkcross', 'm2', 'codex', 0.01, 1, 10, 20, 30, dayMs(2025, 11, 29)); // 周一 → 2026-W01（ISO 年跨年）
    upsertHourlyStat('Wkcross', 'm3', 'codex', 0.01, 1, 10, 20, 30, dayMs(2026, 1, 10));  // 本季行 → 排除
    const rows = getDailyStats('lastQuarter', 'Wkcross');
    expect(rows.find((r: any) => r.date === '2025-W52')).toBeDefined();
    expect(rows.find((r: any) => r.date === '2026-W01')).toBeDefined();
    expect(rows.find((r: any) => r.date === '2026-W07')).toBeUndefined();
  });
});

describe('getDailyStats 小时/天档位回归', () => {
  it('today / 7d 范围不含未来小时（时钟偏差防御）', () => {
    const pad = (n: number) => String(n).padStart(2, '0');
    const futureMs = Date.now() + 48 * 3600 * 1000;
    const futureHourMs = Math.floor(futureMs / 3600000) * 3600000;
    const shifted = new Date(futureHourMs + 8 * 3600000);   // 标签按查询端 tzOffset（UTC+8）重算
    const futureHourLabel = `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())} ${pad(shifted.getUTCHours())}:00`;
    const futureDayLabel = `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
    upsertHourlyStat('OpenAI', 'm-future', 'codex', 0.05, 1, 50, 80, 20, futureMs);
    const todayRows = getDailyStats('today', 'OpenAI');
    expect(todayRows.find((r: any) => r.date === futureHourLabel)).toBeUndefined();
    const weekRows = getDailyStats('7d', 'OpenAI');
    expect(weekRows.find((r: any) => r.date === futureDayLabel)).toBeUndefined();
  });
});
