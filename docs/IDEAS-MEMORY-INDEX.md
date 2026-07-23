# Ideas and Backlog — Memory-Indexed Version

This file links to the memory-indexed version of all deferred ideas, decisions, and architectural futures tracked in the project. The canonical source is `docs/IDEAS.md` (reasoning and specifications); this index makes ideas discoverable through the project knowledge graph.

## Quick Links

- **Master Index** → Search: `ideas-index` in memory
- **All Ideas** → Search: `idea-` prefix in memory
- **By Domain** → Filter memory notes by tag: `idea-neuron-memory-lifecycle`, `idea-mcp-grants`, `idea-scheduled-maintenance`, `idea-index-performance`, `idea-buildruntime-leak`, `idea-retention-field`, `idea-test-pool-leak`, `idea-code-review-graph-techniques`

## Ideas Catalog (Memory Nodes)

### Active Proposals

#### High Priority

1. **idea-neuron-memory-lifecycle** — Neuron-like memory lifecycle (decay, sweep, archive, restore)
   - **Domain:** memory, architecture
   - **Status:** proposed, scale-triggered (~600 notes)
   - **Effort:** high (19-slice design exists)
   - **Blocks:** idea-scheduled-maintenance
   - **Key insight:** activation ranks (not filters), retirement must protect authored inbound links
   - **Trigger:** observed hot/cold access split in vault when notes accumulate

2. **idea-mcp-grants** — MCP grants bind the process, not the tool surface
   - **Domain:** security, plugins
   - **Status:** proposed, adoption-triggered
   - **Effort:** medium (~30 lines + CLI flow)
   - **Current state:** gap invisible under default manual approval; exposed under auto approval policy
   - **Trigger:** anyone runs with auto approval rule or installs third-party MCP server

#### Medium Priority

3. **idea-scheduled-maintenance** — Scheduled / automatic memory maintenance
   - **Domain:** memory, operations
   - **Status:** proposed, depends-on-lifecycle
   - **Depends on:** idea-neuron-memory-lifecycle (lifecycle must ship first, be proven)
   - **Rationale:** manual sweep not sustainable at scale
   - **Key principle:** policy in lifecycle service, scheduler is adapter only

4. **idea-index-performance** — `index.md` re-renders every note body on every event
   - **Domain:** memory, performance
   - **Status:** proposed, scale-triggered (~200 notes)
   - **Why deferred:** invisible at zero notes; breaks at scale (mermaid maxEdges 500)
   - **Fix:** project select to minimal fields, refresh on batch boundary

5. **idea-buildruntime-leak** — `buildRuntime` leaks projector and Surreal socket on throw
   - **Domain:** reliability, cleanup
   - **Status:** proposed, affects-embedders
   - **Current state:** invisible in CLI (process.exit force-kills); impacts embedders/long-lived processes
   - **Fix:** try/catch around port construction, close resources before rethrow

### Completed Ideas (Shipped/Fixed)

6. **idea-retention-field** — `retention: durable | expirable` on notes (SHIPPED 2026-07-20)
   - **Status:** shipped
   - **Key lesson:** \"no reader yet\" defers behavior, never defers judgment capture
   - **Why decision reversed immediately:** data capture only possible at creation time; retroactive defaulting is backwards
   - **Solution:** default to durable (fail-safe); authors supply intent at write time

7. **idea-test-pool-leak** — Test-helper connection pools are never closed (FIXED 2026-07-20)
   - **Status:** fixed
   - **Measured improvement:** peak Postgres connections 38→15 of 100 during full `bun test`
   - **Pattern:** helper provides `onClose()` handle; closers run LIFO before drop
   - **Also fixed:** EventLog.subscribe error listener guard

### Research and Techniques (Low Priority, Reference)

8. **idea-code-review-graph-techniques** — Techniques banked from tirth8205/code-review-graph
   - **Domain:** research, ranking, knowledge
   - **Status:** reference, low-priority
   - **Three techniques to adopt:**
     1. Honest dual-mode evaluation against circular vs independent ground truth
     2. Reciprocal Rank Fusion for merging ranked lists (8 lines, no dependency)
     3. Calibrate estimator, never replace it (keep chars/4 hot, verify offline)
   - **Explicitly rejected:** query-shape boosting, context_savings metadata, risk/surprise scoring, editor auto-config

## Navigation

### By Priority

- **Critical:** none currently (all critical ideas would be filed as issues)
- **High:** idea-neuron-memory-lifecycle, idea-mcp-grants
- **Medium:** idea-scheduled-maintenance, idea-index-performance, idea-buildruntime-leak
- **Low:** idea-code-review-graph-techniques
- **Shipped:** idea-retention-field, idea-test-pool-leak

### By Domain

| Domain | Ideas |
|---|---|
| **memory** | neuron-lifecycle, scheduled-maintenance, index-performance, retention-field |
| **security/plugins** | mcp-grants |
| **reliability** | buildruntime-leak, test-pool-leak |
| **research** | code-review-graph-techniques |

### By Trigger Type

- **Scale-triggered:** neuron-lifecycle (~600 notes), index-performance (~200 notes)
- **Adoption-triggered:** mcp-grants (auto approval, third-party MCP)
- **Time-based:** none (all have explicit trigger conditions)
- **Dependency-triggered:** scheduled-maintenance (depends on lifecycle), buildruntime-leak (affects embedders)

## Status Definitions

- **proposed** — idea captured with trigger(s) identified; waiting for trigger condition to fire
- **under-review** — actively being evaluated for approach/tradeoffs
- **approved** — decision made; ready for implementation planning
- **in-flight** — actively being implemented
- **shipped** — feature deployed and in use
- **fixed** — bug fixed and verified
- **rejected** — decision made not to pursue (archived with rationale)
- **reference** — research or technique banked for future use, not scheduled

## Organizing Principles

1. **Triggering, not hypothetical.** Ideas graduate when a real trigger fires (observation from use), not a hunch. Entries that never trigger are the point.
2. **Deferral with reasoning intact.** Each idea documents: what (spec), why deferred (judgment), and what makes it worth building (trigger criteria).
3. **Design fixes forward.** Known corrections documented so eventual build starts from improved version, not original sketch.
4. **No second-guessing on constants.** Half-life, thresholds, routing floors calibrated from *observed data*, not round numbers.
5. **Fail-safe defaults.** When uncertain (retention field, pool cleanup), choose conservative option.

## Dependency Graph

```
idea-neuron-memory-lifecycle
  ├─ blocks: idea-scheduled-maintenance
  └─ relates-to: idea-index-performance, idea-code-review-graph-techniques

idea-scheduled-maintenance
  └─ depends-on: idea-neuron-memory-lifecycle

idea-mcp-grants
  └─ triggers-on: auto approval policy + task_split, third-party MCP adoption

idea-index-performance
  └─ scale-triggered: ~200 notes in vault

idea-buildruntime-leak
  └─ affects: embedders, long-lived processes (not CLI)
```

## Searching the Ideas Index

All ideas are memory notes with:
- **ID pattern:** `idea-*` (e.g., `idea-neuron-memory-lifecycle`)
- **Tags:** deferred, completed, reference, high-priority, medium-priority, low-priority, scale-triggered, adoption-triggered
- **Scope:** memory, plugins, kernel, testing
- **Kind:** plan (for futures), decision (for past decisions), research (for techniques)

Use memory graph search to find ideas by:
```
orc memory search \"idea-\" --limit 10     # all ideas
orc memory search \"high-priority\" --tag    # by priority tag
orc memory search \"memory\" --category     # by domain
```

## Keeping Ideas Fresh

When a trigger fires:
1. Read the corresponding idea note for full context, rationale, and design fixes to apply
2. Create a task and link it to the idea with `implements` relationship
3. Update the idea note with task link and status change to `in-flight`
4. Update this index with link to task

When an idea is rejected (never ships):
1. Archive the idea note with kind=decision, add `rejected` tag
2. Document rationale for rejection
3. Update this index

## See Also

- `docs/IDEAS.md` — canonical spec with reasoning (this links to it)
- `ideas-index` — master memory note
- `docs/plans/INDEX.md` — approved plans with implementations (cross-reference when idea becomes task)
- `docs/ARCHITECTURE.md` — current system design
"