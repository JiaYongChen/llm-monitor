import { displayName } from '../lib/display';

/** 工具对应的内置供应商（无需覆写；大小写不敏感）。会话页判断停用回退时复用。 */
export function builtinProviderFor(tool: string): 'anthropic' | 'openai' | null {
  const lower = (tool || '').toLowerCase();
  if (lower === 'claudecode') return 'anthropic';
  if (lower === 'codex') return 'openai';
  return null;
}

/** 上游选择器面板（工具详情页 + 会话详情页共用）：供应商下拉 + 转发地址提示 + 模型下拉 + 强制使用提示。
 *  持久化留在调用方：工具页写 tool_config、会话页写 session 上游/模型，组件仅回传选择结果。 */
export default function UpstreamSelectorPanel({ tool, provider, model, providers, providerModels, onProviderChange, onModelChange }: {
  tool: string;
  provider: string;
  model: string;
  providers: any[];
  providerModels?: any[];
  onProviderChange: (next: string | null, defaultModel: string | null) => void;
  onModelChange: (next: string | null) => void;
}) {
  const toolLower = tool.toLowerCase();
  const toolBuiltin = builtinProviderFor(tool);
  const enabledProviders = providers.filter((p: any) => p.enabled && p.provider !== toolBuiltin);
  const currentUpstream = provider || '';
  const currentModel = model || '';
  // 模型列表完全由探测结果（provider_models）驱动；无启用模型行时返回空 → 模型下拉禁用
  const buildModelOptions = (prov: string): { value: string; disabled: boolean }[] => {
    return (providerModels || [])
      .filter((m: any) => m.provider === prov && m.enabled)
      .map((m: any) => ({
        value: m.model,
        disabled: !m.available, // 不可用模型置灰显示（保留可选列表，disabled 选项）
      }));
  };
  const modelOptions = currentUpstream ? buildModelOptions(currentUpstream) : [];

  return (
    <div className="p-4 rounded-xl bg-white border border-[#e5e5ea] shadow-sm space-y-3">
      <div className="flex items-center gap-3">
        <span className="text-xs font-medium text-[#aeaeb2] uppercase tracking-wider w-14 shrink-0">供应商</span>
        <select
          className="text-sm border border-[#e5e5ea] rounded-lg px-3 py-1.5 bg-white text-[#1d1d1f] focus:outline-none focus:ring-2 focus:ring-[#0071e3] w-[200px]"
          value={currentUpstream}
          onChange={(e) => {
            const val = e.target.value || null;
            if (!val) {
              onProviderChange(null, null);
            } else {
              // 第三方供应商 → 默认选第一个可用模型（探测结果优先，无探测数据回落 pricing 派生）
              const defaultModel = buildModelOptions(val).find((o: any) => !o.disabled)?.value || null;
              onProviderChange(val, defaultModel);
            }
          }}
        >
          <option value="">跟随请求路径（{displayName(tool)}）</option>
          {enabledProviders.map((p: any) => (
            <option key={p.provider} value={p.provider}>{displayName(p.provider)}</option>
          ))}
        </select>
        {currentUpstream && (() => {
          const officialUrls: Record<string, string> = { anthropic: 'https://api.anthropic.com', openai: 'https://api.openai.com' };
          const up = providers.find((p: any) => p.provider === currentUpstream);
          const baseUrl = (toolLower === 'claudecode' && up?.base_url_anthropic)
            ? up.base_url_anthropic
            : (up?.base_url || officialUrls[currentUpstream] || '');
          return <span className="text-xs text-[#30b48b]">转发到 {displayName(currentUpstream)} — <span className="font-mono">{baseUrl}</span></span>;
        })()}
      </div>
      <div className="flex items-center gap-3">
        <span className="text-xs font-medium text-[#aeaeb2] uppercase tracking-wider w-14 shrink-0">模型</span>
        {currentUpstream ? (
          // 无任何启用模型（未探测/未同步/全部手动关闭）→ 禁用下拉，与设置页模型清单语义一致
          <select
            className="text-sm border border-[#e5e5ea] rounded-lg px-3 py-1.5 bg-white text-[#1d1d1f] focus:outline-none focus:ring-2 focus:ring-[#0071e3] w-[200px] disabled:opacity-50 disabled:cursor-not-allowed"
            value={modelOptions.length > 0 ? currentModel : ''}
            onChange={(e) => onModelChange(e.target.value || null)}
            disabled={modelOptions.length === 0}
          >
            {modelOptions.length === 0 ? (
              <option value="">暂无可用模型</option>
            ) : (
              modelOptions.map(opt => (
                <option key={opt.value} value={opt.value} disabled={opt.disabled}>
                  {displayName(opt.value)}{opt.disabled ? '（不可用）' : ''}
                </option>
              ))
            )}
          </select>
        ) : (
          <span className="text-sm text-[#aeaeb2] px-3 py-1.5">跟随客户端请求</span>
        )}
        {modelOptions.length > 0 && currentModel && (
          <span className="text-xs text-[#0071e3]">强制使用 {displayName(currentModel)}</span>
        )}
      </div>
    </div>
  );
}
