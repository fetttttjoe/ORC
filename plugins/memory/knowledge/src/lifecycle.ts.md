# plugins/memory/src/lifecycle.ts

## Facts
- archive.ts's evidence-based retirement (archiveCandidates) is driven today by recheck.ts's recheckNotes as a discrete, manually-invoked operation; createMemoryLifecycle in lifecycle.ts — the standing event subscriber — currently wires only auto-consolidation on task completion (consolidateOnCompletion) and does not call archive/recheck automatically. {3jqd8hzs @plugins/memory/src/lifecycle.ts#createMemoryLifecycle @plugins/memory/src/recheck.ts#recheckNotes #architecture-target}

## Why
- lifecycle.ts's own doc comment names decay/sweep, re-embedding, and LLM distillation as future operations meant to plug into the same lifecycle seam auto-consolidation already occupies, which is why wiring archive.ts's rules to run automatically (rather than via a manual recheck invocation) is deferred rather than abandoned. {j4gl3rhk @plugins/memory/src/lifecycle.ts #architecture-target}
