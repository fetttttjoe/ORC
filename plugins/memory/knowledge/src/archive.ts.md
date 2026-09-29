# plugins/memory/src/archive.ts

## Facts
- archive.ts's rule() retires a memory note only on affirmative evidence — it is superseded/contradicted by another live note, its task has settled with nothing linking to it, or it has corroborated dead-end usage reports (memory_outcome events showing zero useful and at least DEAD_END_CORROBORATION=2 dead-end reports) — and it deliberately never treats a note's age, recency, or coldness as retirement grounds. {edxd8y2b @plugins/memory/src/archive.ts#rule #architecture-target}
- The one retirement reason in archive.ts gated on observed usage ("hits") data is dead-end: it fires only once a note is reported dead-end at least DEAD_END_CORROBORATION=2 times via memory_outcome events with zero useful reports ever recorded for it. {i3wv6emv @plugins/memory/src/archive.ts#rule #architecture-target}

## Why
- A prior TTL/age-based sweep was deleted in favor of archive.ts's evidence-based rule because age measures neither correctness nor relevance: a stable, rarely-consulted but still-true note is exactly what an age-based sweep would discard first. {x6toiwcn @plugins/memory/src/archive.ts #architecture-target}
