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
export default function UpstreamSelectorPanel({ tool, provider, model, providers, pricing, onProviderChange, onModelChange }: {
  tool: string;
  provider: string;
  model: string;
  providers: any[];
  pricing: any[];
  onProviderChange: (next: string | null, defaultModel: string | null) => void;
  onModelChange: (next: string | null) => void;
}) {
  const toolLower = tool.toLowerCase();
  const toolBuiltin = builtinProviderFor(tool);
  const enabledProviders = providers.filter((p: any) => p.enabled && p.provider !== toolBuiltin);
  const currentUpstream = provider || '';
  const currentModel = model || '';
  // 模型列表跟随代理商：选了代理商则只显示该代理商的模型，否则显示全部，按添加顺序排列
  const modelOrder = (pricing || [])
    .filter((p: any) => !currentUpstream || p.provider === currentUpstream)
    .sort((a: any, b: any) => a.id - b.id);
  const seen = new Set<string>();
  const models = modelOrder.filter((p: any) => {
    if (seen.has(p.model)) return false;
    seen.add(p.model);
    return true;
  }).map((p: any) => p.model as string);

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
              // 第三方供应商 → 默认选第一个模型（排序去重）
              const filteredModels = [...new Set<string>((pricing || [])
                .filter((p: any) => p.provider === val)
                .map((p: any) => p.model as string)
              )].sort();
              onProviderChange(val, filteredModels[0] || null);
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
          <select
            className="text-sm border border-[#e5e5ea] rounded-lg px-3 py-1.5 bg-white text-[#1d1d1f] focus:outline-none focus:ring-2 focus:ring-[#0071e3] w-[200px]"
            value={currentModel}
            onChange={(e) => onModelChange(e.target.value || null)}
          >
            {models.map((m: string) => (
              <option key={m} value={m}>{displayName(m)}</option>
            ))}
          </select>
        ) : (
          <span className="text-sm text-[#aeaeb2] px-3 py-1.5">跟随客户端请求</span>
        )}
        {currentModel && (
          <span className="text-xs text-[#0071e3]">强制使用 {displayName(currentModel)}</span>
        )}
      </div>
    </div>
  );
}
