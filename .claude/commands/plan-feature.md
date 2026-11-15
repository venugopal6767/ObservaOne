---
description: Architecture planning + plan-first development for a complex feature or change.
argument-hint: <feature/change to plan>
---
Produce an implementation plan before coding: $ARGUMENTS

1. Delegate to the `software-architect` agent to design the approach (2-3 options, trade-offs, recommendation, blast radius, migration/rollout).
2. Capture the chosen design as a concrete, incremental, reversible plan using the `writing-plans` skill: ordered steps, the files/dirs each touches, and the verification for each step.
3. Call out anything that changes existing application architecture — per project policy, STOP for explicit user approval before such changes.

Output the plan and wait for go-ahead. Implementation happens via `/execute-plan` style execution (executing-plans skill) with the relevant developer agent.
