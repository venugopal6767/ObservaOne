---
description: Regression testing after a modification (all lanes).
argument-hint: [optional: area changed]
---
Run regression checks after changes: ${ARGUMENTS:-recent changes}

Delegate to the `qa-testing-engineer` agent and run the lanes affected by the change
(or all of them). Shortcut: `make test` runs server + web + go.

1. **Backend** — `cd observa-ui && npm test` (native `node --test`). Set `OBSERVA_TEST_*`
   from `.env.example` to include the integration tests; otherwise they skip.
2. **Frontend** — `cd observa-ui/web && npm test` (Vitest) and `npm run typecheck`.
   If UI flows changed, run `npm run test:e2e` (Playwright) against a running stack and
   watch for the known consistency bugs (server/alert counts, status wording, offline
   agents showing metrics).
3. **Go agent** — `./scripts/test-go.sh` (vet + `go test ./...`), plus the relevant
   scenario scripts under `agent/test/`.
4. If the change was security-relevant, also run `/security-review` and `make scan`.

Report pass/fail per lane plainly. Do not weaken or delete a test to make it pass;
finish with `verification-before-completion`.
