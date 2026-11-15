# ECC — vendored curated subset

A curated subset of **Everything Claude Code (ECC)** skills, selected for the
ObservaOne stack (React/TS/Vite, Node/Express/Postgres, Go agent, Prometheus/
Grafana/Loki/Tempo on Docker/K8s, fin-services security).

- Source: https://github.com/affaan-m/everything-claude-code  (plugin `ecc`, v2.2.3)
- Pinned commit: `d2ef2680594f9a17526a6e1a2e18b3d242c5d17b`
- License: MIT (© Affaan Mustafa)
- Vendored: 2026-11-15. Pure-markdown skills; no scripts or binaries copied.

Only 33 of ECC's 314 skills are vendored (full bundle intentionally not pulled in —
see ../README.md "Optional: ECC"). To update: re-copy the same folders from the
pinned repo, or adopt the self-updating plugin and delete these.

## Skills (upstream names preserved)
Frontend:  react-patterns, react-performance, react-testing, typescript-patterns,
           vite-patterns, frontend-patterns, accessibility, design-system
Backend/DB: backend-patterns, api-design, error-handling, contract-first,
           database-migrations, postgres-patterns, redis-patterns, mysql-patterns
Go:        golang-patterns, golang-testing
Infra:     kubernetes-patterns, docker-patterns, deployment-patterns,
           dashboard-builder, production-audit
Security:  security-review, security-scan
Workflow:  e2e-testing, browser-qa, coding-standards, git-workflow,
           conventional-commit-review
Docs/ctx:  architecture-decision-records, codebase-onboarding, token-budget-advisor
