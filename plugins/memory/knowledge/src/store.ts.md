# plugins/memory/src/store.ts

## Facts
- createMemoryStore in plugins/memory/src/store.ts is the single writer for memory notes: write() appends a memory_written event to the kernel EventLog (event-first) and merges omitted fields forward from the prior revision rather than clearing them. {vng3qqic @plugins/memory/src/store.ts#createMemoryStore #architecture-current}
