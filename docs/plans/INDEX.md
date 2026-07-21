# Plans Directory Index

A searchable index of all architecture and implementation plans.

## Summary

- **Total plans:** 18 (14 in `superpowers/plans/`, 4 in root `plans/`)
- **Organization:** By milestone and feature area
- **Status indicators:** ✅ Approved/Implemented | 🟡 Active/In Progress | 📋 Draft | 🚫 Superseded

---

## Core Architecture Plans (Superpowers)

### Foundation & Execution

| Title | File | Status | Purpose | Related ADRs | Last Updated |
|-------|------|--------|---------|-------------|-------------|
| M1 Foundation Implementation | `superpowers/plans/2026-07-16-m1-foundation.md` | ✅ Approved | Event-sourced kernel: task, plan, approval, replay guarantee. Establish append-only event log + CLI. | ADR-001, ADR-004, ADR-008 | 2026-07-16 |
| M2 Execution Implementation | `superpowers/plans/2026-07-17-m2-execution.md` | ✅ Approved | Execute approved plans on DBOS with durable workflows, cost accounting, kill-9 resume. Postgres migration, ExecutionPort, api-loop executor, providers. | ADR-002, ADR-003, ADR-004, ADR-006 | 2026-07-17 |
| M3 Plugins Implementation | `superpowers/plans/2026-07-17-m3-plugins.md` | ✅ Approved | Plugin host for T0 SKILL.md watcher, T2 extensions, T1 MCP client. Progressive disclosure of tool surface. | ADR-005, ADR-007 | 2026-07-17 |

### Knowledge & Vault Projections

| Title | File | Status | Purpose | Related ADRs | Last Updated |
|-------|------|--------|---------|-------------|-------------|
| M4a Event Stream & Vault Projector | `superpowers/plans/2026-07-17-m4a-event-stream-vault-projector.md` | ✅ Approved | Deterministic markdown/mermaid renders of tasks, execution lineage, and knowledge graphs. Live re-render on events. | ADR-005, ADR-008 | 2026-07-17 |
| M4b Knowledge Graph & Memory | `superpowers/plans/2026-07-18-m4b-knowledge-graph-memory.md` | ✅ Approved | Typed, confidence-weighted memory graph with SurrealDB read model. Graph-distance ranker, neighbors traverse. | ADR-005, ADR-006 | 2026-07-18 |
| M4c Memory Graph & Recursive MAS | `superpowers/plans/2026-07-19-m4c-memory-graph-recursive-mas.md` | ✅ Approved | Extend M4b with recursive multi-agent system: memory scopes, single-writer gateway, task-local note management. | ADR-005, ADR-006, ADR-007 | 2026-07-19 |

### Recursion & Advanced Features

| Title | File | Status | Purpose | Related ADRs | Last Updated |
|-------|------|--------|---------|-------------|-------------|
| M5a Recursion Core | `superpowers/plans/2026-07-19-m5a-recursion-core.md` | ✅ Approved | task_split + join_splits for recursive child workflows, split gates, approval policies, zones, worktree/docker isolation. | ADR-003, ADR-004, ADR-007 | 2026-07-19 |
| M5b Grounded-Plan Strategy | `superpowers/plans/2026-07-19-m5b-grounded-plan-strategy.md` | ✅ Approved | Two-step bootstrap (analyze → plan) template with conversational gate, plan-note authoring, targeted re-planning, deterministic instantiation. | ADR-001, ADR-005, ADR-006 | 2026-07-19 |

### Hardening & Research

| Title | File | Status | Purpose | Related ADRs | Last Updated |
|-------|------|--------|---------|-------------|-------------|
| Foundation Hardening | `superpowers/plans/2026-07-18-foundation-hardening.md` | ✅ Approved | Redaction, error handling, graceful degradation, project isolation, per-project advisory locks. | ADR-002, ADR-008 | 2026-07-18 |
| M4b Switch Contingency | `superpowers/plans/2026-07-19-m4b-switch-contingency.md` | ✅ Approved | SurrealDB downtime tolerance: degraded memory tools, explicit "unavailable" results, all other systems keep working. | ADR-005 | 2026-07-19 |
| Sourced Web Research | `superpowers/plans/2026-07-20-sourced-research.md` | ✅ Approved | Citations on research notes, distilled findings vs raw evidence, event-sourced access counts, web-research skill. | ADR-006 | 2026-07-20 |
| System Hardening | `superpowers/plans/2026-07-20-system-hardening.md` | ✅ Approved | Observability, metrics, admin dashboards, graceful shutdown, upgrade procedures, operational guardrails. | ADR-008 | 2026-07-20 |
| Review & Remediation | `superpowers/plans/2026-07-19-review-remediation.md` | ✅ Approved | Post-M4c audit and remediation: event recovery, missing redaction, API shims, targeted fixes. | ADR-001, ADR-008 | 2026-07-19 |

### Memory Extensions

| Title | File | Status | Purpose | Related ADRs | Last Updated |
|-------|------|--------|---------|-------------|-------------|
| Neuron Memory & Web Research | `superpowers/plans/2026-07-19-neuron-memory-web-research.md` | 🚫 Superseded | Earlier web-research design (superseded by Sourced Web Research). | ADR-006 | 2026-07-19 |

---

## UI & Visualization Plans

### Web Graph UI

| Title | File | Status | Purpose | Last Updated |
|-------|------|--------|---------|-------------|
| Live Visual Map (Ports & Adapters) | `plans/2026-07-20-graph-ui.md` | 📋 Draft | WebGL force graph (sigma.js + graphology), incremental patches, project switcher, per-task chat + request view. Ports & adapters for web + future TUI. | 2026-07-20 |

### Navigation & Chat

| Title | File | Status | Purpose | Last Updated |
|-------|------|--------|---------|-------------|
| UI Navigation | `plans/2026-07-20-ui-navigation.md` | 📋 Draft | Deep-linkable graph navigation, request panel refinement, context pinning, live search. | 2026-07-20 |

### Chat-First Interface

| Title | File | Status | Purpose | Last Updated |
|-------|------|--------|---------|-------------|
| Chat-First UI | `plans/2026-07-21-chat-first-ui.md` | 📋 Draft | Chat-as-primary interface: human-agent transcript, task creation from chat, inline approvals. | 2026-07-21 |

### Web Integration

| Title | File | Status | Purpose | Last Updated |
|-------|------|--------|---------|-------------|
| Web Actions & Integration | `plans/2026-07-21-web-actions.md` | 📋 Draft | Browser-driven task creation, approval, and execution; deep linking; CSRF-guarded mutations. | 2026-07-21 |

---

## Plan Organization by Feature Area

### Event Log & Storage
- M1 Foundation (append-only kernel)
- Foundation Hardening (redaction, locking)

### Execution & Durability
- M2 Execution (DBOS workflows, providers, signals)
- M5a Recursion Core (child splits, retry policy)
- Sourced Web Research (event-sourced access counts)

### Knowledge & Memory
- M4b Knowledge Graph (SurrealDB, confidence weights)
- M4c Recursive MAS (scoped notes, single-writer)
- M5b Grounded-Plan (plan-note authoring, conversional gates)
- Sourced Web Research (research notes, citations)

### Plugins & Extensions
- M3 Plugins (SKILL.md, MCP, extensions)
- M4a Vault Projector (markdown renders)
- Sourced Web Research (web-research skill)

### UI & Visualization
- Live Visual Map (graph rendering)
- UI Navigation (deep-linking, context)
- Chat-First UI (chat interface)
- Web Actions (mutations, integration)

### Infrastructure & Operations
- Foundation Hardening (error handling, degradation)
- M4b Switch Contingency (SurrealDB downtime)
- System Hardening (observability, upgrades)
- Review & Remediation (post-audit fixes)

---

## Approval Status Summary

**Approved (✅):** 14 plans across M1–M5, hardening, and sourced research.

**Draft (📋):** 4 plans in UI/visualization (future iterations, not blocking core).

**Superseded (🚫):** 1 plan (neuron-memory-web-research; replaced by sourced-research).

---

## Navigating the Plans

1. **To understand the architecture:** Start with M1 Foundation, then M2 Execution, M3 Plugins, M4a/b/c Knowledge.
2. **To implement a milestone:** Read the corresponding plan file directly—each contains full task breakdowns, test assertions, and code examples.
3. **To add features:** Check the appropriate area above, or propose a new plan in `docs/superpowers/plans/` with the date-based naming convention.
4. **For UI work:** See the four draft plans in `docs/plans/`.
5. **To understand decisions:** Cross-reference plan names to the ADR directory in `docs/` (8 durable ADRs).

---

## Version History

| Date | Change |
|------|--------|
| 2026-07-20 | Initial index created; 18 plans cataloged, approval status formalized. |

---

## Status Legend

| Symbol | Meaning |
|--------|---------|
| ✅ Approved | Plan has been reviewed and approved; implementation complete or in progress. |
| 🟡 Active | Currently being implemented or under active discussion. |
| 📋 Draft | Proposed but not yet approved; ready for review. |
| 🚫 Superseded | Replaced by a newer plan; kept for historical reference. |
