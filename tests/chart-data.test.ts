/** 图表数据纯函数测试 — 类别宽表透视 / 类别排序 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildCategoryRows, getCategory, listCategories, stackOrder } from '../webui/src/lib/chart-data';
import type { DailyData } from '../webui/src/lib/chart-data';

function row(date: string, category: string, cost: number, out = 0, uncached = 0, cached = 0): DailyData {
  return {
    date, category, count: 1, total_cost: cost,
    total_output_tokens: out, total_uncached_input: uncached, total_cache_read_tokens: cached,
  };
}

afterEach(() => { vi.useRealTimers(); });

describe('listCategories', () => {
  it('去重且保持首现顺序（= 后端返回顺序）', () => {
    expect(listCategories([row('d1', 'b', 1), row('d1', 'a', 1), row('d2', 'b', 1)])).toEqual(['b', 'a']);
  });

  it('过滤空类别', () => {
    const noCat: DailyData = { date: 'd1', count: 0, total_cost: 0, total_output_tokens: 0, total_uncached_input: 0, total_cache_read_tokens: 0 };
    expect(listCategories([row('d1', 'a', 1), noCat])).toEqual(['a']);
  });
});

describe('stackOrder', () => {
  it('model 维度按字母序', () => {
    expect(stackOrder(['b-model', 'a-model', 'c-model'], [], 'model', d => d.total_cost))
      .toEqual(['a-model', 'b-model', 'c-model']);
  });

  it('tool/provider 维度按指标总量升序（小值在柱底）', () => {
    const data = [row('d1', 'big', 10), row('d1', 'small', 1), row('d2', 'mid', 5)];
    expect(stackOrder(['big', 'small', 'mid'], data, 'tool', d => d.total_cost))
      .toEqual(['small', 'mid', 'big']);
  });

  it('指标由 valueOf 决定（费用与 tokens 可不同序）', () => {
    const data = [row('d1', 'x', 1, 100), row('d1', 'y', 10, 1)];
    expect(stackOrder(['x', 'y'], data, 'provider', d => d.total_cost)).toEqual(['x', 'y']);
    expect(stackOrder(['x', 'y'], data, 'provider', d => d.total_output_tokens)).toEqual(['y', 'x']);
  });
});

describe('buildCategoryRows', () => {
  it('补全日期 + 按类别透视（缺失日期/类别补 0）', () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 7, 20, 4, 0, 0)); // 2026-08-20 12:00 UTC+8
    const data = [row('2026-08-20', 'a', 3), row('2026-08-20', 'b', 5), row('2026-08-19', 'a', 2)];
    const rows = buildCategoryRows(data, '7d', 8, d => d.total_cost);
    expect(rows).toHaveLength(7);
    const today = rows[rows.length - 1];
    expect(today.date).toBe('2026-08-20');
    expect(today.a).toBe(3);
    expect(today.b).toBe(5);
    const yesterday = rows[rows.length - 2];
    expect(yesterday.a).toBe(2);
    expect(yesterday.b).toBe(0);
  });

  it('同日同类别多行累加', () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 7, 20, 4, 0, 0));
    const rows = buildCategoryRows([row('2026-08-20', 'a', 2), row('2026-08-20', 'a', 3)], '7d', 8, d => d.total_cost);
    expect(rows[rows.length - 1].a).toBe(5);
  });
});
