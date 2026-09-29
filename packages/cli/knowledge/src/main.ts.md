# packages/cli/src/main.ts

## Facts
- packages/cli/src/main.ts's buildProgram() builds a commander Command tree for every `orc` subcommand and routes every mutating handler through one shared actions() = buildOrcActions(...) instance. {czubnf4a @packages/cli/src/main.ts#buildProgram #architecture-current}
