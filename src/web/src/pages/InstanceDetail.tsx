import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { api, dashboardEmbedPath, getToken } from '../api';
import { StatusBadge } from '../components/StatusBadge';
import { ConnectionPanel } from '../components/ConnectionPanel';

export function InstanceDetailPage() {
  const { name = '' } = useParams();
  const query = useQuery({
    queryKey: ['instance', name],
    queryFn: () => api.getInstance(name),
    enabled: !!name,
  });

  if (query.isLoading) return <p className="text-slate-400">Loading…</p>;
  if (query.error) return <p className="text-red-400">{(query.error as Error).message}</p>;
  if (!query.data) return null;

  const { instance, samples, audit } = query.data;
  const chartData = samples.map((s) => ({
    t: new Date(s.takenAt).toLocaleTimeString(),
    rssMb: s.rssKb / 1024,
  }));

  return (
    <div className="space-y-6">
      <div>
        <Link to="/instances" className="text-sm text-slate-500 hover:text-slate-300">
          ← All instances
        </Link>
        <h1 className="text-2xl font-semibold mt-1 flex items-center gap-3">
          <span className="font-mono">{instance.name}</span>
          <StatusBadge status={instance.status} />
        </h1>
        <p className="text-sm text-slate-400 mt-1">
          <Link
            to={dashboardEmbedPath(instance.name)}
            className="text-emerald-400 hover:text-emerald-300 underline"
          >
            Open in Convex Dashboard ↗
          </Link>
        </p>
        {instance.lastError && (
          <p className="text-sm text-red-400 mt-2">Last error: {instance.lastError}</p>
        )}
      </div>

      <ConnectionPanel cloudUrl={instance.cloudUrl} adminKey={instance.adminKey} />

      <section>
        <h2 className="text-sm uppercase tracking-wide text-slate-400 mb-2">RSS (MB) · last 24h</h2>
        <div className="bg-slate-900 border border-slate-800 rounded-lg p-4 h-64">
          {chartData.length > 1 ? (
            <ResponsiveContainer>
              <LineChart data={chartData}>
                <XAxis dataKey="t" stroke="#475569" fontSize={10} />
                <YAxis
                  stroke="#475569"
                  fontSize={10}
                  domain={['dataMin - 5', 'dataMax + 5']}
                  allowDecimals={false}
                />
                <Tooltip contentStyle={{ background: '#0f172a', border: '1px solid #334155' }} />
                <Line
                  type="monotone"
                  dataKey="rssMb"
                  stroke="#34d399"
                  strokeWidth={2}
                  dot={false}
                />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <p className="text-slate-500 text-sm">Not enough samples yet (need 2+).</p>
          )}
        </div>
      </section>

      <section>
        <h2 className="text-sm uppercase tracking-wide text-slate-400 mb-2">Logs (stdout, live)</h2>
        <LogTail name={instance.name} />
      </section>

      <section>
        <h2 className="text-sm uppercase tracking-wide text-slate-400 mb-2">Audit</h2>
        <div className="bg-slate-900 border border-slate-800 rounded-lg p-4">
          <ul className="space-y-1 text-xs font-mono">
            {audit.map((a, idx) => (
              <li key={idx} className="flex gap-3">
                <span className="text-slate-500">{new Date(a.at).toISOString()}</span>
                <span className="text-amber-300">{a.action}</span>
                <span className="text-slate-300">{a.actor}</span>
                {a.details && <span className="text-slate-500">{a.details}</span>}
              </li>
            ))}
            {audit.length === 0 && <li className="text-slate-500">No audit entries.</li>}
          </ul>
        </div>
      </section>
    </div>
  );
}

function LogTail({ name }: { name: string }) {
  const [lines, setLines] = useState<string>('');
  const ref = useRef<HTMLPreElement | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const token = getToken();
    let aborted = false;
    void (async () => {
      const res = await fetch(`/api/instances/${name}/logs?stream=stdout&follow=1`, {
        signal: controller.signal,
        headers: { authorization: `Bearer ${token}` },
      });
      if (!res.body) return;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      while (!aborted) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) {
          setLines((prev) => (prev + decoder.decode(value)).slice(-50_000));
          requestAnimationFrame(() => {
            if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
          });
        }
      }
    })();
    return () => {
      aborted = true;
      controller.abort();
    };
  }, [name]);

  return (
    <pre
      ref={ref}
      className="bg-slate-950 border border-slate-800 rounded-lg p-3 h-72 overflow-auto text-xs font-mono text-slate-300 whitespace-pre-wrap"
    >
      {lines || 'Waiting for log lines…'}
    </pre>
  );
}
