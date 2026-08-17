import { Link, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import * as api from '../api/client';

import { useCategoryColors, categoryColor, type CategoryColors } from '../lib/colors';
import { displayName } from '../lib/display';
import { collectTools } from '../lib/utils';

/** 已知工具的元数据（图标字母；颜色由类别注册表决定） */
const KNOWN_TOOLS: Record<string, { l: string }> = {
  'claudecode': { l: 'C' },
  'codex': { l: 'X' },
};
/** 已知工具元数据查找（大小写不敏感）。
 *  用 hasOwnProperty 防原型链键名（如 '__proto__'）误判为已知工具——与后端注册表的原型安全处理同源。 */
function knownMeta(tool: string): { l: string } | undefined {
  if (Object.prototype.hasOwnProperty.call(KNOWN_TOOLS, tool)) return KNOWN_TOOLS[tool];
  const lower = tool.toLowerCase();
  const hit = Object.keys(KNOWN_TOOLS).find(k => k.toLowerCase() === lower);
  return hit ? KNOWN_TOOLS[hit] : undefined;
}

function toolMeta(tool: string, colors?: CategoryColors): { l: string; c: string } {
  const known = knownMeta(tool);
  // 图标色：tool 池注册表命中 → 色板色；未命中/未加载 → 灰兜底
  const c = categoryColor(tool, 'tool', colors) || '#9ca3af';
  return known ? { l: known.l, c } : { l: tool.slice(0, 2).toUpperCase(), c };
}

export default function Sidebar() {
  const loc = useLocation();
  const { data: sessions } = useQuery({ queryKey: ['sessions'], queryFn: () => api.listSessions(), refetchInterval: 5000 });
  const { data: providers } = useQuery({ queryKey: ['providers'], queryFn: api.listProviders });
  const { data: colors } = useCategoryColors();

  const groups = new Map<string, typeof sessions>();
  sessions?.forEach((s: any) => { const l = groups.get(s.tool) || []; l.push(s); groups.set(s.tool, l); });

  const enabledProviders = (providers as any[])?.filter((p: any) => p.enabled === 1).sort((a: any, b: any) => {
    const aBuiltin = a.provider === 'anthropic' || a.provider === 'openai' ? 0 : 1;
    const bBuiltin = b.provider === 'anthropic' || b.provider === 'openai' ? 0 : 1;
    return aBuiltin - bBuiltin || a.provider.localeCompare(b.provider);
  }) || [];

  /** 动态计算所有出现过的工具（含已知工具的预设顺序；大小写不敏感去重） */
  const allTools = useMemo(
    () => collectTools(Object.keys(KNOWN_TOOLS), sessions?.map((s: any) => s.tool) ?? []),
    [sessions],
  );

  /** 详情页路由激活判断（大小写不敏感，路由参数可能为任意大小写） */
  const toolActive = (tool: string) => loc.pathname.toLowerCase() === `/tools/${tool.toLowerCase()}`;
  const providerActive = (provider: string) => loc.pathname.toLowerCase() === `/providers/${provider.toLowerCase()}`;

  return (
    <aside className="flex flex-col h-screen select-none" style={{ width: 230, background: '#fafafc', borderRight: '1px solid #e5e5ea' }}>
      <nav className="flex-1 overflow-y-auto px-3 py-3">
        <Link to="/" className={`flex items-center gap-2.5 px-3 py-2 mb-3 rounded-lg text-sm transition-colors ${loc.pathname === '/' ? 'bg-[#e8e7ff] text-[#5e5ce6] font-medium' : 'text-[#6e6e73] hover:bg-[#f0f0f4]'}`}>
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
            const m = toolMeta(tool, colors);
            return (
              <Link
                key={tool}
                to={`/tools/${tool}`}
                className={`flex items-center gap-2 pl-7 pr-3 py-1.5 rounded-md text-[13px] transition-colors w-full text-left ${toolActive(tool) ? 'bg-[#e8e7ff] text-[#5e5ce6] font-medium' : 'text-[#6e6e73] hover:bg-[#f0f0f4]'}`}
              >
                <div className="w-4 h-4 rounded flex items-center justify-center text-[9px] font-bold text-white flex-shrink-0" style={{ background: m.c }}>{m.l}</div>
                <span className="truncate">{displayName(tool)}</span>
              </Link>
            );
          })}
        </div>

        {/* 供应商选择 */}
        <div className="mb-4">
          <div className="flex items-center gap-2 px-3 mb-1.5">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-[#aeaeb2]">供应商</span>
          </div>
          {enabledProviders.map((p: any) => (
            <Link
              key={p.provider}
              to={`/providers/${p.provider}`}
              className={`flex items-center gap-2 pl-7 pr-3 py-1.5 rounded-md text-[13px] transition-colors w-full text-left ${providerActive(p.provider) ? 'bg-[#e8e7ff] text-[#5e5ce6] font-medium' : 'text-[#6e6e73] hover:bg-[#f0f0f4]'}`}
            >
              <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: categoryColor(p.provider, 'provider', colors) || '#9ca3af' }} />
              <span className="truncate">{displayName(p.provider)}</span>
            </Link>
          ))}
        </div>

        {/* 会话 */}
        <div className="flex items-center gap-2 px-3 mb-1.5">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-[#aeaeb2]">会话</span>
        </div>
        {[...groups.entries()].map(([tool, ss]: any) => {
          const m = toolMeta(tool, colors);
          return (
            <div key={tool} className="mb-3">
              <div className="flex items-center gap-2 pl-7 pr-3 mb-1">
                <div className="w-4 h-4 rounded flex items-center justify-center text-[8px] font-bold text-white" style={{ background: m.c }}>{m.l}</div>
                <span className="text-[11px] font-semibold uppercase tracking-wider text-[#aeaeb2]">{displayName(tool)}</span>
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
