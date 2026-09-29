# packages/vault-projector

## Facts
- packages/vault-projector folds the kernel event log into a deterministic Obsidian-style markdown vault (root task index, per-task index/execution/lineage/log/session files, usage table, plan files) with a single atomic, skip-unchanged writer. It depends on @orc/contracts (schemas, mermaidLabel, sha256) and @orc/kernel (fold, EventLog, atomicWriteFileSync, usage helpers). {f3q4pnqd @packages/vault-projector #architecture-current}
