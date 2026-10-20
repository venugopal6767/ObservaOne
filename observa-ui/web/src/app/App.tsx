// Boot: ask the server who is signed in, then show the sign-in page, the forced MFA setup, or the app.
import { lazy, Suspense, useCallback, useEffect, useState, type ComponentType } from 'react';
import { Navigate, Route, Routes, useLocation, Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { api, type Me } from '@/lib/api';
import { AppProvider, useApp } from './AppContext';
import { Shell } from './Shell';
import { findRoute } from './routes';
import { DialogProvider, StateView, toast } from '@/components/ui';
import { LoginPage } from '@/pages/Login';
import { ForcedMfa } from '@/pages/Mfa';

const PAGES: Record<string, ComponentType> = {
  '/overview': lazy(() => import('@/pages/Overview')),
  '/dashboards': lazy(() => import('@/pages/Dashboards')),
  '/dashboards/:id': lazy(() => import('@/pages/DashboardView')),
  '/metrics': lazy(() => import('@/pages/metrics/Overview')),
  '/metrics/explore': lazy(() => import('@/pages/metrics/Explorer')),
  '/metrics/host/:host': lazy(() => import('@/pages/metrics/HostView')),
  '/metrics/kubernetes': lazy(() => import('@/pages/metrics/Kubernetes')),
  '/metrics/investigate': lazy(() => import('@/pages/metrics/Investigate')),
  '/logs': lazy(() => import('@/pages/Logs')),
  '/traces': lazy(() => import('@/pages/Traces')),
  '/services': lazy(() => import('@/pages/Services')),
  '/infrastructure': lazy(() => import('@/pages/Infrastructure')),
  '/infrastructure/add': lazy(() => import('@/pages/AddTarget')),
  '/alerting': lazy(() => import('@/pages/Alerting')),
  '/alerting/alert/:id': lazy(() => import('@/pages/AlertDetail')),
  '/alerting/open': lazy(() => import('@/pages/AlertOpen')),
  '/alerting/active': lazy(() => import('@/pages/Alerting')),
  '/alerting/rules': lazy(() => import('@/pages/Alerting')),
  '/alerting/policies': lazy(() => import('@/pages/Alerting')),
  '/alerting/channels': lazy(() => import('@/pages/Alerting')),
  '/alerting/silences': lazy(() => import('@/pages/Alerting')),
  '/alerting/inhibition': lazy(() => import('@/pages/Alerting')),
  '/agents': lazy(() => import('@/pages/Agents')),
  '/datasources': lazy(() => import('@/pages/DataSources')),
  '/settings': lazy(() => import('@/pages/Settings')),
};

export function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const qc = useQueryClient();
  const location = useLocation();

  const boot = useCallback(async () => {
    try { setMe(await api<Me>('/me')); } catch { setMe(null); }
  }, []);
  useEffect(() => { boot(); }, [boot]);

  // any 401 = the session ended: back to the sign-in page, then return here
  useEffect(() => {
    const on = (e: Event) => {
      setMe((cur) => {
        if (cur) {
          sessionStorage.setItem('oo.after-login', location.pathname + location.search);
          toast((e as CustomEvent).detail || 'Session expired. Please sign in again.', 'err');
        }
        return null;
      });
      qc.clear();
    };
    window.addEventListener('oo:unauthorized', on);
    return () => window.removeEventListener('oo:unauthorized', on);
  }, [location, qc]);

  useEffect(() => { if (me) document.title = me.brand; }, [me]);

  const logout = useCallback(async () => {
    try { await api('/logout', { method: 'POST' }); } catch { /* ignore */ }
    sessionStorage.removeItem('oo.after-login');
    qc.clear();
    setMe(null);
    window.history.replaceState({}, '', '/login');
  }, [qc]);

  if (me === undefined) return <div className="boot"><div className="spinner" /></div>;
  if (me === null) {
    if (location.pathname !== '/login' && !sessionStorage.getItem('oo.after-login')) sessionStorage.setItem('oo.after-login', location.pathname + location.search);
    return <LoginPage onSuccess={async () => {
      const back = sessionStorage.getItem('oo.after-login');
      sessionStorage.removeItem('oo.after-login');
      window.history.replaceState({}, '', back && !back.startsWith('/login') ? back : '/');
      await boot();
    }} />;
  }
  if (me.user.restricted === 'mfa_setup') return <ForcedMfa onDone={boot} onLogout={logout} />;

  return (
    <AppProvider initialMe={me} onLogout={logout}>
      <DialogProvider>
      <Shell>
        <Suspense fallback={<StateView kind="loading" skeleton="chart" />}>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/login" element={<Home />} />
            {Object.entries(PAGES).map(([path, Page]) => (
              <Route key={path} path={path} element={<Guard path={path}><Page /></Guard>} />
            ))}
            <Route path="*" element={<NotFound />} />
          </Routes>
        </Suspense>
      </Shell>
      </DialogProvider>
    </AppProvider>
  );
}

function Home() {
  const { pref, canOpen } = useApp();
  const home = pref<string>('homePage');
  return <Navigate to={home && canOpen(home.split('?')[0]) ? home : '/overview'} replace />;
}

/** a disabled module looks exactly like a page that does not exist; a missing permission says so */
function Guard({ path, children }: { path: string; children: React.ReactNode }) {
  const { moduleOn, can } = useApp();
  const location = useLocation();
  const r = findRoute(path.includes(':') ? location.pathname : path);
  if (!r || !moduleOn(r.module)) return <NotFound />;
  if (r.perm && !can(r.perm)) return <StateView kind="error" title="No access" text={`This page needs the "${r.perm}" permission.`} />;
  return <>{children}</>;
}

function NotFound() {
  return <div className="empty"><div className="empty-title">Page not found</div><Link to="/overview">Go to Overview</Link></div>;
}
