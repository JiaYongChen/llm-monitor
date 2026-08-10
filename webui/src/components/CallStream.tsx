import { Link } from 'react-router-dom';
import { formatTime } from '../lib/utils';

export default function CallStream({ calls }: { calls: any[] }) {
  return (
    <div className="bg-gray-900 rounded-lg p-4 border border-gray-800">
      <h3 className="text-sm font-semibold text-gray-400 mb-3">实时调用流</h3>
      <div className="space-y-1">
        {calls.map((call) => (
          <Link key={call.id} to={`/calls/${call.id}`} className="flex items-center justify-between py-1.5 px-2 rounded hover:bg-gray-800 text-sm">
            <div className="flex items-center gap-3">
              <span className="text-gray-500 w-16 text-xs font-mono">{formatTime(call.created_at, 'time')}</span>
              <span className="text-gray-300 w-20">{call.provider}</span>
              <span className="text-gray-500 truncate max-w-[200px]">{call.model}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className={`w-2 h-2 rounded-full ${call.status_code === 200 ? 'bg-green-500' : 'bg-red-500'}`} />
              <span className="text-gray-400">{(call.duration_ms / 1000).toFixed(1)}s</span>
            </div>
          </Link>
        ))}
        {calls.length === 0 && <div className="text-gray-600 text-center py-8">暂无调用</div>}
      </div>
    </div>
  );
}
