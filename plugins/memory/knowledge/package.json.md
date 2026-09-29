# plugins/memory/package.json

## Facts
- plugins/memory depends on @orc/contracts (the memory-note domain and MemoryStore interface), @orc/kernel (EventLog and ProjectorLease, both implemented under packages/kernel/src/storage), and @orc/vault-projector (frontmatter rendering used by note-md.ts and memory-index.ts to mirror notes into the vault). {9vdccv1i @plugins/memory/package.json @plugins/memory/src/write-note.ts @plugins/memory/src/note-md.ts #architecture-current}
