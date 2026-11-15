---
description: Requirement analysis before any implementation — clarify scope, constraints, and acceptance criteria.
argument-hint: <feature or change to analyze>
---
Analyze the requirement before writing any code: $ARGUMENTS

1. Restate the goal in one or two sentences and list explicit + implicit requirements.
2. Identify affected areas (observa-ui/web, observa-ui/src, agent/go, infra configs, DB) and dependencies.
3. List unknowns and ask only the questions whose answers change the approach (prefer multiple-choice).
4. Define acceptance criteria and how they'll be verified (tests, UI check).
5. Flag any security/tenancy/migration/backward-compat concern.

Use the `brainstorming` skill if the idea is open-ended. Do NOT start implementation — end with a short scoped summary and the open questions.
