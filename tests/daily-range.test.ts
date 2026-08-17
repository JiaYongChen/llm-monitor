/** getDailyStats 季度/年度范围窗口边界测试 — 日期动态计算（UTC+8 同法），任意时刻可跑 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { initDb, closeDb, getDailyStats, upsertHourlyStat } from '../proxy/db.js';
import { createTempDb } from './setup.js';

const tmp = createTempDb();

beforeAll(async () => { await initDb(tmp.dbPath); });
afterAll(() => { closeDb(); tmp.cleanup(); });

/** 目标时区（UTC+8）"现在"与日期格式化工具 */
const now = new Date();
const utcNow = new Date(now.getTime() + now.getTimezoneOffset() * 60000 + 8 * 3600000);
const pad = (n: number) => String(n).padStart(2, '0');
const fmt = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
/** 该日期在目标时区午夜的 UTC 毫秒（供 created_at_ms 过滤） */
const dayMs = (d: Date) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());

const todayText = fmt(utcNow);
const quarterStartMonth = Math.floor(utcNow.getMonth() / 3) * 3;
/** 上季度末日（本季度首日 - 1 天；构造为本地日期，组件即目标时区年月日） */
const lastQuarterLastDay = new Date(utcNow.getFullYear(), quarterStartMonth, 0);
/** 去年末日 */
const lastYearLastDay = new Date(utcNow.getFullYear() - 1, 11, 31);

describe('getDailyStats 季度/年度范围', () => {
  it('thisQuarter：今天的行命中', () => {
    // 今天的行用默认 createdAtMs（Date.now()，必落在本季度窗口内）
    upsertHourlyStat('OpenAI', 'm-quarter', 'codex', 0.05, 1, 50, 80, 20);
    const rows = getDailyStats('thisQuarter', 'OpenAI');
    expect(rows.find((r: any) => r.date === todayText)).toBeDefined();
  });

  it('thisYear：今天的行命中', () => {
    upsertHourlyStat('OpenAI', 'm-year', 'codex', 0.05, 1, 50, 80, 20);
    const rows = getDailyStats('thisYear', 'OpenAI');
    expect(rows.find((r: any) => r.date === todayText)).toBeDefined();
  });

  it('lastQuarter：上季度末日的行命中、今天的行排除', () => {
    // 历史日期行必须显式传 createdAtMs（该日午夜 UTC 毫秒），否则默认 Date.now() 被时间戳过滤错误排除
    upsertHourlyStat('OpenAI', 'm-lq', 'codex', 0.05, 1, 50, 80, 20, dayMs(lastQuarterLastDay));
    upsertHourlyStat('OpenAI', 'm-lq-today', 'codex', 0.05, 1, 50, 80, 20);
    const rows = getDailyStats('lastQuarter', 'OpenAI');
    expect(rows.find((r: any) => r.date === fmt(lastQuarterLastDay))).toBeDefined();
    expect(rows.find((r: any) => r.date === todayText)).toBeUndefined();
  });

  it('lastYear：去年末日的行命中、今天的行排除', () => {
    upsertHourlyStat('OpenAI', 'm-ly', 'codex', 0.05, 1, 50, 80, 20, dayMs(lastYearLastDay));
    upsertHourlyStat('OpenAI', 'm-ly-today', 'codex', 0.05, 1, 50, 80, 20);
    const rows = getDailyStats('lastYear', 'OpenAI');
    expect(rows.find((r: any) => r.date === fmt(lastYearLastDay))).toBeDefined();
    expect(rows.find((r: any) => r.date === todayText)).toBeUndefined();
  });

  it('today / 7d 范围不含未来小时（时钟偏差防御）', () => {
    // 未来 48h 的 createdAtMs：若范围缺上界会被错误纳入（时钟偏差产生的未来小时）
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
