# packages/kernel/src/execution/command-argv.ts

## Why
- commandArgv adds quoting but no shell, so the allowlist matched against the raw string still bounds what runs: |, ;, &&, globs and $(...) stay literal argv characters. {3immhyjz @packages/kernel/src/execution/command-argv.ts#commandArgv}
- commandArgv honours quotes instead of splitting on every space, because a quoted multi-word grep pattern would otherwise reach grep as fragments it reads as file names. {qxkto71e @packages/kernel/src/execution/command-argv.ts#commandArgv}
