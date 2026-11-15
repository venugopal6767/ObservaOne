---
description: Code review gate before completing a task (quality + correctness).
argument-hint: [optional: files or scope]
---
Review before completion: ${ARGUMENTS:-the current uncommitted changes}

1. Delegate to the `code-reviewer` agent for correctness, readability, convention-fit, scope creep, and test adequacy (apply `requesting-code-review`).
2. If the change touches auth/secrets/tenancy/audit/agent-protocol, ALSO run `/security-review`.
3. Apply `verification-before-completion` as the final checklist.
Report blockers vs nits. Do not mark the task done until blockers are resolved.
