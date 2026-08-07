import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import * as api from '../api/client';
import CallDetailPanel from '../components/CallDetailPanel';

export default function CallDetail() {
  const { id } = useParams<{ id: string }>();
  const { data: call } = useQuery({
    queryKey: ['call', Number(id)],
    queryFn: () => api.getCall(Number(id)),
    enabled: !!id,
  });

  if (!call) return <div className="p-6 text-sm" style={{ color: '#52525b' }}>加载中...</div>;

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <CallDetailPanel call={call} />
    </div>
  );
}
