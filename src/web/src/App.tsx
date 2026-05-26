import { useState, useEffect } from 'react';
import { Routes, Route, NavLink, Navigate } from 'react-router-dom';
import { InstancesPage } from './pages/Instances';
import { InstanceDetailPage } from './pages/InstanceDetail';
import { DashboardEmbedPage } from './pages/DashboardEmbed';
import { api, getToken, setToken, clearToken, type AuthMode } from './api';

export function App() {
  const [token, setTokenState] = useState(getToken());
  const [authMode, setAuthMode] = useState<AuthMode | null>(null);

  useEffect(() => {
    api
      .getAuthMode()
      .then(setAuthMode)
      .catch(() => setAuthMode('bearer'));
  }, []);

  useEffect(() => {
    if (authMode === 'bearer' && !token) {
      const entered = window.prompt('Enter ORCHESTRATOR_ADMIN_TOKEN');
      if (entered) {
        setToken(entered);
        setTokenState(entered);
      }
    }
  }, [authMode, token]);

  if (authMode === null) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-slate-400">Loading…</p>
      </div>
    );
  }

  if (authMode === 'bearer' && !token) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-slate-400">Token required</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex">
      <aside className="w-56 bg-slate-900 border-r border-slate-800 p-4 flex flex-col gap-4">
        <h1 className="text-lg font-semibold tracking-tight">convex-orchestrator</h1>
        <nav className="flex flex-col gap-1">
          <NavLink
            to="/instances"
            className={({ isActive }) =>
              `px-3 py-2 rounded-md text-sm ${isActive ? 'bg-slate-800 text-white' : 'text-slate-300 hover:bg-slate-800/60'}`
            }
          >
            Instances
          </NavLink>
        </nav>
        {authMode === 'bearer' && (
          <button
            onClick={() => {
              clearToken();
              setTokenState('');
            }}
            className="mt-auto text-xs text-slate-500 hover:text-slate-300 text-left"
          >
            Clear token
          </button>
        )}
      </aside>
      <main className="flex-1 p-6">
        <Routes>
          <Route path="/" element={<Navigate to="/instances" replace />} />
          <Route path="/instances" element={<InstancesPage />} />
          <Route path="/instances/:name" element={<InstanceDetailPage />} />
          <Route path="/instances/:name/dashboard" element={<DashboardEmbedPage />} />
        </Routes>
      </main>
    </div>
  );
}
