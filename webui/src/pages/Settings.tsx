import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import * as api from '../api/client';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Badge } from '../components/ui/badge';
import { Switch } from '../components/ui/switch';
import { Dialog, DialogHeader, DialogTitle, DialogDescription } from '../components/ui/dialog';
import { Plus, Trash2, Copy, ChevronDown, ChevronRight } from 'lucide-react';
import { useCurrency, CURRENCIES, providerColor, type CurrencyKey } from '../lib/currency';

export default function Settings() {
  const qc = useQueryClient();
  const { data: providers } = useQuery({ queryKey: ['providers'], queryFn: api.listProviders });
  const { data: pricing } = useQuery({ queryKey: ['pricing'], queryFn: api.listPricing });

  const updateMut = useMutation({
    mutationFn: ({ p, d }: { p: string; d: any }) => api.updateProvider(p, d),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['providers'] }),
  });
  const addMut = useMutation({
    mutationFn: (d: any) => api.addProvider(d),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['providers'] });
      setNewProv({ name: '', urlOpenAI: '', urlAnthropic: '', key: '', apiFormat: '' });
      setApiFormatDirty(false);
      setShowAdd(false);
    },
    onError: (err) => alert('添加失败: ' + (err as Error).message),
  });
  const delMut = useMutation({
    mutationFn: (p: string) => api.deleteProvider(p),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['providers'] }),
  });
  const clearMut = useMutation({ mutationFn: api.clearAllData, onSuccess: () => qc.invalidateQueries() });
  const clearProvidersMut = useMutation({ mutationFn: api.clearThirdPartyProviders, onSuccess: () => qc.invalidateQueries({ queryKey: ['providers'] }) });
  const clearSessionsMut = useMutation({ mutationFn: api.clearAllSessions, onSuccess: () => qc.invalidateQueries() });

  const [confirm, setConfirm] = useState<{ title: string; desc: string; onOk: () => void } | null>(null);

  const providerPrices = (prov: string) => (pricing as any[])?.filter((p: any) => p.provider === prov) || [];

  const [showAdd, setShowAdd] = useState(false);
  const [newProv, setNewProv] = useState({ name: '', urlOpenAI: '', urlAnthropic: '', key: '', apiFormat: '' });
  const [apiFormatDirty, setApiFormatDirty] = useState(false); // 用户手动选择后不再自动覆盖

  /** 根据供应商名称和 URL 自动推断 API 格式。
   *  DeepSeek/Qwen 的 URL 虽是 OpenAI 兼容格式，但 usage 结构不同，名称必须优先于 URL。 */
  const detectApiFormat = (name: string, urlOA: string, urlAnth: string): string => {
    const lower = name.toLowerCase();
    // DeepSeek/Qwen 名称优先——它们的 URL 长得很像 OpenAI 但 usage 字段不同
    if (lower.includes('deepseek')) return 'deepseek';
    if (lower.includes('qwen') || lower.includes('tongyi')) return 'qwen';
    // URL 信号用于无法从名称推断的通用供应商
    if (urlOA) return 'openai';
    if (urlAnth) return 'anthropic';
    if (lower.includes('anthropic') || lower.includes('claude')) return 'anthropic';
    if (lower.includes('openai') || lower.includes('gpt')) return 'openai';
    return '';
  };

  const handleAddProvider = () => {
    if (!newProv.name) return;
    const fmt = apiFormatDirty ? newProv.apiFormat : detectApiFormat(newProv.name, newProv.urlOpenAI, newProv.urlAnthropic);
    addMut.mutate({
      provider: newProv.name, base_url: newProv.urlOpenAI, base_url_anthropic: newProv.urlAnthropic,
      api_key: newProv.key,
      api_format: fmt,
    });
  };

  return (
    <div className="p-8 max-w-5xl mx-auto space-y-6 animate-in">
      <h1 className="text-2xl font-bold tracking-tight">设置</h1>

      {/* 供应商接入 */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div className="flex items-center gap-3">
            <CardTitle>供应商</CardTitle>
            <Badge variant="secondary">{(providers as any[])?.length || 0} 个</Badge>
          </div>
          <Button size="sm" onClick={() => setShowAdd(true)}><Plus className="h-4 w-4 mr-1" />添加供应商</Button>
        </CardHeader>
        <CardContent className="space-y-3">
          {(providers as any[])?.sort((a: any, b: any) => {
            const aBuiltin = a.provider in BUILTIN_PROVIDERS ? 0 : 1;
            const bBuiltin = b.provider in BUILTIN_PROVIDERS ? 0 : 1;
            return aBuiltin - bBuiltin || a.provider.localeCompare(b.provider);
          }).map((p: any) => (
            <ProviderItem
              key={p.provider}
              provider={p.provider}
              baseUrl={p.base_url || ''}
              baseUrlAnthropic={p.base_url_anthropic || ''}
              apiKey={p.api_key || ''}
              enabled={p.enabled === 1}
              color={providerColor(p.provider)}
              prices={providerPrices(p.provider)}
              onToggle={(v) => updateMut.mutate({ p: p.provider, d: { enabled: v, api_format: p.api_format || '' } })}
              onUpdate={(d) => updateMut.mutate({ p: p.provider, d: { ...d, api_format: p.api_format || '' } })}
              onPricesChanged={() => qc.invalidateQueries({ queryKey: ['pricing'] })}
              onDelete={() => { if (window.confirm(`删除 "${p.provider}"？`)) delMut.mutate(p.provider); }}
            />
          ))}
          {(!providers || (providers as any[])?.length === 0) && (
            <p className="text-sm text-gray-500 text-center py-4">暂无供应商，点击上方按钮添加</p>
          )}
        </CardContent>
      </Card>

      {/* 添加弹窗 */}
      <Dialog open={showAdd} onClose={() => { setShowAdd(false); setApiFormatDirty(false); setNewProv({ name: '', urlOpenAI: '', urlAnthropic: '', key: '', apiFormat: '' }); }}>
        <DialogHeader>
          <DialogTitle>添加供应商</DialogTitle>
          <DialogDescription>配置 Base URL 和 API Key。模型定价在供应商卡片中单独添加。</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="flex items-end gap-2">
            <div className="flex-[2]"><label className="text-xs text-gray-700 font-medium">名称</label><Input value={newProv.name} onChange={e => setNewProv({ ...newProv, name: e.target.value })} placeholder="openrouter" /></div>
            <div className="flex-[2]"><label className="text-xs text-gray-700 font-medium">API Key</label><Input value={newProv.key} onChange={e => setNewProv({ ...newProv, key: e.target.value })} placeholder="sk-xxx" /></div>
          </div>
          <div className="flex items-end gap-2">
            <div className="flex-1"><label className="text-xs text-gray-700 font-medium">Base URL (OpenAI)</label><Input value={newProv.urlOpenAI} onChange={e => setNewProv({ ...newProv, urlOpenAI: e.target.value })} placeholder="https://api.openai.com" /></div>
            <div className="flex-1"><label className="text-xs text-gray-700 font-medium">Base URL (Anthropic)</label><Input value={newProv.urlAnthropic} onChange={e => setNewProv({ ...newProv, urlAnthropic: e.target.value })} placeholder="https://api.anthropic.com" /></div>
          </div>
          <div className="flex items-end gap-3">
            <div className="w-48">
              <label className="text-xs text-gray-700 font-medium">API 格式</label>
              <select
                className="text-sm border border-[#e5e5ea] rounded-lg px-3 py-1.5 bg-white w-full"
                value={newProv.apiFormat}
                onChange={e => { setNewProv({ ...newProv, apiFormat: e.target.value }); setApiFormatDirty(e.target.value !== ''); }}
              >
                <option value="">自动检测</option>
                <option value="anthropic">Anthropic Messages</option>
                <option value="openai">OpenAI Chat Completions</option>
                <option value="deepseek">DeepSeek</option>
                <option value="qwen">Qwen</option>
              </select>
            </div>
            <span className="text-[11px] text-[#aeaeb2] pb-1.5">
              {newProv.apiFormat ? '手动指定' : `自动: ${detectApiFormat(newProv.name, newProv.urlOpenAI, newProv.urlAnthropic) || '未识别'}`}
            </span>
          </div>
          <div className="flex gap-2 pt-2">
            <Button onClick={handleAddProvider} size="sm"><Plus className="h-4 w-4 mr-1" />确认添加</Button>
            <Button variant="outline" size="sm" onClick={() => { setShowAdd(false); setApiFormatDirty(false); setNewProv({ name: '', urlOpenAI: '', urlAnthropic: '', key: '', apiFormat: '' }); }}>取消</Button>
          </div>
        </div>
      </Dialog>

      {/* 价格单位 */}
      <Card>
        <CardHeader><CardTitle>价格单位</CardTitle></CardHeader>
        <CardContent>
          <CurrencySelector />
        </CardContent>
      </Card>

      {/* 数据管理 */}
      <Card>
        <CardHeader><CardTitle>数据管理</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-3">
            <Button variant="destructive" size="sm" title="清除全部调用记录、会话、定价、供应商配置" onClick={() => setConfirm({ title: '清空全部数据', desc: '将删除所有调用记录、会话、定价和供应商配置，此操作不可恢复。', onOk: () => clearMut.mutate() })}>清空全部数据</Button>
          </div>
          <div className="flex items-center gap-3">
            <Button variant="destructive" size="sm" title="只删除手动添加的供应商，保留内置 Anthropic 和 OpenAI" onClick={() => setConfirm({ title: '清空第三方供应商', desc: '将删除所有手动添加的供应商，内置 Anthropic 和 OpenAI 将保留。', onOk: () => clearProvidersMut.mutate() })}>清空第三方供应商</Button>
          </div>
          <div className="flex items-center gap-3">
            <Button variant="destructive" size="sm" title="删除所有调用记录和会话，保留供应商配置和定价" onClick={() => setConfirm({ title: '清空全部会话记录', desc: '将删除所有调用记录和会话，供应商配置和定价保留。', onOk: () => clearSessionsMut.mutate() })}>清空全部会话记录</Button>
          </div>
        </CardContent>
      </Card>

      <Dialog open={confirm !== null} onClose={() => setConfirm(null)}>
        <DialogHeader>
          <DialogTitle>{confirm?.title}</DialogTitle>
          <DialogDescription>{confirm?.desc}</DialogDescription>
        </DialogHeader>
        <div className="flex gap-2 pt-2">
          <Button variant="destructive" size="sm" onClick={() => { confirm?.onOk(); setConfirm(null); }}>确认</Button>
          <Button variant="outline" size="sm" onClick={() => setConfirm(null)}>取消</Button>
        </div>
      </Dialog>
    </div>
  );
}

const BUILTIN_PROVIDERS: Record<string, string> = { Anthropic: 'anthropic', OpenAI: 'openai' };

function ProviderItem({ provider, baseUrl, baseUrlAnthropic, apiKey, enabled, color, prices, onToggle, onUpdate, onPricesChanged, onDelete }: {
  provider: string; baseUrl: string; baseUrlAnthropic: string; apiKey: string; enabled: boolean; color: string;
  prices: any[]; onToggle: (v: boolean) => void; onUpdate: (d: Record<string, string>) => void;
  onPricesChanged: () => void; onDelete: () => void;
}) {
  const [keyValue, setKeyValue] = useState(apiKey);
  const [urlOpenAI, setUrlOpenAI] = useState(baseUrl);
  const [urlAnthropic, setUrlAnthropic] = useState(baseUrlAnthropic);
  const [expanded, setExpanded] = useState(false);
  const isBuiltin = provider in BUILTIN_PROVIDERS;
  const fmt = BUILTIN_PROVIDERS[provider] || '';
  const { currency } = useCurrency();
  const [showAddPrice, setShowAddPrice] = useState(false);
  const [newModel, setNewModel] = useState({ model: '', outPrice: '', inPrice: '', cachePrice: '', currency: 'CNY' as string });

  const addPriceMut = useMutation({
    mutationFn: (d: any) => api.upsertPricing(d),
    onSuccess: () => {
      onPricesChanged();
      setNewModel({ model: '', outPrice: '', inPrice: '', cachePrice: '', currency: 'CNY' });
      setShowAddPrice(false);
    },
  });
  const deletePriceMut = useMutation({
    mutationFn: (id: number) => api.deletePricing(id),
    onSuccess: () => onPricesChanged(),
  });

  return (
    <div className="rounded-lg border bg-card">
      <div className="flex items-center gap-3 py-5 px-4">
          <button onClick={() => setExpanded(!expanded)} className={`w-5 h-5 flex items-center justify-center shrink-0 text-gray-500 hover:text-foreground ${!enabled ? 'opacity-40' : ''}`}>
            {expanded ? <ChevronDown className="h-5 w-5" /> : <ChevronRight className="h-5 w-5" />}
          </button>
          <div className="w-8 h-8 rounded flex items-center justify-center text-xs font-bold text-white flex-shrink-0" style={{ background: enabled ? color : '#b0b0b5' }}>
            {provider[0].toUpperCase()}
          </div>
          <div className={`flex-1 min-w-0 ${!enabled ? 'opacity-40' : ''}`}>
            <div className="flex items-center gap-2">
              <div className="w-[140px] flex-shrink-0 flex items-center gap-2">
                <span className="text-sm font-semibold truncate">{provider}</span>
                <Badge variant="secondary" className="text-[10px] font-mono flex-shrink-0">{prices.length} 个定价</Badge>
              </div>
              <div className="text-xs text-[#6e6e73] leading-normal min-w-0 space-y-1.5">
                {fmt === 'anthropic' ? (
                  <div className="flex items-center gap-2">
                    <span className="flex-shrink-0 text-[#aeaeb2]">Base URL:</span>
                    <span className="text-xs font-mono text-[#6e6e73]">{baseUrl || 'https://api.anthropic.com'}</span>
                  </div>
                ) : fmt === 'openai' ? (
                  <div className="flex items-center gap-2">
                    <span className="flex-shrink-0 text-[#aeaeb2]">Base URL:</span>
                    <span className="text-xs font-mono text-[#6e6e73]">{baseUrl || 'https://api.openai.com'}</span>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <span className="flex-shrink-0">OpenAI:</span>
                    <Input
                      value={urlOpenAI}
                      onChange={e => setUrlOpenAI(e.target.value)}
                      onBlur={() => { if (urlOpenAI !== baseUrl) onUpdate({ base_url: urlOpenAI }); }}
                      onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                      placeholder="https://api.openai.com"
                      className="h-6 text-xs font-mono flex-1"
                    />
                    <span className="flex-shrink-0">Anthropic:</span>
                    <Input
                      value={urlAnthropic}
                      onChange={e => setUrlAnthropic(e.target.value)}
                      onBlur={() => { if (urlAnthropic !== baseUrlAnthropic) onUpdate({ base_url_anthropic: urlAnthropic }); }}
                      onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                      placeholder="https://api.anthropic.com"
                      className="h-6 text-xs font-mono flex-1"
                    />
                  </div>
                )}
                <div className="flex items-center gap-1">
                  <span className="flex-shrink-0">APIKey:</span>
                  <Input
                    type="password"
                    value={keyValue}
                    onChange={e => setKeyValue(e.target.value)}
                    onBlur={() => { if (keyValue !== apiKey) onUpdate({ api_key: keyValue }); }}
                    onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                    placeholder="sk-xxx"
                    className="h-6 text-xs font-mono flex-1"
                  />
                  <Button variant="ghost" size="icon" className="h-4 w-4" onClick={() => navigator.clipboard.writeText(keyValue)} title="复制">
                    <Copy className="h-[10px] w-[10px]" />
                  </Button>
                </div>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {!isBuiltin && <Switch checked={enabled} onCheckedChange={onToggle} />}
            {!isBuiltin && (
              <Button variant="ghost" size="icon" className="h-7 w-7 text-gray-500 hover:text-destructive" onClick={onDelete}><Trash2 className="h-3 w-3" /></Button>
            )}
          </div>
        </div>

      {expanded && (
        <div className="border-t border-[#e5e5ea]">
          {/* 表头 */}
          <div className="flex items-center gap-2 text-[11px] font-medium text-gray-500 px-4 py-1 min-w-fit">
            <span className="flex-1 min-w-0">模型</span>
            <span className="w-16 text-center shrink-0">输出</span>
            <span className="w-16 text-center shrink-0">输入(未命中)</span>
            <span className="w-16 text-center shrink-0">输入(命中)</span>
            <span className="w-6 shrink-0" />
          </div>

          {/* 已有定价 */}
          {prices.map((p: any) => (
            <div key={p.id} className="flex items-center gap-2 text-xs py-1.5 px-4 rounded hover:bg-muted/50 min-w-fit">
              <span className="flex-1 min-w-0 font-mono text-gray-500 truncate">{p.model}</span>
              <span className="w-16 text-center font-mono shrink-0">{CURRENCIES[p.currency || 'CNY']?.symbol || '￥'}{p.output_price.toFixed(2)}</span>
              <span className="w-16 text-center font-mono shrink-0">{CURRENCIES[p.currency || 'CNY']?.symbol || '￥'}{p.input_price.toFixed(3)}</span>
              <span className="w-16 text-center font-mono shrink-0">{CURRENCIES[p.currency || 'CNY']?.symbol || '￥'}{p.cache_input_price.toFixed(3)}</span>
              {p.is_default ? <span className="w-6 shrink-0" /> : <Button variant="ghost" size="icon" className="h-6 w-6 shrink-0" onClick={() => deletePriceMut.mutate(p.id)}><Trash2 className="h-3 w-3" /></Button>}
            </div>
          ))}

          {/* 添加模型定价按钮 */}
          <button
            className="w-full text-xs text-gray-500 hover:text-gray-700 py-1.5 px-4 rounded flex items-center gap-1 hover:bg-muted/50"
            onClick={() => setShowAddPrice(true)}
          >
            <Plus className="h-3 w-3" /> 添加模型定价
          </button>

          {prices.length === 0 && (
            <p className="text-xs text-gray-400 py-1 px-4">暂无模型定价</p>
          )}

          {/* 添加定价弹窗 */}
          <Dialog open={showAddPrice} onClose={() => { setShowAddPrice(false); setNewModel({ model: '', outPrice: '', inPrice: '', cachePrice: '', currency: 'CNY' }); }}>
            <DialogHeader>
              <DialogTitle>添加模型定价</DialogTitle>
              <DialogDescription>为「{provider}」添加新的模型定价规则。</DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <div className="flex items-end gap-2">
                <div className="flex-[2]"><label className="text-xs text-gray-700 font-medium">模型名称</label><Input value={newModel.model} onChange={e => setNewModel({ ...newModel, model: e.target.value })} placeholder="gpt-4o" /></div>
                <div className="flex-1"><label className="text-xs text-gray-700 font-medium">币种</label>
                  <select value={newModel.currency} onChange={e => setNewModel({ ...newModel, currency: e.target.value })} className="h-9 text-sm border border-[#e5e5ea] rounded-lg px-3 w-full bg-white">
                    {Object.keys(CURRENCIES).map(k => (
                      <option key={k} value={k}>{k}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="flex items-end gap-2">
                <div className="flex-1"><label className="text-xs text-gray-700 font-medium">输出价格 (每1M token)</label><Input type="number" step="any" value={newModel.outPrice} onChange={e => setNewModel({ ...newModel, outPrice: e.target.value })} placeholder="0" /></div>
                <div className="flex-1"><label className="text-xs text-gray-700 font-medium">输入价格-未命中 (每1M token)</label><Input type="number" step="any" value={newModel.inPrice} onChange={e => setNewModel({ ...newModel, inPrice: e.target.value })} placeholder="0" /></div>
                <div className="flex-1"><label className="text-xs text-gray-700 font-medium">输入价格-命中 (每1M token)</label><Input type="number" step="any" value={newModel.cachePrice} onChange={e => setNewModel({ ...newModel, cachePrice: e.target.value })} placeholder="0" /></div>
              </div>
              <div className="flex gap-2 pt-2">
                <Button onClick={() => {
                  if (!newModel.model.trim()) return;
                  addPriceMut.mutate({ provider, model: newModel.model.trim(), input_price: +newModel.inPrice || 0, cache_input_price: +newModel.cachePrice || 0, output_price: +newModel.outPrice || 0, currency: newModel.currency });
                }} size="sm"><Plus className="h-4 w-4 mr-1" />确认添加</Button>
                <Button variant="outline" size="sm" onClick={() => { setShowAddPrice(false); setNewModel({ model: '', outPrice: '', inPrice: '', cachePrice: '', currency: 'CNY' }); }}>取消</Button>
              </div>
            </div>
          </Dialog>
        </div>
      )}
    </div>
  );
}

function CurrencySelector() {
  const qc = useQueryClient();
  const { currency, ratesUpdatedAt } = useCurrency();
  const configMut = useMutation({
    mutationFn: (c: string) => api.updateConfig({ currency: c }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['config'] }),
  });

  const ratesMut = useMutation({
    mutationFn: () => api.refreshRates(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['config'] }),
  });

  const fmtTime = (ts?: number | string | null) => {
    if (!ts) return '未知';
    try {
      const d = new Date(Number(ts));
      return d.toLocaleString('zh-CN', { hour12: false });
    } catch { return String(ts); }
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3">
        <span className="text-xs text-gray-500">选择价格单位，页面上所有费用将同步切换：</span>
        <select
          className="text-sm border border-[#e5e5ea] rounded-lg px-3 py-1.5 bg-white focus:outline-none focus:ring-2 focus:ring-[#0071e3]"
          value={currency}
          onChange={e => configMut.mutate(e.target.value)}
        >
          {Object.entries(CURRENCIES).map(([key, val]) => (
            <option key={key} value={key}>{val.symbol} {key} ({val.label})</option>
          ))}
        </select>
      </div>
      <div className="flex items-center gap-2 text-xs text-gray-400">
        <span>汇率更新于 {fmtTime(ratesUpdatedAt)}</span>
        <button
          onClick={() => ratesMut.mutate()}
          disabled={ratesMut.isPending}
          className="text-[#0071e3] hover:underline disabled:opacity-50"
        >
          {ratesMut.isPending ? '刷新中...' : '刷新'}
        </button>
      </div>
    </div>
  );
}
