import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import * as api from '../api/client';
import { useCurrency, CURRENCIES } from '../lib/currency';
import { capitalizeFirst } from '../lib/utils';

export default function PricingTable() {
  const { currency } = useCurrency();
  const qc = useQueryClient();
  const { data: pricing } = useQuery({ queryKey: ['pricing'], queryFn: api.listPricing });

  const importMut = useMutation({
    mutationFn: api.importDefaultPricing,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pricing'] }),
  });
  const deleteMut = useMutation({
    mutationFn: api.deletePricing,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pricing'] }),
  });
  const addMut = useMutation({
    mutationFn: (f: any) => api.upsertPricing(f),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['pricing'] });
      setForm({ provider: '', model: '', input_price: 0, cache_input_price: 0, output_price: 0, currency: 'CNY' });
    },
  });

  const [form, setForm] = useState({ provider: '', model: '', input_price: 0, cache_input_price: 0, output_price: 0, currency: 'CNY' as string });

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <span className="text-[11px] font-medium" style={{ color: '#646478' }}>
          {pricing?.length || 0} 条定价规则
        </span>
        <button onClick={() => importMut.mutate()} className="btn btn-ghost text-[11px]">
          重置为默认
        </button>
      </div>

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full text-[12px]">
          <thead>
            <tr style={{ borderBottom: '1px solid #1a1a2a' }}>
              <th className="text-left py-2.5 px-3 font-medium text-[11px] uppercase tracking-wider" style={{ color: '#646478' }}>供应商</th>
              <th className="text-left py-2.5 px-3 font-medium text-[11px] uppercase tracking-wider" style={{ color: '#646478' }}>模型</th>
              <th className="text-right py-2.5 px-3 font-medium text-[11px] uppercase tracking-wider" style={{ color: '#646478' }}>输入价</th>
              <th className="text-right py-2.5 px-3 font-medium text-[11px] uppercase tracking-wider" style={{ color: '#646478' }}>缓存价</th>
              <th className="text-right py-2.5 px-3 font-medium text-[11px] uppercase tracking-wider" style={{ color: '#646478' }}>输出价</th>
              <th className="text-right py-2.5 px-3 font-medium text-[11px] uppercase tracking-wider" style={{ color: '#646478' }}>币种</th>
              <th className="w-10" />
            </tr>
          </thead>
          <tbody>
            {pricing?.map((p: any) => (
              <tr key={p.id} className="hover:bg-[#13131c] transition-colors group" style={{ borderBottom: '1px solid #1a1a2a50' }}>
                <td className="py-2.5 px-3">
                  <span className="text-[11px] font-medium">{capitalizeFirst(p.provider)}</span>
                </td>
                <td className="py-2.5 px-3">
                  <span className="text-[11px] font-mono" style={{ color: '#d4d4e0' }}>{p.model}</span>
                </td>
                <td className="py-2.5 px-3 text-right">
                  <span className="text-[11px] font-mono" style={{ color: '#9898a8' }}>{CURRENCIES[p.currency || 'CNY']?.symbol || '￥'}{p.input_price.toFixed(3)}</span>
                  <span className="text-[9px] ml-1" style={{ color: '#4a4a5a' }}>/1M</span>
                </td>
                <td className="py-2.5 px-3 text-right">
                  <span className="text-[11px] font-mono" style={{ color: '#9898a8' }}>{CURRENCIES[p.currency || 'CNY']?.symbol || '￥'}{p.cache_input_price.toFixed(3)}</span>
                  <span className="text-[9px] ml-1" style={{ color: '#4a4a5a' }}>/1M</span>
                </td>
                <td className="py-2.5 px-3 text-right">
                  <span className="text-[11px] font-mono" style={{ color: '#9898a8' }}>{CURRENCIES[p.currency || 'CNY']?.symbol || '￥'}{p.output_price.toFixed(2)}</span>
                  <span className="text-[9px] ml-1" style={{ color: '#4a4a5a' }}>/1M</span>
                </td>
                <td className="py-2.5 px-3 text-right">
                  <span className="text-[10px] font-mono" style={{ color: '#4a4a5a' }}>{p.currency || 'CNY'}</span>
                </td>
                <td className="py-2.5 text-center">
                  {!p.is_default && <button
                    onClick={() => deleteMut.mutate(p.id)}
                    className="opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded hover:bg-[#1a1a2a]"
                    style={{ color: '#646478' }}
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
                  </button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Add form */}
      <div className="mt-5 pt-4 flex items-end gap-2" style={{ borderTop: '1px solid #1a1a2a' }}>
        <div className="flex-1">
          <div className="text-[10px] font-medium mb-1" style={{ color: '#646478' }}>供应商</div>
          <input value={form.provider} onChange={e => setForm({ ...form, provider: (e.target as HTMLInputElement).value })} placeholder="anthropic" className="w-full px-2.5 py-1.5" />
        </div>
        <div className="flex-[2]">
          <div className="text-[10px] font-medium mb-1" style={{ color: '#646478' }}>模型名</div>
          <input value={form.model} onChange={e => setForm({ ...form, model: (e.target as HTMLInputElement).value })} placeholder="gpt-4o" className="w-full px-2.5 py-1.5" />
        </div>
        <div className="w-20">
          <div className="text-[10px] font-medium mb-1" style={{ color: '#646478' }}>输入价</div>
          <input type="number" step="0.001" value={form.input_price || ''} onChange={e => setForm({ ...form, input_price: +(e.target as HTMLInputElement).value })} className="w-full px-2.5 py-1.5" />
        </div>
        <div className="w-20">
          <div className="text-[10px] font-medium mb-1" style={{ color: '#646478' }}>缓存价</div>
          <input type="number" step="0.001" value={form.cache_input_price || ''} onChange={e => setForm({ ...form, cache_input_price: +(e.target as HTMLInputElement).value })} className="w-full px-2.5 py-1.5" />
        </div>
        <div className="w-20">
          <div className="text-[10px] font-medium mb-1" style={{ color: '#646478' }}>输出价</div>
          <input type="number" step="0.001" value={form.output_price || ''} onChange={e => setForm({ ...form, output_price: +(e.target as HTMLInputElement).value })} className="w-full px-2.5 py-1.5" />
        </div>
        <div className="w-18">
          <div className="text-[10px] font-medium mb-1" style={{ color: '#646478' }}>币种</div>
          <select value={form.currency} onChange={e => setForm({ ...form, currency: (e.target as HTMLSelectElement).value })} className="w-full px-2 py-1.5 text-[11px]">
            {Object.keys(CURRENCIES).map(k => (
              <option key={k} value={k}>{k}</option>
            ))}
          </select>
        </div>
        <button onClick={() => addMut.mutate(form)} className="btn btn-primary flex-shrink-0">添加</button>
      </div>
    </div>
  );
}
