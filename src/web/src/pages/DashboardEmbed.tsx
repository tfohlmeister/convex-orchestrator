import { useEffect, useRef, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';

// Embed the official Convex dashboard in an iframe and reply to its
// `dashboard-credentials-request` postMessage with this instance's credentials.
// This is the documented embedding API (see Convex docs § Embedding the
// dashboard); it skips the login form entirely.
export function DashboardEmbedPage() {
  const { name = '' } = useParams();
  const ref = useRef<HTMLIFrameElement | null>(null);
  const [ready, setReady] = useState(false);

  const query = useQuery({
    queryKey: ['instance', name],
    queryFn: () => api.getInstance(name),
    enabled: !!name,
  });

  useEffect(() => {
    if (!query.data) return;
    const inst = query.data.instance;
    const handler = (event: MessageEvent) => {
      if (event.source !== ref.current?.contentWindow) return;
      if ((event.data as { type?: string } | null)?.type !== 'dashboard-credentials-request') {
        return;
      }
      ref.current?.contentWindow?.postMessage(
        {
          type: 'dashboard-credentials',
          adminKey: inst.adminKey,
          deploymentUrl: inst.cloudUrl,
          deploymentName: inst.name,
        },
        '*',
      );
      setReady(true);
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [query.data]);

  if (query.isLoading) return <p className="text-slate-400 p-6">Loading…</p>;
  if (query.error) return <p className="text-red-400 p-6">{(query.error as Error).message}</p>;
  if (!query.data) return null;

  // Reuse the scheme + port the user came in on, so the iframe lands on the
  // same reverse proxy (HTTPS in production, http://...:18000 in HTTP spikes).
  const port = window.location.port ? `:${window.location.port}` : '';
  const dashboardOrigin = `${window.location.protocol}//dashboard.${query.data.instance.baseDomain}${port}`;

  return (
    <div className="fixed inset-0 flex flex-col bg-slate-950">
      <div className="flex items-center gap-3 px-3 py-1.5 border-b border-slate-800 text-xs text-slate-400">
        <Link to="/instances" className="hover:text-slate-200">
          ← Instances
        </Link>
        <span className="text-slate-600">/</span>
        <span className="font-mono text-slate-200">{name}</span>
        <span className="ml-auto text-slate-600">
          {ready ? 'credentials handed off' : 'waiting for iframe handshake…'}
        </span>
      </div>
      <iframe
        ref={ref}
        title={`Convex Dashboard: ${name}`}
        src={dashboardOrigin}
        className="flex-1 w-full border-0"
        allow="clipboard-write"
      />
    </div>
  );
}
