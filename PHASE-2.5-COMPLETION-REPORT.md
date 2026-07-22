# Phase 2.5 Completion Report: Formalize Ideas Tracking and Decision Backlog

**Execution Date:** 2026-07-21 (this step)
**Phase:** Phase 2.5 (Critical documentation fixes, sub-phase: ideas tracking)
**Status:** ✅ COMPLETE

## Requirements Met

### ✅ 1. Extract and categorize all ideas from docs/IDEAS.md
- **8 ideas extracted** with full context and rationale preserved
- **Categorized by:**
  - **Status:** 2 shipped/fixed, 5 proposed (deferred), 1 research/reference
  - **Domain:** memory (4), plugins/security (1), reliability (2), research (1)
  - **Priority:** high (2), medium (3), low (1), reference (1)
- **Triggers identified:** scale-triggered (2), adoption-triggered (1), dependency-triggered (1), no-trigger-needed (shipped/fixed)

### ✅ 2. Create memory notes for each idea
- **8 memory notes created** with proper metadata:
  - `idea-neuron-memory-lifecycle` — high-priority, scale-triggered
  - `idea-scheduled-maintenance` — medium, depends on lifecycle
  - `idea-mcp-grants` — high-priority, security boundary
  - `idea-index-performance` — medium, scale-triggered
  - `idea-buildruntime-leak` — medium, affects embedders
  - `idea-retention-field` — shipped 2026-07-20 (decision note)
  - `idea-test-pool-leak` — fixed 2026-07-20, measured 38→15 connection improvement
  - `idea-code-review-graph-techniques` — research/reference, three techniques to adopt

**Each note includes:**
- Title, summary, rationale, categories, tags, scope
- Rules (design constraints and patterns)
- Uncertainty (open questions)
- Retention: durable (all)
- Links to related ideas and ADRs (dependency graph)
- Sources where applicable (research note)

### ✅ 3. Create master ideas index
- **ideas-index memory note created** with:
  - Full catalog of all 8 ideas grouped by status
  - Dependency graph showing neuron-lifecycle blocks scheduled-maintenance
  - Organizing principles documented
  - Status definitions and legend
  - Navigation by priority, domain, trigger type
  - Search patterns for discovering ideas
  - Procedures for when triggers fire or ideas are rejected

### ✅ 4. Archive rejected ideas with explanation
- **No rejected ideas at this time** (all ideas are either proposed, shipped, or research)
- **Architecture in place:** ideas marked as rejected can be archived with rationale; no orphaned ideas
- **Audit trail:** completed/shipped ideas (retention-field, test-pool-leak) preserved with decision rationale

### ✅ 5. Link from README to ideas index
- **README.md updated:**
  - Added "Ideas & backlog" row to Quick Navigation table
  - Links to both `docs/IDEAS.md` (canonical spec) and `docs/IDEAS-MEMORY-INDEX.md` (memory-indexed)
  - Clear explanation of what each resource contains

### ✅ Acceptance Criteria

- ✅ **All ideas cataloged in memory with clear status** — 8 notes, each with status tag (proposed/shipped/fixed/reference)
- ✅ **No ambiguity about whether idea is active or closed** — status tags + descriptions make state explicit
- ✅ **Searchable by domain and priority** — tags system in place; search pattern documented
- ✅ **Index discoverable from README** — direct link added to README Quick Navigation
- ✅ **Rejected ideas retained with explanation** — process documented in ideas-index note; no rejections yet

## Deliverables

### Memory Notes Created (8)
1. `idea-neuron-memory-lifecycle` (kind: plan, high-priority)
2. `idea-scheduled-maintenance` (kind: plan, medium-priority)
3. `idea-mcp-grants` (kind: plan, high-priority, security)
4. `idea-index-performance` (kind: plan, medium-priority)
5. `idea-buildruntime-leak` (kind: plan, medium-priority)
6. `idea-retention-field` (kind: decision, shipped 2026-07-20)
7. `idea-test-pool-leak` (kind: decision, fixed 2026-07-20)
8. `idea-code-review-graph-techniques` (kind: research, low-priority)

### Documents Created (2)
1. `docs/IDEAS-MEMORY-INDEX.md` — Comprehensive index with navigation by priority/domain/trigger, status definitions, procedures
2. `README.md` — Updated Quick Navigation table with ideas index links

### Ideas Dependency Graph
```
idea-neuron-memory-lifecycle
  ├─ blocks: idea-scheduled-maintenance
  └─ relates-to: idea-index-performance, idea-code-review-graph-techniques

idea-scheduled-maintenance
  └─ depends-on: idea-neuron-memory-lifecycle

idea-mcp-grants
  └─ security-triggered: auto approval + task_split

idea-index-performance
  └─ scale-triggered: ~200 notes

idea-buildruntime-leak
  └─ affects: embedders, long-lived processes
```

## Key Insights

### 1. Triggering Over Hypothetical
All ideas have explicit trigger conditions, not guesses. Example:
- neuron-lifecycle: "when vault holds ~600 notes and observed hot/cold split is evident"
- index-performance: "when graph passes ~200 notes or bun test gets measurably slower"
- mcp-grants: "when anyone runs with auto approval or installs third-party MCP"

### 2. Design Fixes Forward
Neuron-lifecycle idea includes three corrections to apply when building:
- Activation ranks (not filters) to preserve visibility
- Retirement protects authored inbound links
- Access events from tools.ts, not reverse-parsed from tool_result

### 3. Shipped/Fixed as Audit Trail
Two ideas already shipped/fixed:
- `retention` field: lesson on judgment capture timing ("no reader yet" defers behavior, never judgment)
- Pool leak: measured improvement (38→15 Postgres connections) with pattern for adoption

### 4. Research Techniques Banked
Code-review-graph research yields three low-cost techniques:
- Dual-mode evaluation (circular vs independent ground truth)
- Reciprocal Rank Fusion (8 lines, merge N ranked lists)
- Estimator calibration (keep chars/4, verify offline)

### 5. No Orphaned Ideas
Every idea cataloged, linked, tagged, and discoverable. Archive process documented for future rejections.

## Verification

### Search Capability
All ideas discoverable via memory graph:
- **Search by prefix:** `orc memory search "idea-"` returns all 8
- **Search by tag:** `idea-` prefix guaranteed across all note ids
- **Search by domain:** filter by scope (memory, plugins, kernel, testing)
- **Search by priority:** filter by tag (high-priority, medium-priority, low-priority, reference)

### Index Navigation
From README → docs/IDEAS-MEMORY-INDEX.md:
- Master index shows all ideas with status at a glance
- Dependency graph visualizes blocking relationships
- Status definitions provide clear semantics
- Procedures documented for when triggers fire or ideas rejected

### Compatibility with Phase 2
- ✅ Independent of other Phase 2 tasks (plans index, seams guide, ADRs formalization)
- ✅ Depends on phase2-readme-index for README link (satisfied)
- ✅ No conflicts with existing architecture or memory graph

## Next Steps (Phase 3 or Later)

1. **When triggers fire:** Each idea note documents how to proceed
   - Create task, link with `implements` relationship
   - Update idea note status to `in-flight`
   - Update ideas-index with task link

2. **When ideas ship:** Update status to `shipped`, add verification notes

3. **If ideas rejected:** Archive with decision and rationale

4. **Scaling guidance:** At ~200 notes, measure index-performance trigger and prioritize fix

## Scope and Gaps

### What This Covers
- ✅ All 8 ideas from docs/IDEAS.md extracted and formalized
- ✅ Memory graph integration (8 new notes, discoverable)
- ✅ Index created and linked from README
- ✅ Status tracking with clear semantics
- ✅ Dependency management (blocking relationships explicit)
- ✅ Trigger conditions documented for each proposal
- ✅ Design fixes forward (corrections to apply when building)
- ✅ Audit trail for completed/rejected ideas

### Known Gaps (Out of Scope)
- ⏳ Phase 3 (Advanced documentation): glossary extraction, migration guides, audit cadence
- ⏳ Ideas becoming in-flight: will be handled by future Phase 3 or on-demand
- ⏳ ADR formalization: separate Phase 2 task (this phase focused on ideas only)

## Confidence Level

**HIGH** — All requirements met, all ideas properly cataloged with clear status, memory graph integration complete, README updated with discoverable link.

---

**Prepared by:** Claude Code (Anthropic CLI)
**Execution Environment:** Phase 2.5 (Formalize Ideas Tracking)
**Model Token Budget Used:** ~25 of 200 model calls available
