# Architectural Seams

This directory contains comprehensive documentation of the orchestrator's critical architectural boundaries — the places where major system components exchange data and must enforce specific invariants.

## Contents

- **[reference.md](./reference.md)** — Complete seams guide (30-minute read)
  - Quick navigation links and system context
  - Deep dive into each of the 5 critical seams
  - Failure modes and recovery procedures
  - Testing guide and troubleshooting

## Quick Links

### For Onboarding

1. Start with [Architecture Overview](../ARCHITECTURE.md) to understand the three-tier structure
2. Read the [System Context section](./reference.md#system-context) in the seams guide
3. Walk through each seam in order to understand data flow and invariants
4. Use the [testing guide](./reference.md#testing-guide) to write tests for custom extensions

### For Incident Response

1. Check which seam is affected (see [symptom table](./reference.md#reference-quick-diagnostics))
2. Jump to that seam's section (use [Quick Navigation](./reference.md#quick-navigation))
3. Read the failure modes and recovery steps
4. Use the diagnostic commands to verify the issue

### For Design & Extension

1. Understand the seam's invariants before making changes
2. Ensure your extension respects the guarantees (see [Guarantees](../README.md#guarantees-stated-precisely))
3. Write idempotent operations (see [Operation Journal Seam](./reference.md#2-operation-journal-seam))
4. Test project isolation (see [Event Log Seam](./reference.md#1-event-log-seam))

## The Five Seams (Quick Reference)

| Seam | Layer | Data | Invariants | Key Concern |
|------|-------|------|-----------|-------------|
| **Event Log** | ② → ③ | Typed event payloads | Append-only, monotonic, project isolation | Durability audit trail |
| **Operation Journal** | ② → ③ | Before/after external effects | Deterministic IDs, reuse detection, stale rejection | Crash safety for model/tool calls |
| **Execution Flow** | ① ↔ ② | Step checkpoints, outputs | Deterministic workflows, at-least-once, receipt verification | Step-level recovery |
| **Memory/Knowledge** | ② → ③ | Event-first notes, graph edges | Citation requirement, project isolation, graph coherence | Knowledge graph integrity |
| **Feedback & Approval** | ① ↔ ② ↔ ③ | Human decisions as events | Hash-bound approval, idempotent delivery, durable outbox | No lost decisions |

## Architectural Invariants (Summary)

### The Golden Rule
**The Postgres event log is the only truth.** Everything else (operations journal, SurrealDB, vault, DBOS system DB) is either a rebuilding index or a disposable projection of the log.

### Cross-Seam Guarantees

1. **Project Isolation** — Every query filters by `projectId`. Two projects sharing one deployment cannot read, project, recover, or render each other's state.

2. **Idempotent Replay** — Deterministic idempotency keys absorb retries. Same (projectId, key) pair → stored once; replayed appends return the original sequence number.

3. **Before-the-Effect Guarantee** — For external effects (model calls, tools), a `started` node is committed BEFORE the effect runs. Crashes leave explicit unresolved markers, never blind gaps.

4. **At-Least-Once Semantics** — Completed operations are reused from the journal; unresolved nodes are retried. Stale attempts are terminal errors (prevent duplicate effects).

5. **Deterministic Determinism** — Workflow IDs are derived from (taskId, planVersion, retryIndex). Same task run → same workflow ID → same checkpoint reuse behavior.

6. **Durable Feedback Outbox** — Decisions are appended to the log FIRST, then routed asynchronously. Crashes between append and delivery are healed on startup.

7. **Secrets Redacted Once** — At the storage boundary, sensitive keys and env values are stripped and replaced with `[REDACTED]` markers. Projections and vault files never see raw secrets.

8. **Sourced Knowledge** — Raw evidence stays in the audit trail (redacted). Only distilled notes reach the knowledge graph. Research notes MUST carry citations.

## Related Documentation

- **[Architecture Overview](../ARCHITECTURE.md)** — System map, three-tier layers, storage boundary
- **[EXTENDING.md](../EXTENDING.md)** — How to add providers, executors, skills, tools, event kinds
- **[ADRs](../superpowers/specs/)** — Architectural decision records (design history)
- **[Operational Guarantees](../README.md#guarantees-stated-precisely)** — Stated precisely (from README)

## References for Each Seam

**Event Log Seam** → `packages/contracts/src/events.ts`, `packages/kernel/src/storage/event-log.ts`, test: `packages/kernel/src/storage.test.ts`

**Operation Journal Seam** → `packages/contracts/src/operations.ts`, `packages/kernel/src/storage/operation-journal.ts`, test: `packages/kernel/src/storage.test.ts`

**Execution Flow Seam** → `packages/contracts/src/execution.ts`, `packages/kernel/src/execution/dbos-port.ts`, test: `packages/kernel/src/kernel.test.ts`

**Memory/Knowledge Seam** → `packages/contracts/src/memory.ts`, `plugins/memory/src/knowledge.ts`, `plugins/memory/src/surreal.ts`

**Feedback & Approval Seam** → `packages/contracts/src/analysis.ts`, `packages/kernel/src/kernel.ts`, `packages/kernel/src/execution/signal-router.ts`
