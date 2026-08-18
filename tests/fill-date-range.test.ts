/** fillDateRange 序列测试（小时级 today/yesterday + 月/周级季度/年度）— 日期动态计算（UTC+8 同法），任意时刻可跑 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { fillDateRange } from '../webui/src/lib/dates';

afterEach(() => { vi.useRealTimers(); });
const now = new Date();
const utcNow = new Date(now.getTime() + now.getTimezoneOffset() * 60000 + 8 * 3600000);
const pad = (n: number) => String(n).padStart(2, '0');
const fmt = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

describe('fillDateRange 小时级（today/yesterday）', () => {
  it('today 返回 24 个小时标签（YYYY-MM-DD HH:00）', () => {
    const labels = fillDateRange('today', 8);
    expect(labels).toHaveLength(24);
    expect(labels[0]).toMatch(/^\d{4}-\d{2}-\d{2} 00:00$/);
    expect(labels[23]).toMatch(/^\d{4}-\d{2}-\d{2} 23:00$/);
    expect(labels[0].slice(0, 10)).toBe(fmt(utcNow));
  });

  it('yesterday 返回 24 个小时标签', () => {
    const labels = fillDateRange('yesterday', 8);
    expect(labels).toHaveLength(24);
    expect(labels[0]).toMatch(/^\d{4}-\d{2}-\d{2} 00:00$/);
    expect(labels[0].slice(0, 10)).toBe(fmt(new Date(utcNow.getFullYear(), utcNow.getMonth(), utcNow.getDate() - 1)));
  });
});

describe('fillDateRange 季度/年度（月/周序列）', () => {
  it('thisQuarter：ISO 周标签序列、有序去重、覆盖完整季度（含未来周空桶）', () => {
    const rows = fillDateRange('thisQuarter', 8);
    // 与后端 getDailyStats 季档位契约一致：'GGGG-WVV' 零填充周号
    for (const r of rows) expect(r).toMatch(/^\d{4}-W\d{2}$/);
    expect([...new Set(rows)]).toEqual(rows);   // 有序去重（首尾不完整周保留）
    // 完整季度 90-92 天 → 13~14 个 ISO 周标签
    expect(rows.length).toBeGreaterThanOrEqual(13);
    expect(rows.length).toBeLessThanOrEqual(14);
  });

  it('lastQuarter：上季度整季 ISO 周标签序列、有序去重', () => {
    const rows = fillDateRange('lastQuarter', 8);
    for (const r of rows) expect(r).toMatch(/^\d{4}-W\d{2}$/);
    expect([...new Set(rows)]).toEqual(rows);
    expect(rows.length).toBeGreaterThanOrEqual(13);
    expect(rows.length).toBeLessThanOrEqual(14);
  });

  it('thisYear：全年 12 个月标签（未来月份为空桶）', () => {
    const rows = fillDateRange('thisYear', 8);
    expect(rows).toHaveLength(12);
    expect(rows[0]).toBe(`${utcNow.getFullYear()}-01`);
    expect(rows[11]).toBe(`${utcNow.getFullYear()}-12`);
    for (const r of rows) expect(r).toMatch(/^\d{4}-\d{2}$/);
  });

  it('lastYear：去年全年 12 个月标签', () => {
    const rows = fillDateRange('lastYear', 8);
    expect(rows).toHaveLength(12);
    expect(rows[0]).toBe(`${utcNow.getFullYear() - 1}-01`);
    expect(rows[11]).toBe(`${utcNow.getFullYear() - 1}-12`);
    for (const r of rows) expect(r).toMatch(/^\d{4}-\d{2}$/);
  });

  it('lastQuarter 跨年季：序列含 2025-W52 与 2026-W01（ISO 年跨年语义）', () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 1, 15, 12, 0, 0)); // 2026-02-15 → lastQuarter = 2025 Q4（10-12 月）
    const rows = fillDateRange('lastQuarter', 8);
    expect(rows[rows.length - 2]).toBe('2025-W52');   // 12-22~12-28 那周
    expect(rows[rows.length - 1]).toBe('2026-W01');   // 12-29~12-31（ISO 年已跨年）
  });

  it('thisQuarter 跨 ISO 年：Q4 末周标签属次年 W01（%G 语义）', () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2024, 10, 15, 12, 0, 0)); // 2024-11-15 → thisQuarter = Q4 2024
    const rows = fillDateRange('thisQuarter', 8);
    expect(rows[rows.length - 2]).toBe('2024-W52');   // 12-22~12-28 那周
    expect(rows[rows.length - 1]).toBe('2025-W01');   // 12-29~12-31（ISO 年已跨年，1/1 2025 周三 → W1 含 12-29 起）
  });
});
