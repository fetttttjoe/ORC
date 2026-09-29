# packages/kernel/src/execution/scoped-changes-tool.ts

## Facts
- scoped-changes-tool.ts's zonesFor classifies each changed path against the writing step's own declared zone, or, for a descendant task's step or an unknown step, the union of the task's writer steps' zones (none when a writer is unfenced), and execute checks it with the same pathInZone predicate as the write fence. {fhi5ln4n @packages/kernel/src/execution/scoped-changes-tool.ts#zonesFor #fact}
