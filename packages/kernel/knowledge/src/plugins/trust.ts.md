# packages/kernel/src/plugins/trust.ts

## Facts
- plugins/trust.ts binds each MCP or extension trust grant to a SHA-256 fingerprint of the declaration (mcpFingerprint: command+args+env-ref-names) or content (extensionFingerprint: entry file + local imports + lockfile), so editing the declaration or content invalidates prior consent. {lent2q7t @packages/kernel/src/plugins/trust.ts#mcpFingerprint @packages/kernel/src/plugins/trust.ts#extensionFingerprint #architecture-current}

## Why
- Only a $NAME env value is covered by the declaration fingerprint, because it names which secret the server receives and is a reference rather than secret material, while literal values fold to a constant so rotating one neither leaks a verifier into trust.json nor voids consent. {9g64xuw4 @packages/kernel/src/plugins/trust.ts#envDeclaration}
