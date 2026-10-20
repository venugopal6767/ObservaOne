// App shell: sidebar (collapsible, role- and module-aware), top bar (command palette, data-source chip,
// time range, refresh, alert bell, account menu) and the page area.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { NavLink, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Search, RefreshCw, Bell, ChevronDown, User, KeyRound, Shield, LogOut, PanelLeftClose, PanelLeftOpen, Home, LineChart, FileText, Menu, FlaskConical } from 'lucide-react';
import { api } from '@/lib/api';
import { THEMES } from '@/lib/theme';
import { NAV_SECTIONS, findRoute } from './routes';
import { REFRESH, useApp } from './AppContext';
import { TimePicker } from './TimePicker';
import { CommandPalette } from './CommandPalette';
import { NAV_ICONS, Select } from '@/components/ui';
import { Logo } from '@/components/Logo';

export function Shell({ children }: { children: ReactNode }) {
  const app = useApp();
  const { me, can, canOpen, moduleOn, range, setRange, refreshMs, setRefreshMs, refreshAll, dsChip, setDsChip, pref, savePref } = app;
  const location = useLocation();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [palette, setPalette] = useState(false);
  const [collapsed, setCollapsed] = useState<boolean>(!!pref('sidebarCollapsed'));
  const [closedSections, setClosedSections] = useState<Set<string>>(new Set(pref<string[]>('navCollapsed') || []));
  const [navOpen, setNavOpen] = useState(false); // phone: the "More" menu shows the full navigation
  useEffect(() => { setNavOpen(false); }, [location.pathname]);

  // ---- keyboard: Ctrl+K / Cmd+K / "/" open the palette ----
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes((document.activeElement as HTMLElement)?.tagName);
      if ((e.key === 'k' && (e.ctrlKey || e.metaKey)) || (e.key === '/' && !typing)) { e.preventDefault(); setPalette(true); }
    };
    document.addEventListener('keydown', on);
    return () => document.removeEventListener('keydown', on);
  }, []);

  // ---- the page address carries a fixed time window (?from=&to=): links and chart jumps open the same view ----
  const from = Number(params.get('from')), to = Number(params.get('to'));
  useEffect(() => {
    if (from && to && to > from && (range.kind !== 'absolute' || range.from !== from || range.to !== to)) setRange({ kind: 'absolute', from, to });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to]);
  useEffect(() => {
    const next = new URLSearchParams(params);
    if (range.kind === 'absolute') {
      if (Number(next.get('from')) === range.from && Number(next.get('to')) === range.to) return;
      next.set('from', String(range.from)); next.set('to', String(range.to));
    } else {
      if (!next.has('from') && !next.has('to')) return;
      next.delete('from'); next.delete('to');
    }
    setParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range]);

  // a page sets its own data-source chip; clear it when the page changes
  useEffect(() => { setDsChip(null); }, [location.pathname, setDsChip]);

  // ---- alert bell (Alerting module only), polled every 30 s ----
  const bell = useQuery({
    queryKey: ['alerts-count'],
    queryFn: () => api<{ active: number; critical: number }>('/alerts/count'),
    enabled: moduleOn('alerting'),
    refetchInterval: 30_000,
    retry: false,
  });

  const allowed = (i: { module?: string; perm?: string }) => moduleOn(i.module) && (!i.perm || can(i.perm));
  const sections = NAV_SECTIONS.map((s) => ({ ...s, items: s.items.filter(allowed) })).filter((s) => s.items.length);
  const active = findRoute(location.pathname)?.navPath;
  const [first, ...rest] = me.brand.split(/(?=[A-Z][a-z]+$)/);

  return (
    <div className={`shell ${collapsed ? 'nav-collapsed' : ''} ${navOpen ? 'nav-open' : ''}`}>
      <div className="brand">
        <Logo size={28} />
        <span className="brand-name">{first}{rest.length > 0 && <b>{rest.join('')}</b>}</span>
      </div>
      <header className="topbar">
        <button className="search search-trigger" onClick={() => setPalette(true)} aria-label="Open search (Ctrl+K)">
          <Search size={15} aria-hidden className="dim" />
          <span className="search-ph">Search pages, dashboards, services, metrics…</span>
          <kbd>Ctrl K</kbd>
        </button>
        <div className="top-spacer" />
        {me.demoData && <span className="demo-chip" title="This installation shows made-up test data from the demo/ folder. Remove it before real use (see demo/README.md)."><FlaskConical size={13} />Demo data</span>}
        {dsChip && <div className="ds-chip"><i style={{ background: `var(--${dsChip.tone})` }} />{dsChip.label}</div>}
        <TimePicker />
        <div className="refresh-group">
          <button className="icon-btn" title="Refresh now" aria-label="Refresh now" onClick={refreshAll}><RefreshCw size={16} /></button>
          <Select className="select select-sm refresh-sel" label="Auto-refresh" value={range.kind === 'absolute' ? 0 : refreshMs}
            options={REFRESH.map(([ms, l]) => [ms, ms ? `↻ ${l}` : '↻ Off'] as [number, string])} onChange={setRefreshMs} disabled={range.kind === 'absolute'} />
        </div>
        {moduleOn('alerting') && (
          <button className="icon-btn" title={bell.data ? `${bell.data.active} active alert(s), ${bell.data.critical} critical` : 'Active alerts'} aria-label="Active alerts" onClick={() => navigate('/alerting/active?tab=firing')}>
            <Bell size={17} />
            {!!bell.data?.active && <span className={`count ${bell.data.critical ? '' : 'warn'}`}>{bell.data.active > 99 ? '99+' : bell.data.active}</span>}
          </button>
        )}
        <UserMenu />
      </header>

      <nav className="sidebar" aria-label="Main">
        {sections.map((s) => {
          const isClosed = !!s.title && closedSections.has(s.title) && !collapsed;
          return (
            <div key={s.title || 'top'} className="nav-sec">
              {s.title && (
                <button className="nav-section" aria-expanded={!isClosed} aria-label={`${s.title} section`} onClick={() => {
                  const next = new Set(closedSections);
                  if (next.has(s.title!)) next.delete(s.title!); else next.add(s.title!);
                  setClosedSections(next);
                  savePref('navCollapsed', [...next]);
                }}><span>{s.title}</span><ChevronDown size={12} /></button>
              )}
              <div className={`nav-group ${isClosed ? 'collapsed' : ''}`}>
                {s.items.map((i) => {
                  const Icon = NAV_ICONS[i.icon];
                  return (
                    <div key={i.path}>
                      <NavLink to={i.path} title={i.label} className={() => `nav-item ${active === i.path ? 'active' : ''}`}>
                        <span className="ic"><Icon size={17} strokeWidth={1.8} aria-hidden /></span><span className="label">{i.label}</span>
                      </NavLink>
                      {i.children && active === i.path && !collapsed && (
                        <div className="nav-sub">
                          {i.children.filter((c) => !c.perm || can(c.perm)).map((c) => {
                            const here = location.pathname === c.path || (c.path === '/alerting/active' && location.pathname.startsWith('/alerting/alert/'));
                            return <NavLink key={c.path} to={c.path} end className={() => `nav-sub-item ${here ? 'active' : ''}`} aria-current={here ? 'page' : undefined}>{c.label}</NavLink>;
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
        <div className="side-foot">
          <button className="collapse-btn" onClick={() => { setCollapsed(!collapsed); savePref('sidebarCollapsed', !collapsed); }} aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
            {collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
            <span className="label">Collapse</span>
          </button>
          <div className="who">Signed in as {me.user.username}<br />Role: {me.user.role}</div>
        </div>
      </nav>

      <main className="main" id="main">{children}</main>
      <nav className="bottom-nav" aria-label="Quick navigation">
        {([['/overview', 'Home', Home], ['/metrics', 'Metrics', LineChart], ['/alerting', 'Alerts', Bell], ['/logs', 'Logs', FileText]] as const).filter(([p]) => canOpen(p)).map(([p, label, Icon]) => (
          <NavLink key={p} to={p} className={() => (active === p ? 'on' : '')}><Icon size={19} /><span>{label}</span>{p === '/alerting' && !!bell.data?.active && <i className="bn-count">{bell.data.active > 99 ? '99+' : bell.data.active}</i>}</NavLink>
        ))}
        <button className={navOpen ? 'on' : ''} aria-expanded={navOpen} onClick={() => setNavOpen(!navOpen)}><Menu size={19} /><span>More</span></button>
      </nav>
      {navOpen && <div className="nav-scrim" onClick={() => setNavOpen(false)} />}
      <CommandPalette open={palette} onClose={() => setPalette(false)} />
    </div>
  );
}

function UserMenu() {
  const { me, can, themePref, setThemePref, logout } = useApp();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [open]);
  const u = me.user;
  const go = (p: string) => { setOpen(false); navigate(p); };
  return (
    <div className="user-wrap" ref={ref}>
      <button className="user-btn" aria-haspopup="menu" aria-expanded={open} aria-label={`Account menu for ${u.displayName || u.username}`} onClick={() => setOpen(!open)}>
        <div className="avatar">{(u.displayName || u.username).slice(0, 1).toUpperCase()}</div>
        <div className="user-meta">{u.displayName || u.username}<small>{u.role}</small></div>
        <ChevronDown size={14} className="dim" />
      </button>
      {open && (
        <div className="menu" role="menu">
          <button role="menuitem" onClick={() => go('/settings?tab=profile')}><User size={15} />My profile &amp; security</button>
          <button role="menuitem" onClick={() => go('/settings?tab=apikeys')}><KeyRound size={15} />My API keys</button>
          <div className="menu-theme" role="group" aria-label="Theme">
            <span className="dim">Theme</span>
            {THEMES.map(([k, label]) => (
              <button key={k} className={`theme-opt ${themePref === k ? 'active' : ''}`} aria-pressed={themePref === k} onClick={() => setThemePref(k)}>{label}</button>
            ))}
          </div>
          {can('users.manage') && <button role="menuitem" onClick={() => go('/settings?tab=users')}><Shield size={15} />Users &amp; roles</button>}
          <button role="menuitem" onClick={() => { setOpen(false); logout(); }}><LogOut size={15} />Sign out</button>
        </div>
      )}
    </div>
  );
}
