---
description: Systematic debugging — find root cause before changing anything.
argument-hint: <bug / symptom>
---
Debug methodically: $ARGUMENTS

Use the `systematic-debugging` and `root-cause-tracing` skills:
1. Reproduce reliably; capture the exact symptom and conditions.
2. Form hypotheses; trace from symptom to root cause (don't patch symptoms).
3. Prove the root cause before fixing.
4. Fix minimally, add a regression test, then run `/regression`.
Do not attempt a fix until the root cause is identified.
