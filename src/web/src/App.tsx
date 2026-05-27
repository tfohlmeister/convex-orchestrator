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
        <p className="text-[var(--color-soft)] text-sm">Loading…</p>
      </div>
    );
  }

  if (authMode === 'bearer' && !token) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-[var(--color-soft)] text-sm">Token required</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col md:flex-row">
      <aside
        className="
          md:w-60 md:shrink-0 md:min-h-screen
          md:border-r border-b md:border-b-0
          border-[var(--color-rule)]
          bg-[var(--color-paper)]/70
          backdrop-blur-sm
          px-5 py-6
          flex md:flex-col
          items-center md:items-stretch
          gap-6
        "
      >
        <Brand />
        <nav className="flex md:flex-col gap-1 flex-1">
          <NavItem to="/instances">Instances</NavItem>
        </nav>
        <div className="hidden md:block text-[10px] text-[var(--color-soft)] font-mono leading-relaxed">
          <div className="mb-1 tracking-[0.18em] uppercase">v0.0.1</div>
          <div className="opacity-70">Self-hosted Convex backends</div>
        </div>
        {authMode === 'bearer' && (
          <button
            onClick={() => {
              clearToken();
              setTokenState('');
            }}
            className="text-[11px] text-[var(--color-soft)] hover:text-[var(--color-ink)] font-mono tracking-wider uppercase text-left transition-colors"
          >
            Clear token
          </button>
        )}
      </aside>
      <main className="flex-1 min-w-0 px-6 md:px-10 py-8 md:py-10">
        <div className="max-w-[1400px] mx-auto">
          <Routes>
            <Route path="/" element={<Navigate to="/instances" replace />} />
            <Route path="/instances" element={<InstancesPage />} />
            <Route path="/instances/:name/dashboard" element={<DashboardEmbedPage />} />
            <Route path="/instances/:name" element={<InstanceDetailPage />} />
          </Routes>
        </div>
      </main>
    </div>
  );
}

function Brand() {
  return (
    <div className="flex items-center gap-2.5">
      <span
        aria-hidden
        className="inline-block w-2.5 h-2.5 rounded-full bg-[var(--color-accent)]"
      />
      <span className="font-serif text-[22px] leading-none tracking-tight text-[var(--color-ink)]">
        <span className="italic">convex</span>
        <span className="text-[var(--color-muted)]">.</span>
        <span>orch</span>
      </span>
    </div>
  );
}

function NavItem({ to, children }: { to: string; children: React.ReactNode }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        `relative px-3 py-2 rounded-md font-mono text-[11px] tracking-[0.14em] uppercase transition-colors
        ${
          isActive
            ? 'text-[var(--color-ink)] bg-[var(--color-paper-2)]'
            : 'text-[var(--color-soft)] hover:text-[var(--color-ink)] hover:bg-[var(--color-paper-2)]/60'
        }`
      }
    >
      {({ isActive }) => (
        <>
          {isActive && (
            <span
              aria-hidden
              className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-4 bg-[var(--color-accent)] rounded-r"
            />
          )}
          <span className="pl-1">{children}</span>
        </>
      )}
    </NavLink>
  );
}
