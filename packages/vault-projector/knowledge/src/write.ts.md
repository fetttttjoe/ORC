# packages/vault-projector/src/write.ts

## Facts
- writeVaultFiles in packages/vault-projector/src/write.ts is the single writer for the vault subtree: it reads a .orc-manifest.json of path→sha256, skips unchanged content, refuses to overwrite an existing plan-v*.md (write-once, protects hand edits), warns before overwriting any other hand-edited projection file, and writes atomically via atomicWriteFileSync from @orc/kernel. {50bdajmw @packages/vault-projector/src/write.ts#writeVaultFiles #architecture-current}
