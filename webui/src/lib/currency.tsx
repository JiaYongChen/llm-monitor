import { createContext, useContext } from 'react';

export const CURRENCIES: Record<string, { symbol: string; label: string }> = {
  CNY: { symbol: '￥', label: 'CNY' },
  USD: { symbol: '$', label: 'USD' },
  EUR: { symbol: '€', label: 'EUR' },
  JPY: { symbol: '¥', label: '円' },
  GBP: { symbol: '£', label: 'GBP' },
};

/** 供应商品牌色 */
export const PROVIDER_COLORS: Record<string, string> = {
  Anthropic: '#d97706',
  OpenAI: '#16a34a',
};

/** 为未知供应商生成确定性颜色（基于名称哈希） */
export function providerColor(name: string): string {
  if (PROVIDER_COLORS[name]) return PROVIDER_COLORS[name];
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = ((hash << 5) - hash) + name.charCodeAt(i);
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 50%, 45%)`;
}

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
    if (rate) displayValue = value * rate;
  }
  const c = CURRENCIES[currency] || CURRENCIES.CNY;
  return `${c.symbol}${displayValue.toFixed(4)} ${c.label}`;
}
