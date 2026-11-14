# ObservaOne — Claude Code guide

Self-hosted monitoring/observability product (login + product layer on top of
Prometheus, Alertmanager, Loki, Tempo). Runs in a **banking / financial-services**
context: treat auth, secrets, tenancy and audit as first-class.

## Stack
- **UI** `observa-ui/web` — React 19 + TypeScript + Vite 8, React Router 7, TanStack Query 5, Chart.js 4, lucide-react. Builds to `web/dist`.
- **API/server** `observa-ui` — Node 20, Express 5, ESM (`type: module`), Postgres via `pg`. Auth: bcryptjs, ldapts (LDAP), openid-client (OIDC/SSO), qrcode (MFA); email via nodemailer; writes Alertmanager config via `yaml`.
- **Agent** `agent/go` — Go 1.22 (`module observaone/agent`). Install paths: Linux (done), Windows/Docker/Kubernetes on roadmap.
- **Infra** `docker-compose.yml` + `prometheus/ alertmanager/ grafana/ loki/ tempo/ blackbox/ nginx/ gateway/`. Dev: WSL + Docker Compose at https://observaone.local.
- **Docs** `docs/metrics/METRICS.md`, `docs/alerting/ALERTING.md`, `docs/agent/LINUX-AGENT.md`, `README.md`.

## Commands
- UI: `cd observa-ui/web && npm run dev | npm run build | npm run typecheck`
- Server + tests: `cd observa-ui && npm start` · `npm test` (native `node --test`, ~108 tests). Integration tests need `OBSERVA_TEST_URL`, `OBSERVA_TEST_ADMIN_PASSWORD`, `OBSERVA_TEST_PROM`, `OBSERVA_TEST_WEBHOOK`.
- Agent: `cd agent/go && go build ./... && go test ./...`; scenarios in `agent/test/`.
- Stack: `docker compose up -d --build` · inspect with `docker compose config|ps`.

## Conventions
- ESM imports everywhere in the server; TypeScript strict in the UI.
- One metric definition drives screens AND alerts (see METRICS.md); keep counts/status wording consistent across pages.
- DB changes = numbered, ordered migrations (currently 14+); parameterized SQL only.
- Keep the agent enrolment/update protocol and public API backward-compatible.
- Commit messages end with the project's Co-Authored-By / Claude-Session trailer; work on a branch, push to origin.

## How to work here (workflows)
Use the slash commands; they route to the right agent/skill:
- `/analyze-requirements` → scope before building.
- `/plan-feature` → architect designs, then a written plan (STOP for approval before architecture-changing work).
- `/tdd` → red-green-refactor for new logic.
- `/debug` → root cause before any fix.
- `/review` → quality gate before done · `/security-review` → for sensitive changes · `/regression` → after modifications.

### Agents (`.claude/agents/`) — one owner per concern, no overlap
`software-architect` (design/plan only) · `frontend-developer` (observa-ui/web) ·
`backend-developer` (observa-ui/src) · `database-engineer` (Postgres/migrations) ·
`qa-testing-engineer` (tests + regression) · `security-engineer` (security review, deps, scans) ·
`devops-engineer` (compose/observability/agent build/CI) · `code-reviewer` (read-only quality gate).

### Skills (`.claude/skills/`, 23 installed)
Workflow: brainstorming, writing-plans, executing-plans, test-driven-development,
systematic-debugging, root-cause-tracing, requesting/receiving-code-review, verification-before-completion.
Frontend/UX: frontend-design, react-best-practices, composition-patterns, web-design-guidelines, ui-ux-pro-max (explore ideas; **extend** the existing `web/src/lib/theme.ts` tokens, don't override). Testing: webapp-testing.
Security: supply-chain-risk-auditor, semgrep, codeql, sarif-parsing, differential-review, variant-analysis, cvss-scoring. Meta: skill-creator.
Provenance & licenses: `.claude/skills/THIRD_PARTY_SKILLS.md`.

## Safety (non-negotiable)
- Never read, write, log, or commit secrets. `.env`, `nginx/certs/**`, `.agent-keys/**` are off-limits (enforced by `.claude/settings.json` + `.claude/hooks/guard.sh`).
- No destructive commands without explicit approval: no `docker compose down -v`, volume prune/rm, `rm -rf` on data dirs, force-push, or `DROP/TRUNCATE`.
- **Ask for approval before changing existing application architecture.**
- Don't add dependencies without justification; pin versions where practical.

## Token economy
- This file is the shared context — keep it current and concise; don't duplicate it elsewhere.
- Inspect targeted files; avoid repo-wide scans and re-reading unchanged files.
- Let skills load on demand (progressive disclosure); don't paste skill bodies.
- Use subagents for independent sub-tasks; keep outputs focused. Never trade away correctness or security to save tokens.
