# plugins/memory/src/sweep.ts

## Facts
- orphanedNotes in plugins/memory/src/sweep.ts is the only GC left in the memory plugin: it is deterministic and cancel-time only (a note is swept iff its last writer's task is in the cancelled set and no surviving note links to it), appending a memory_deleted event; a prior TTL-based sweep was deleted in favor of evidence-based archive.ts. {o3bnf4wk @plugins/memory/src/sweep.ts#orphanedNotes #architecture-current}
