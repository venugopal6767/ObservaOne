---
description: Regression testing after a modification.
argument-hint: [optional: area changed]
---
Run regression checks after changes: ${ARGUMENTS:-recent changes}

Delegate to the `qa-testing-engineer` agent:
1. Run the backend suite: `cd observa-ui && npm test` (set integration env vars if integration tests are in scope).
2. If UI changed, verify affected screens with the `webapp-testing` skill; watch for the known consistency bugs (server/alert counts, status wording, offline agents showing metrics).
3. For the Go agent, run the relevant scripts under agent/test/.
4. Report pass/fail plainly; do not weaken tests to go green.
