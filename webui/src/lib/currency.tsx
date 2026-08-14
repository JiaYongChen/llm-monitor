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
    if (rate) displayValue = value * rate;
  }
  const c = CURRENCIES[currency] || CURRENCIES.CNY;
  // 金额显示只保留小数点后两位（四舍五入）
  return `${c.symbol}${displayValue.toFixed(2)} ${c.label}`;
}
