# packages/vault-projector/src/index.ts

## Facts
- createVaultProjector (packages/vault-projector/src/index.ts) exposes renderTask/renderAll/start/close, subscribes to the EventLog BEFORE the initial renderAll to avoid a lost-update race, and debounces per-task events into one render 50ms after the last event for that task. {gl0cfzdj @packages/vault-projector/src/index.ts#createVaultProjector #architecture-current}

## Why
- vault-projector does not itself render a memory index or notes; note-md.ts and memory-index.ts in plugins/memory import only vault-projector's frontmatter() to mirror memory notes into the vault as separate files. {dq9yxn9a @packages/vault-projector/src/index.ts @packages/vault-projector/src/frontmatter.ts #architecture-current}
