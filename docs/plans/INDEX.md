# Plans Directory Index

This index catalogs all feature and roadmap plans in `docs/plans/` with their approval status, purpose, and dependencies. Use this to find the right plan for your work or to understand the roadmap.

## Active Plans

### Phase 2 Documentation Roadmap

The orchestrator has mature, stable architecture (proven by 8 durable ADRs and comprehensive testing) but suffers from documentation organization gaps. This phase addresses those gaps systematically.

| Plan | Status | Purpose | Deliverables | Dependencies |
|---|---|---|---|---|
| **Phase 2.1: README Enhancement** | ✅ APPROVED | Add architecture navigation index and glossary links to README | README with navigation table, component area descriptions, glossary link, seams guide link | — |
| **Phase 2.2: Plans Directory Index** | ✅ IN PROGRESS | Create this index with approval status and purpose for all 14 plans | `docs/plans/INDEX.md` with status, purpose, dependencies | Phase 2.1 (README links here) |
| **Phase 2.3: ADR Formalization** | 📋 PLANNED | Formalize all 8 architectural decision records as durable memory notes with proper links | 8 memory notes in `vault/memory/` with `kind=decision`, all searchable, cross-linked | Phase 2.1 (glossary foundation) |
| **Phase 2.4: Seams Reference Guide** | ✅ COMPLETE | Comprehensive guide to component interactions, call paths, debugging strategies | `docs/seams-reference.md` with scenarios, call paths, storage layer details, troubleshooting | Phase 2.1 (README links here) |
| **Phase 2.5: Glossary Extraction** | 📋 PLANNED | Extract key terms from codebase, specs, and memory into centralized glossary | `docs/GLOSSARY.md` with terms, definitions, and links to usage locations | Phase 2.3 (ADRs first) |

## Approved Plans (Completed)

### Graph UI — Live Visual Map

| Property | Value |
|---|---|
| **File** | `docs/plans/2026-07-20-graph-ui.md` |
| **Status** | ✅ APPROVED |
| **Approval Date** | 2026-07-20 |
| **Purpose** | Local web page (`orc graph` → http://127.0.0.1:7749) rendering the full execution + knowledge graph as an interactive WebGL force graph; logic in transport-free core, web server and TUI are thin adapters |
| **Key Deliverables** | `packages/ui-core`, `packages/graph-ui`, `orc graph` command, test coverage |
| **Dependencies** | None (foundation work) |
| **Contained Phases** | 5 phases: shared seams (3 steps), ui-core (3 steps), graph-ui web adapter (3 steps), browser page (2 steps), CLI integration (2 steps) |

### Other Approved Plans (2026-07-20 ecosystem)

| File | Status | Purpose |
|---|---|---|
| `2026-07-20-ui-navigation.md` | ✅ APPROVED | Navigation, layout, and deep-link support for the graph UI |
| `2026-07-21-chat-first-ui.md` | ✅ APPROVED | Chat-first interface for planning and execution (future phase) |
| `2026-07-21-web-actions.md` | ✅ APPROVED | Implement approve/reply/cancel/run mutations in the web UI |

### Active Execution & Direction

| File | Status | Purpose |
|---|---|---|
| `2026-07-21-flawless-grounded-flow.md` | 📋 IN PROGRESS | Defect-driven phases P1–P7: P1–P3, P5(batch 1), P6 shipped; next P7 (`orc mcp serve`) → P4 → P5 rest |
| `2026-07-22-roadmap.md` | 📋 ACTIVE | North star + pillar scorecard; Now/Next/Horizon with triggers (scheduling, collaboration, neuronal memory lifecycle) |

## Earlier Plans & Specs

### Foundation & Core Architecture

| File | Date | Status | Scope |
|---|---|---|---|
| `docs/superpowers/specs/2026-07-16-orchestrator-design.md` | 2026-07-16 | ✅ SHIPPED | Core system design, invariants, event log, execution model |
| `docs/superpowers/specs/2026-07-17-m2-execution-design.md` | 2026-07-17 | ✅ SHIPPED | Durable execution via DBOS Transact, operation journal, retry policy |
| `docs/superpowers/specs/2026-07-17-m3-plugins-design.md` | 2026-07-17 | ✅ SHIPPED | Plugin registry, model providers, executors, MCP servers, zero-trust model |
| `docs/superpowers/specs/2026-07-17-m4a-vault-projector-design.md` | 2026-07-17 | ✅ SHIPPED | Vault as deterministic markdown projections of tasks, execution, lineage |
| `docs/superpowers/specs/2026-07-18-foundation-hardening-design.md` | 2026-07-18 | ✅ SHIPPED | Redaction, degraded memory, storage service abstraction, error handling |
| `docs/superpowers/specs/2026-07-18-m4b-knowledge-graph-memory-design.md` | 2026-07-18 | ✅ SHIPPED | Event-first knowledge graph, SurrealDB read model, sourced research notes |
| `docs/superpowers/specs/2026-07-19-m4c-memory-graph-recursive-mas-design.md` | 2026-07-19 | ✅ SHIPPED | Multi-agent memory sharing, ranked traversal, bounded context slicing |
| `docs/superpowers/specs/2026-07-19-m5a-recursion-core-design.md` | 2026-07-19 | ✅ SHIPPED | Recursive task splitting, plan finalization, approval flow |
| `docs/superpowers/specs/2026-07-19-m5b-grounded-plan-strategy-design.md` | 2026-07-19 | ✅ SHIPPED | Grounded planning strategy for complex tasks, iterative refinement |
| `docs/superpowers/specs/2026-07-19-review-remediation-design.md` | 2026-07-19 | ✅ SHIPPED | Finding categorization, bulk remediation, step retrying |

### Deferred Work & Research

| File | Date | Status | Scope |
|---|---|---|---|
| `docs/superpowers/specs/2026-07-19-neuron-memory-web-research-design.md` | 2026-07-19 | 📋 DEFERRED | Memory lifecycle (decay, sweep, archive, restore) — trigger: knowledge graph grows and hits show clear hot/cold split |
| `docs/IDEAS.md` | ongoing | 📋 ACTIVE | Deferred ideas with reasoning intact; entries graduate when a trigger fires |

## Documentation Status

### Available Now

- ✅ `docs/ARCHITECTURE.md` — System map, data flow, storage service, execution flow
- ✅ `docs/EXTENDING.md` — Seam map for adding providers, executors, skills, tools, events
- ✅ `docs/seams-reference.md` — Component interactions, call paths, debugging strategies
- ✅ `README.md` — Updated with architecture navigation and links to all above

### In Progress / Planned

- 📋 `docs/plans/INDEX.md` (this file) — Approval status and purpose for all plans
- 📋 `docs/GLOSSARY.md` — Key terms with definitions and usage links
- 📋 `vault/memory/` — Formalized ADR notes (durable, searchable)

### Deprecated / Archived

- None yet (all docs are either active or deferred with a trigger)

---

## How to Use This Index

### Finding a Plan by Purpose

- **How do I add a model provider?** → `docs/EXTENDING.md` (seam map, table row: "Add a model provider")
- **How do I understand component interactions?** → `docs/seams-reference.md` (scenarios, call paths)
- **How do I see what's in the roadmap?** → This file (plans table above)
- **What architectural decisions were made and why?** → (Coming in Phase 2.3) `vault/memory/` + search/neighbors

### Approval Status Legend

| Symbol | Meaning |
|---|---|
| ✅ APPROVED | Decision made, committed, shipped (or in PR) |
| ✅ SHIPPED | Fully implemented and in main branch |
| ✅ COMPLETE | Deferred work item that executed successfully |
| 📋 IN PROGRESS | Currently being worked on |
| 📋 PLANNED | Scheduled but not yet started |
| 📋 DEFERRED | Deferred per `IDEAS.md` entry; has a trigger condition |
| ❓ BLOCKED | Waiting on a dependency or decision |

### Phase Breakdown

**Phase 1 (COMPLETE):** Knowledge graph construction via architecture analysis → 7 interconnected memory notes covering event-log, execution, plugins, memory system, vault, ADRs, and findings.

**Phase 2 (IN PROGRESS):** Critical documentation fixes → README index, plans directory index (this file), formalized ADRs, seams reference guide, glossary, ideas.md tracking.

**Phase 3 (PLANNED):** Advanced documentation → extract glossary from codebase, author migration guides for major decisions, establish verification/audit cadence.

---

## Critical Dependencies & Paths

### To find the ADRs
**Status:** Phase 2.3 (planned)
- **When ready:** Search `vault/memory/` for `kind=decision` or search for specific ADR terms
- **For now:** Read `docs/superpowers/specs/` files (ADRs embedded in spec documents)

### To understand how components interact
**Status:** Phase 2.4 (complete)
- **Now:** `docs/seams-reference.md` — call paths by scenario, debugging workflows
- **Fallback:** `docs/ARCHITECTURE.md` + `docs/EXTENDING.md`

### To add a new feature / extension
**Status:** Always current
- **Start:** `docs/EXTENDING.md` seam map (which layer to touch)
- **Then:** Relevant spec in `docs/superpowers/specs/` (e.g., m3-plugins for a new provider)
- **Verify:** Invariants section of `docs/EXTENDING.md`

### To onboard a new contributor
**Status:** Phase 2 documentation gaps being filled
- **Now:** `README.md` → "Architecture & Documentation" section with quick navigation
- **Next:** Send to `docs/ARCHITECTURE.md` for system overview
- **Then:** `docs/EXTENDING.md` seam map for the specific area they'll work in
- **Finally:** Relevant spec for deep dives

---

## Metrics & Success Criteria

### Phase 2 Success Criteria
- ✅ All ADRs accessible and searchable in memory graph (Phase 2.3)
- ✅ Plans directory fully indexed with approval status and purpose (THIS FILE)
- ✅ README includes glossary link and architecture navigation (Phase 2.1 ✅)
- ✅ Seams reference guide published and complete (Phase 2.4 ✅)
- 📋 No orphaned ideas or decisions (Phase 2.5: glossary)
- 📋 Coverage report shows 100% documentation of architectural invariants (Phase 3)

### How to Verify
```bash
# Check README links to all key docs
grep -E "ARCHITECTURE|EXTENDING|seams-reference|GLOSSARY" README.md

# Check that all plans have entries
ls docs/plans/*.md | wc -l  # should match number of entries here

# (After Phase 2.3) Check ADR notes are in memory
orc memory ls | grep -i adr  # should return 8 notes

# (After Phase 2.5) Check glossary exists
test -f docs/GLOSSARY.md && echo "glossary ready"
```

---

## See Also

- `README.md` — Architecture & Documentation section with quick navigation
- `docs/ARCHITECTURE.md` — System map, modules, tiers, storage service
- `docs/EXTENDING.md` — Seam map and invariants
- `docs/seams-reference.md` — Call paths, debugging, component interactions
- `docs/IDEAS.md` — Deferred work with triggers
