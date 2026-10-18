# ObservaOne web UI (React)

React 19 + TypeScript, built with Vite. The Express server in `observa-ui/src` serves the build from `web/dist`
and the API under `/api` (same origin, same session cookie). No data is ever made up in the UI: every value
comes from the API, or the panel shows why it is missing (empty / not configured / unavailable / error).

## Commands

```bash
npm ci
npm run dev        # dev server on :5173, /api proxied to OBSERVA_API (default http://localhost:8080)
npm run typecheck  # tsc only
npm run build      # tsc + vite build -> dist/
```

## Layout

| Path | What it is |
|---|---|
| `src/main.tsx` | Entry: fonts, styles, React Query, router, theme |
| `src/app/App.tsx` | Boot (`/api/me`), sign-in, forced MFA, routes (pages are lazy-loaded) |
| `src/app/AppContext.tsx` | Signed-in user, permissions + modules (`can`, `moduleOn`, `canOpen`), theme, **global time range**, auto-refresh, per-user prefs, data hooks `useRangeQuery` / `usePlainQuery` |
| `src/app/routes.ts` | Every page: path, sidebar section, module, permission (no React here, so permission checks work anywhere) |
| `src/app/Shell.tsx` | Sidebar (collapsible), top bar, alert bell, account menu, `?from=&to=` sync |
| `src/app/TimePicker.tsx` | Quick ranges + custom fixed window |
| `src/app/CommandPalette.tsx` | Ctrl+K / `/`: pages, dashboards, services, metrics, trace IDs, actions |
| `src/components/charts.tsx` | Chart.js wrappers; `TimeChart correlate` opens the metric → logs / traces menu |
| `src/components/ui.tsx` | Pills, data states, tables + paging, tabs, fields, modal, toasts, `useDialogs()` |
| `src/pages/*` | One file per page |
| `src/styles/base.css` | Design tokens (dark + light) and the base design system |
| `src/styles/app.css` | Styles for the 2.0 components |

## Rules the code follows

- A page link or menu item is shown only if `canOpen(path)` is true (module enabled **and** permission).
- The global time range applies to every panel. A fixed window (from a chart click, a link, or the custom
  picker) is written to the address as `?from=&to=` so a link opens exactly the same view.
- Colours come from CSS variables only (pages never hard-code hex colours, except the data source brand tints).
- Per-user preferences are saved with `savePref(key, value)`; new keys must be added to `PREF_KEYS` in
  `observa-ui/src/auth.js`.
