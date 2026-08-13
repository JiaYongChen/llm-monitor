/** formatCost 测试 — 金额总计费用显示只保留小数点后两位 */
import { describe, it, expect } from 'vitest';
import { formatCost } from '../webui/src/lib/currency';

describe('formatCost', () => {
  it('金额四舍五入到小数点后两位', () => {
    expect(formatCost(0.1254, 'CNY')).toBe('￥0.13 CNY');
    expect(formatCost(0.0423, 'CNY')).toBe('￥0.04 CNY');
    expect(formatCost(123.456, 'CNY')).toBe('￥123.46 CNY');
  });

  it('整数金额显示两位小数', () => {
    expect(formatCost(5, 'CNY')).toBe('￥5.00 CNY');
  });

  it('零值显示 0.00', () => {
    expect(formatCost(0, 'CNY')).toBe('￥0.00 CNY');
  });

  it('非 CNY 币种按汇率换算后同样两位小数', () => {
    // rates 为 CNY→币种 换算率：value * rate 后两位小数
    expect(formatCost(0.1254, 'USD', { 'CNY→USD': 0.14 })).toBe('$0.02 USD');
  });
});
