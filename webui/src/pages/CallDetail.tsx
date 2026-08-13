import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import * as api from '../api/client';
import CallDetailPanel from '../components/CallDetailPanel';
import { displayName } from '../lib/display';

export default function CallDetail() {
  const { id } = useParams<{ id: string }>();
  const { data: call } = useQuery({
    queryKey: ['call', Number(id)],
    queryFn: () => api.getCall(Number(id)),
    enabled: !!id,
  });
  const { data: session } = useQuery({
    queryKey: ['session', call?.session_id],
    queryFn: () => api.getSession(call!.session_id!),
    enabled: !!call?.session_id,
  });

  if (!call) return <div className="p-6 text-sm" style={{ color: '#52525b' }}>加载中...</div>;

  const toolName = displayName(call.tool);
  const sessionLabel = session?.label || (session ? `会话 #${session.id}` : '');

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="text-center mb-6 sticky top-0 z-10 bg-[#f5f5f7] -mt-6 pt-6 pb-3">
        <h1 className="text-lg font-bold text-[#1d1d1f]">
          {toolName && <span>{toolName}</span>}
          {toolName && sessionLabel && <span className="mx-2 text-[#aeaeb2]">+</span>}
          {sessionLabel && <span>{sessionLabel}</span>}
        </h1>
      </div>
      <CallDetailPanel call={call} />
    </div>
  );
}
