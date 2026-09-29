# plugins/memory

## Facts
- plugins/memory projects the kernel's append-only event log into a SurrealDB knowledge graph (notes, claims, links, topics) behind a store gateway; writes go through createMemoryStore (event-first, single-writer) while reads hit Surreal directly via createMemoryProjector, with rank/budget shaping what agent tools return and a cancel-time-only sweep for GC. {5ogtjatx @plugins/memory #architecture-current}
