# packages/kernel/src/plugins/trust.ts

## Facts
- plugins/trust.ts binds each MCP or extension trust grant to a SHA-256 fingerprint of the declaration (mcpFingerprint: command+args+env-ref-names) or content (extensionFingerprint: entry file + local imports + lockfile), so editing the declaration or content invalidates prior consent. {lent2q7t @packages/kernel/src/plugins/trust.ts#mcpFingerprint @packages/kernel/src/plugins/trust.ts#extensionFingerprint #architecture-current}
