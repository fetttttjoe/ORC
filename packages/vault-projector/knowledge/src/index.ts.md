# packages/vault-projector/src/index.ts

## Facts
- createVaultProjector (packages/vault-projector/src/index.ts) exposes renderTask/renderAll/start/close, subscribes to the EventLog BEFORE the initial renderAll to avoid a lost-update race, and debounces per-task events into one render 50ms after the last event for that task. {gl0cfzdj @packages/vault-projector/src/index.ts#createVaultProjector #architecture-current}
