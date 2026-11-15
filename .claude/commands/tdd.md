---
description: Test-driven development loop for new logic (red -> green -> refactor).
argument-hint: <behavior to implement>
---
Implement with TDD: $ARGUMENTS

Follow the `test-driven-development` skill strictly:
1. Write a failing test first (backend: `node --test` in observa-ui/tests; frontend: component/behavior test or webapp-testing check).
2. Run it; confirm it fails for the right reason.
3. Write the minimum code to pass (hand to backend-developer / frontend-developer as appropriate).
4. Run tests; refactor with tests green.
Never weaken a test to make it pass. Finish with `verification-before-completion`.
