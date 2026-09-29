# packages/kernel/src/config.ts

## Facts
- config.loadConfig resolves OrcConfig by merging tracked .orc/config.json settings with env overrides (env wins) and gitignored .orc/identity.json (projectId/projectName last, so it cannot be overridden by tracked settings), validated through one zod settingsSchema. {ikx06ls2 @packages/kernel/src/config.ts#loadConfig #architecture-current}

## Why
- Project identity (projectId/projectName) is deliberately split from tracked settings into gitignored .orc/identity.json, so cloning or worktree-adding the repo never silently repoints an existing project's history. {17svsuhg @packages/kernel/src/config.ts#IDENTITY_FILE #architecture-current}
