import { useQuery } from '@tanstack/react-query';
import * as api from '../api/client';
import { CurrencyContext, type CurrencyKey, type CurrencyContextValue } from '../lib/currency';
import type { ReactNode } from 'react';

export default function CurrencyProvider({ children }: { children: ReactNode }) {
  const { data: config } = useQuery({ queryKey: ['config'], queryFn: api.getConfig, staleTime: 60000 });

  const value: CurrencyContextValue = {
    currency: (config?.currency as CurrencyKey) || 'CNY',
    rates: config?.rates as Record<string, number> | undefined,
    ratesUpdatedAt: config?.rates_updated_at as string | undefined,
  };

  return (
    <CurrencyContext.Provider value={value}>
      {children}
    </CurrencyContext.Provider>
  );
}
