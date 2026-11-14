---
description: Security review for sensitive changes (auth, secrets, tenancy, dependencies).
argument-hint: [optional: scope or diff]
---
Security review: ${ARGUMENTS:-the current changes}

Delegate to the `security-engineer` agent. Cover:
1. Secrets: nothing logged/committed; `.env`, nginx/certs, .agent-keys untouched.
2. AuthZ/AuthN & tenancy isolation preserved (no cross-tenant leakage).
3. Input validation, parameterized SQL, safe YAML/Alertmanager-config writing.
4. Static analysis where tooling is available (`semgrep`, `codeql` + `sarif-parsing`), `variant-analysis` for any found issue.
5. Dependencies via `supply-chain-risk-auditor` (npm in observa-ui + observa-ui/web, Go modules).
6. Rate/triage findings with `cvss-scoring`.
Report findings with severity and concrete fixes.
