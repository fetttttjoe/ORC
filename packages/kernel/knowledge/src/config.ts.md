# packages/kernel/src/config.ts

## Facts
- config.loadConfig resolves OrcConfig by merging tracked .orc/config.json settings with env overrides (env wins) and gitignored .orc/identity.json (projectId/projectName last, so it cannot be overridden by tracked settings), validated through one zod settingsSchema. {ikx06ls2 @packages/kernel/src/config.ts#loadConfig #architecture-current}

## Why
- Project identity (projectId/projectName) is deliberately split from tracked settings into gitignored .orc/identity.json, so cloning or worktree-adding the repo never silently repoints an existing project's history. {17svsuhg @packages/kernel/src/config.ts#IDENTITY_FILE #architecture-current}
- loadConfig loads the project .env before envOverrides and before openStorage snapshots process.env, so a project .env can set ORC_* and its secrets are redacted like any other. {wn73vmpd @packages/kernel/src/config.ts#loadConfig}
- loadProjectEnv exists because Bun's .env pickup is cwd-relative with no walk-up, so orc run from a subdirectory would lose every credential and fail late as a provider_error inside a run. {u00xtcex @packages/kernel/src/config.ts#loadProjectEnv}
- skillsDir resolves against the checkout being worked in rather than projectRoot, because vault/skills is tracked source: from a linked worktree the main checkout's path would make a branch-added role skill unknown. {6kogwxam @packages/kernel/src/config.ts#settingsSchema}
- trunkBranch has no default because unset means ask git (origin/HEAD), and a default would answer 'main' for a repo whose trunk is master or develop. {rl1hwsvf @packages/kernel/src/config.ts#settingsSchema}
