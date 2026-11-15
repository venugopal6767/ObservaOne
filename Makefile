# ObservaOne - local development tasks (no CI/CD, no deploy).
# Thin wrappers over npm, go, and scripts/. Run `make help` for the list.
.DEFAULT_GOAL := help
.PHONY: help test test-server test-web typecheck e2e test-go vet scan stack-check

help:  ## list targets
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}{printf "  %-14s %s\n", $$1, $$2}'

test: test-server test-web test-go  ## run all unit tests (server + web + go)

test-server:  ## backend node --test (integration auto-skips without OBSERVA_TEST_*)
	cd observa-ui && npm test

test-web:  ## frontend Vitest component/unit tests
	cd observa-ui/web && npm test

typecheck:  ## frontend TypeScript typecheck (tsc -b)
	cd observa-ui/web && npm run typecheck

e2e:  ## Playwright e2e (needs a running stack; see observa-ui/web/playwright.config.ts)
	cd observa-ui/web && npm run test:e2e

test-go:  ## Go agent vet + unit tests
	./scripts/test-go.sh

vet:  ## Go agent vet only
	cd agent/go && go vet ./...

scan:  ## local security scan (npm audit + govulncheck + semgrep if installed)
	./scripts/security-scan.sh

stack-check:  ## validate Docker Compose config locally (non-destructive)
	./scripts/validate-stack.sh

