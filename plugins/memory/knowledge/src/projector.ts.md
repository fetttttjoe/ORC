# plugins/memory/src/projector.ts

## Facts
- The projector debounces refreshLinks and refreshTopics on the live write path (DERIVED_REFRESH_DEBOUNCE_MS=5000ms, capped at DERIVED_REFRESH_MAX_WAIT_MS=30000ms) so a burst of writes collapses into one derived-graph refresh, while catchUp/start/rebuild run them synchronously. {03umf6p5 @plugins/memory/src/projector.ts #architecture-current}
- createMemoryProjector in plugins/memory/src/projector.ts drains MEMORY_KINDS (memory_written, memory_deleted, memory_accessed, memory_verified, memory_outcome) from the EventLog and applies each event to SurrealMemory.applyEvent to build the SurrealDB read model. {kzdwi2x8 @plugins/memory/src/projector.ts#createMemoryProjector #architecture-current}
