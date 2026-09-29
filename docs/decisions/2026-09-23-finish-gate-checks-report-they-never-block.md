---
status: accepted
tags: checks, finish-step, kernel, architecture
---

# Finish-gate checks report; they never block

## Context

The finish gate needed a way to run operator-configured verification commands (tests, typecheck, lint, etc.) before the finish step without turning the deterministic pipeline into a blocking CI gate, and without a second ad-hoc process spawner duplicating exec-tool's spawn/timeout/clip logic.

## Decision

A kernel-appended `checks` step (before `finish`, driven by config.finishChecks, [] = no-op) runs every configured command concurrently through the single extracted spawner run-command.ts (the same one exec-tool uses) and ALWAYS signals success; a failing command surfaces only as a FAIL line in the checks step's summary, which the finish step reads as its `checks` upstream output and must lead its summary/question with — never as an automatic run failure.

## Consequences

finishChecks failures never halt or fail a run by themselves — the finisher (human-facing) is the only gate that can act on a red check, e.g. by naming a fix. Any future kernel command-spawning need must go through run-command.ts rather than opening its own child_process. Making checks block automatically (e.g. failing the step on non-zero exit) would supersede this decision, not just patch it.
