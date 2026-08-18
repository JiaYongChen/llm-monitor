import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import * as api from '../api/client';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Badge } from '../components/ui/badge';
import { Switch } from '../components/ui/switch';
import { Dialog, DialogHeader, DialogTitle, DialogDescription } from '../components/ui/dialog';
import { Plus, Trash2, Copy, ChevronDown, ChevronRight, RefreshCw } from 'lucide-react';
import { useCurrency, CURRENCIES, type CurrencyKey } from '../lib/currency';
import { useCategoryColors, categoryColor } from '../lib/colors';
import { displayName } from '../lib/display';

export default function Settings() {
  const qc = useQueryClient();
  const { data: providers } = useQuery({ queryKey: ['providers'], queryFn: api.listProviders });
  const { data: colors } = useCategoryColors();
  const { data: providerModels } = useQuery({ queryKey: ['provider-models'], queryFn: () => api.listProviderModels() });
  const { data: modelSyncStatus } = useQuery({ queryKey: ['provider-models-status'], queryFn: () => api.getProviderModelsStatus() });

  const updateMut = useMutation({
    mutationFn: ({ p, d }: { p: string; d: any }) => api.updateProvider(p, d),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['providers'] }),
  });
  const addMut = useMutation({
    mutationFn: (d: any) => api.addProvider(d),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['providers'] });
      setNewProv({ name: '', urlOpenAI: '', urlAnthropic: '', key: '' });
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

  const [showAdd, setShowAdd] = useState(false);
  const [newProv, setNewProv] = useState({ name: '', urlOpenAI: '', urlAnthropic: '', key: '' });

  const handleAddProvider = () => {
    if (!newProv.name) return;
    addMut.mutate({
      provider: newProv.name, base_url: newProv.urlOpenAI, base_url_anthropic: newProv.urlAnthropic,
      api_key: newProv.key,
    });
  };

  return (
    <div className="p-8 max-w-5xl mx-auto space-y-6 animate-in">
      <h1 className="text-2xl font-bold tracking-tight sticky top-0 z-10 bg-[#f5f5f7] -mt-8 pt-8 pb-3 -mb-3">设置</h1>

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
              color={categoryColor(p.provider, 'provider', colors) || '#9ca3af'}
              models={(providerModels || []).filter((m: any) => m.provider === p.provider)}
              syncStatus={(modelSyncStatus as any)?.[p.provider] || null}
              onToggle={(v) => updateMut.mutate({ p: p.provider, d: { enabled: v } })}
              onUpdate={(d) => updateMut.mutate({ p: p.provider, d })}
              onDelete={() => { if (window.confirm(`删除 "${p.provider}"？`)) delMut.mutate(p.provider); }}
            />
          ))}
          {(!providers || (providers as any[])?.length === 0) && (
            <p className="text-sm text-gray-500 text-center py-4">暂无供应商，点击上方按钮添加</p>
          )}
        </CardContent>
      </Card>

      {/* 添加弹窗 */}
      <Dialog open={showAdd} onClose={() => { setShowAdd(false); setNewProv({ name: '', urlOpenAI: '', urlAnthropic: '', key: '' }); }}>
        <DialogHeader>
          <DialogTitle>添加供应商</DialogTitle>
          <DialogDescription>配置 Base URL 和 API Key。保存后自动探测可用模型并同步定价。</DialogDescription>
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
          <div className="flex gap-2 pt-2">
            <Button onClick={handleAddProvider} size="sm"><Plus className="h-4 w-4 mr-1" />确认添加</Button>
            <Button variant="outline" size="sm" onClick={() => { setShowAdd(false); setNewProv({ name: '', urlOpenAI: '', urlAnthropic: '', key: '' }); }}>取消</Button>
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

      {/* 时区 */}
      <Card>
        <CardHeader><CardTitle>时区</CardTitle></CardHeader>
        <CardContent>
          <TimezoneSelector />
        </CardContent>
      </Card>

      {/* 数据管理 */}
      <Card>
        <CardHeader><CardTitle>数据管理</CardTitle></CardHeader>
        <CardContent className="flex items-center gap-3">
          <Button variant="destructive" size="sm" title="清除全部调用记录、会话、定价、供应商配置" onClick={() => setConfirm({ title: '清空全部数据', desc: '将删除所有调用记录、会话、定价和供应商配置，此操作不可恢复。', onOk: () => clearMut.mutate() })}>清空全部数据</Button>
          <Button variant="destructive" size="sm" title="只删除手动添加的供应商，保留内置 Anthropic 和 OpenAI" onClick={() => setConfirm({ title: '清空第三方供应商', desc: '将删除所有手动添加的供应商，内置 Anthropic 和 OpenAI 将保留。', onOk: () => clearProvidersMut.mutate() })}>清空第三方供应商</Button>
          <Button variant="destructive" size="sm" title="删除所有调用记录和会话，保留供应商配置和定价" onClick={() => setConfirm({ title: '清空全部会话记录', desc: '将删除所有调用记录和会话，供应商配置和定价保留。', onOk: () => clearSessionsMut.mutate() })}>清空全部会话记录</Button>
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

const BUILTIN_PROVIDERS: Record<string, string> = { anthropic: 'anthropic', openai: 'openai' };

function ProviderItem({ provider, baseUrl, baseUrlAnthropic, apiKey, enabled, color, models, syncStatus, onToggle, onUpdate, onDelete }: {
  provider: string; baseUrl: string; baseUrlAnthropic: string; apiKey: string; enabled: boolean; color: string;
  models: any[]; syncStatus: any; onToggle: (v: boolean) => void; onUpdate: (d: Record<string, string>) => void;
  onDelete: () => void;
}) {
  const [keyValue, setKeyValue] = useState(apiKey);
  const [urlOpenAI, setUrlOpenAI] = useState(baseUrl);
  const [urlAnthropic, setUrlAnthropic] = useState(baseUrlAnthropic);
  const [expanded, setExpanded] = useState(false);
  const isBuiltin = provider in BUILTIN_PROVIDERS;
  const fmt = BUILTIN_PROVIDERS[provider] || '';
  const qc = useQueryClient();

  const refreshMut = useMutation({
    mutationFn: (p: string) => api.refreshProviderModels(p),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['provider-models'] });
      qc.invalidateQueries({ queryKey: ['provider-models-status'] });
    },
  });
  const toggleModelMut = useMutation({
    mutationFn: (d: { provider: string; model: string; enabled: boolean }) => api.setProviderModelEnabled(d.provider, d.model, d.enabled),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['provider-models'] }),
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
                <span className="text-sm font-semibold truncate">{displayName(provider)}</span>
                <Badge variant="secondary" className="text-[10px] font-mono flex-shrink-0">{(models || []).length} 个模型</Badge>
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
          {/* 同步状态行 */}
          <div className="flex items-center gap-2 px-4 py-1.5 text-[11px] text-[#6e6e73] border-b border-[#f2f2f7]">
            <Button variant="ghost" size="sm" className="h-6 text-xs"
              onClick={() => { refreshMut.mutate(provider); }}
              disabled={refreshMut.isPending}>
              <RefreshCw className="h-3 w-3 mr-1" />刷新模型与定价
            </Button>
            {syncStatus?.status === 'error' && (
              <span className="text-red-500 truncate">同步失败：{syncStatus.error}</span>
            )}
            {syncStatus?.status === 'no_key' && (
              <span>未配置 API Key，配置后自动获取模型与定价</span>
            )}
            {syncStatus?.status === 'ok' && (
              <span>已同步 {syncStatus.model_count} 个模型 / {syncStatus.priced_count} 个有定价 · {new Date(syncStatus.updated_at).toLocaleString('zh-CN', { hour12: false })}</span>
            )}
          </div>
          {/* 表头 */}
          <div className="flex items-center gap-2 text-[11px] font-medium text-gray-500 px-4 py-1 min-w-fit">
            <span className="flex-1 min-w-0">模型</span>
            <span className="w-16 text-center shrink-0">输出</span>
            <span className="w-16 text-center shrink-0">输入(未命中)</span>
            <span className="w-16 text-center shrink-0">输入(命中)</span>
            <span className="w-10 text-center shrink-0">启用</span>
          </div>
          {/* 模型清单（探测驱动；不可用置灰；价格直读行内列） */}
          {(models || []).map((m: any) => {
            const grey = !m.available;
            const hasPrice = (m.input_price || 0) > 0 || (m.output_price || 0) > 0;
            return (
              <div key={m.model} className={`flex items-center gap-2 text-xs py-1.5 px-4 rounded hover:bg-muted/50 min-w-fit ${grey ? 'opacity-50' : ''}`}>
                <span className="flex-1 min-w-0 font-mono text-gray-500 truncate">
                  {m.model}
                  {grey && <span className="ml-1 text-[10px] text-[#aeaeb2]">不可用</span>}
                </span>
                {hasPrice ? (
                  <>
                    <span className="w-16 text-center font-mono shrink-0">{CURRENCIES[m.currency || 'CNY']?.symbol || '￥'}{m.output_price.toFixed(2)}</span>
                    <span className="w-16 text-center font-mono shrink-0">{CURRENCIES[m.currency || 'CNY']?.symbol || '￥'}{m.input_price.toFixed(3)}</span>
                    <span className="w-16 text-center font-mono shrink-0">{CURRENCIES[m.currency || 'CNY']?.symbol || '￥'}{m.cache_input_price.toFixed(3)}</span>
                  </>
                ) : (
                  <>
                    <span className="w-16 text-center text-[#aeaeb2] shrink-0">—</span>
                    <span className="w-16 text-center text-[#aeaeb2] shrink-0">—</span>
                    <span className="w-16 text-center text-[#aeaeb2] shrink-0">—</span>
                  </>
                )}
                <span className="w-10 text-center shrink-0">
                  <Switch checked={!!m.enabled} onCheckedChange={(v) => toggleModelMut.mutate({ provider, model: m.model, enabled: v })} />
                </span>
              </div>
            );
          })}
          {(!models || models.length === 0) && (
            <p className="text-xs text-gray-400 py-1 px-4">暂无模型 — 配置 API Key 后自动获取</p>
          )}
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

function TimezoneSelector() {
  const qc = useQueryClient();
  const { data: config } = useQuery({ queryKey: ['config'], queryFn: api.getConfig });
  const tzMut = useMutation({
    mutationFn: (t: string) => api.updateConfig({ timezone: t }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['config'] }),
  });

  return (
    <div className="flex items-center gap-3">
      <span className="text-xs text-gray-500">选择面板统计的时间归属时区，图表与每日统计将按此时区归日：</span>
      <select
        className="text-sm border border-[#e5e5ea] rounded-lg px-3 py-1.5 bg-white focus:outline-none focus:ring-2 focus:ring-[#0071e3]"
        value={String(config?.timezone ?? '8')}
        onChange={e => tzMut.mutate(e.target.value)}
      >
        <option value="0">UTC+0</option>
        <option value="8">UTC+8</option>
      </select>
    </div>
  );
}
