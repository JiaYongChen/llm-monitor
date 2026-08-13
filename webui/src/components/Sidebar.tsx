import { Link, useLocation, useSearchParams, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import * as api from '../api/client';

import { providerColor } from '../lib/currency';
import { capitalizeFirst, lookupCi } from '../lib/utils';

/** 工具显示名称映射 */
const TOOL_DISPLAY: Record<string, string> = {
  ClaudeCode: 'ClaudeCode', Codex: 'Codex',
};

/** 已知工具的元数据（图标、颜色） */
const KNOWN_TOOLS: Record<string, { l: string; c: string }> = {
  'ClaudeCode': { l: 'C', c: '#d97706' },
  'Codex': { l: 'X', c: '#16a34a' },
};
const DEFAULT_META = { l: '?', c: '#9ca3af' };

/** 已知工具元数据查找（大小写不敏感） */
function knownMeta(tool: string): { l: string; c: string } | undefined {
  if (KNOWN_TOOLS[tool]) return KNOWN_TOOLS[tool];
  const lower = tool.toLowerCase();
  const hit = Object.keys(KNOWN_TOOLS).find(k => k.toLowerCase() === lower);
  return hit ? KNOWN_TOOLS[hit] : undefined;
}

/** 生成工具图标的 HSL 色值（用于未知工具的动态颜色） */
function toolColor(tool: string): string {
  const meta = knownMeta(tool);
  if (meta) return meta.c;
  // 基于名称生成确定性颜色
  let hash = 0;
  for (let i = 0; i < tool.length; i++) hash = ((hash << 5) - hash) + tool.charCodeAt(i);
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 55%, 48%)`;
}

function toolMeta(tool: string): { l: string; c: string } {
  return knownMeta(tool) ?? { l: tool.slice(0, 2).toUpperCase(), c: toolColor(tool) };
}

export default function Sidebar() {
  const loc = useLocation();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const selectedProvider = searchParams.get('provider') || '';
  const selectedTool = searchParams.get('tool') || '';

  const { data: sessions } = useQuery({ queryKey: ['sessions'], queryFn: () => api.listSessions(), refetchInterval: 5000 });
  const { data: providers } = useQuery({ queryKey: ['providers'], queryFn: api.listProviders });

  const groups = new Map<string, typeof sessions>();
  sessions?.forEach((s: any) => { const l = groups.get(s.tool) || []; l.push(s); groups.set(s.tool, l); });

  const enabledProviders = (providers as any[])?.filter((p: any) => p.enabled === 1).sort((a: any, b: any) => {
    const aBuiltin = a.provider === 'Anthropic' || a.provider === 'OpenAI' ? 0 : 1;
    const bBuiltin = b.provider === 'Anthropic' || b.provider === 'OpenAI' ? 0 : 1;
    return aBuiltin - bBuiltin || a.provider.localeCompare(b.provider);
  }) || [];

  /** 动态计算所有出现过的工具（含已知工具的预设顺序） */
  const allTools = useMemo(() => {
    const seen = new Set<string>();
    // 先加入已知工具（保持固定顺序）
    for (const t of Object.keys(KNOWN_TOOLS)) seen.add(t);
    // 再加入数据库中实际存在的未知工具
    sessions?.forEach((s: any) => seen.add(s.tool));
    return [...seen];
  }, [sessions]);

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams();
    const other = key === 'tool' ? 'provider' : 'tool';
    if (value) { next.set(key, value); }
    navigate(`/?${next.toString()}`, { replace: true });
  };

  return (
    <aside className="flex flex-col h-screen select-none" style={{ width: 230, background: '#fafafc', borderRight: '1px solid #e5e5ea' }}>
      <nav className="flex-1 overflow-y-auto px-3 py-3">
        <Link to="/" className={`flex items-center gap-2.5 px-3 py-2 mb-3 rounded-lg text-sm transition-colors ${loc.pathname === '/' && !selectedProvider && !selectedTool ? 'bg-[#e8e7ff] text-[#5e5ce6] font-medium' : 'text-[#6e6e73] hover:bg-[#f0f0f4]'}`}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>
          总览
        </Link>

        <div className="mb-4 -mx-[5px]" style={{ borderTop: '1px solid #e5e5ea' }} />

        {/* 工具筛选 — 动态显示所有检测到的工具 */}
        <div className="mb-4">
          <div className="flex items-center gap-2 px-3 mb-1.5">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-[#aeaeb2]">工具</span>
          </div>
          {allTools.map(tool => {
            const m = toolMeta(tool);
            return (
              <button
                key={tool}
                onClick={() => { if (selectedTool !== tool) setParam('tool', tool); }}
                className={`flex items-center gap-2 pl-7 pr-3 py-1.5 rounded-md text-[13px] transition-colors w-full text-left ${selectedTool === tool ? 'bg-[#e8e7ff] text-[#5e5ce6] font-medium' : 'text-[#6e6e73] hover:bg-[#f0f0f4]'}`}
              >
                <div className="w-4 h-4 rounded flex items-center justify-center text-[9px] font-bold text-white flex-shrink-0" style={{ background: m.c }}>{m.l}</div>
                <span className="truncate">{lookupCi(TOOL_DISPLAY, tool) || capitalizeFirst(tool)}</span>
              </button>
            );
          })}
        </div>

        {/* 供应商选择 */}
        <div className="mb-4">
          <div className="flex items-center gap-2 px-3 mb-1.5">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-[#aeaeb2]">供应商</span>
          </div>
          {enabledProviders.map((p: any) => (
            <button
              key={p.provider}
              onClick={() => { if (selectedProvider !== p.provider) setParam('provider', p.provider); }}
              className={`flex items-center gap-2 pl-7 pr-3 py-1.5 rounded-md text-[13px] transition-colors w-full text-left ${selectedProvider === p.provider ? 'bg-[#e8e7ff] text-[#5e5ce6] font-medium' : 'text-[#6e6e73] hover:bg-[#f0f0f4]'}`}
            >
              <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: providerColor(p.provider) }} />
              <span className="truncate">{capitalizeFirst(p.provider)}</span>
            </button>
          ))}
        </div>

        {/* 会话 */}
        <div className="flex items-center gap-2 px-3 mb-1.5">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-[#aeaeb2]">会话</span>
        </div>
        {[...groups.entries()].map(([tool, ss]: any) => {
          const m = toolMeta(tool);
          return (
            <div key={tool} className="mb-3">
              <div className="flex items-center gap-2 pl-7 pr-3 mb-1">
                <div className="w-4 h-4 rounded flex items-center justify-center text-[8px] font-bold text-white" style={{ background: m.c }}>{m.l}</div>
                <span className="text-[11px] font-semibold uppercase tracking-wider text-[#aeaeb2]">{lookupCi(TOOL_DISPLAY, tool) || capitalizeFirst(tool)}</span>
              </div>
              {ss?.slice(0, 20).map((s: any) => (
                <Link key={s.id} to={loc.pathname === `/sessions/${s.id}` ? '#' : `/sessions/${s.id}`}
                  onClick={loc.pathname === `/sessions/${s.id}` ? (e) => e.preventDefault() : undefined}
                  className={`flex items-center gap-2 pl-11 pr-3 py-1 rounded-md text-[13px] transition-colors ${loc.pathname === `/sessions/${s.id}` ? 'bg-[#e8e7ff] text-[#5e5ce6]' : 'text-[#6e6e73] hover:bg-[#f0f0f4]'}`}
                  title={s.label || `#${s.id}`}>
                  <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: s.status === 'active' ? m.c : '#dcdce0' }} />
                  <span className="truncate">{s.label || `#${s.id}`}</span>
                </Link>
              ))}
            </div>
          );
        })}
        {!sessions?.length && <div className="text-center py-8 text-xs text-[#aeaeb2]">暂无会话</div>}
      </nav>

      <div className="px-3 py-2.5 flex items-center justify-between" style={{ borderTop: '1px solid #e5e5ea' }}>
        <div className="flex items-center gap-2.5 py-2">
          <div className="w-7 h-7 rounded-lg flex items-center justify-center text-white text-[10px] font-bold" style={{ background: 'linear-gradient(135deg, #5e5ce6, #8b89f0)' }}>M</div>
          <span className="font-semibold text-sm text-[#1d1d1f]">Monitor</span>
        </div>
        <Link to="/settings" title="设置" className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors ${loc.pathname === '/settings' ? 'bg-[#e8e7ff] text-[#5e5ce6]' : 'text-[#6e6e73] hover:bg-[#f0f0f4]'}`}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
        </Link>
      </div>
    </aside>
  );
}
