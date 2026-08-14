/** fillDateRange 季度/年度序列测试 — 日期动态计算（UTC+8 同法），任意时刻可跑 */
import { describe, it, expect } from 'vitest';
import { fillDateRange } from '../webui/src/lib/dates';

const now = new Date();
const utcNow = new Date(now.getTime() + now.getTimezoneOffset() * 60000 + 8 * 3600000);
const pad = (n: number) => String(n).padStart(2, '0');
const fmt = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

const quarterStartMonth = Math.floor(utcNow.getMonth() / 3) * 3;

describe('fillDateRange 季度/年度', () => {
  it('thisQuarter：首日 = 季度首日，末日 = 今天', () => {
    const rows = fillDateRange('thisQuarter', 8);
    expect(rows[0]).toBe(fmt(new Date(utcNow.getFullYear(), quarterStartMonth, 1)));
    expect(rows[rows.length - 1]).toBe(fmt(utcNow));
  });

  it('lastQuarter：首日 = 上季度首日，末日 = 本季度首日前一天', () => {
    const rows = fillDateRange('lastQuarter', 8);
    expect(rows[0]).toBe(fmt(new Date(utcNow.getFullYear(), quarterStartMonth - 3, 1)));
    expect(rows[rows.length - 1]).toBe(fmt(new Date(utcNow.getFullYear(), quarterStartMonth, 0)));
  });

  it('thisYear：首日 = 1 月 1 日，末日 = 今天', () => {
    const rows = fillDateRange('thisYear', 8);
    expect(rows[0]).toBe(`${utcNow.getFullYear()}-01-01`);
    expect(rows[rows.length - 1]).toBe(fmt(utcNow));
  });

  it('lastYear：首日 = 去年 1 月 1 日，末日 = 去年 12 月 31 日（闰年兼容）', () => {
    const rows = fillDateRange('lastYear', 8);
    expect(rows[0]).toBe(`${utcNow.getFullYear() - 1}-01-01`);
    expect(rows[rows.length - 1]).toBe(`${utcNow.getFullYear() - 1}-12-31`);
    expect([365, 366]).toContain(rows.length);
  });
});
