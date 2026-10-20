# Contributing to Orchestrator

How to work in this repository. The rules the code is held to live in [`CLAUDE.md`](CLAUDE.md); the system map is [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Setup

Prerequisites: [Bun](https://bun.sh), Docker, Git.

```bash
docker compose up -d --wait          # Postgres on :5433, loopback only
bun install
git config core.hooksPath scripts/hooks   # once per clone: git never does this for you
bun run hooks:install                # only after adding a new hook name
bun run packages/cli/src/bin.ts db migrate
bun run packages/cli/src/bin.ts init --name my-project   # once per repository
(cd packages/cli && bun link)        # installs a global `orc`
orc tasks
```

Configuration:

- `ANTHROPIC_API_KEY` (or `ORC_ANTHROPIC_AUTH=oauth`), `ORC_DATABASE_URL` (default
  `postgresql://postgres:orc@localhost:5433/orc`) and `ORC_MAX_ITERATIONS` (default 30) come from the
  environment or a `.env` in the project root.
- `.orc/identity.json` is written by `orc init` and never committed: identity belongs to the repository,
  and a committed one would repoint every command, `orc purge` included, at someone else's project.
- `.orc/config.json` is committed and holds settings only: `maxIterations`, `redactEnv`, `mcpServers`,
  `extensions`, `skillsDir`.
- `.orc/trust.json` is written by `orc mcp trust` and `orc ext trust` with mode `0600` and never committed.

## The gate

```bash
bun run typecheck                    # every package, the full script
bun test path/to/file.test.ts        # the files you touched, while working
bun run test:full                    # the gate: four workers, ~110 s, Postgres up
bun run check:web                    # when graph-ui changed
```

Plain `bun test` runs sequentially and keeps the 5 s default timeout so a hang shows fast. Run the gate
once before merging. Teardown in a test is unconditional (`finally`, `afterAll` or the file's `cleanup`
array).

A schema change ships a reviewed SQL migration under `packages/kernel/drizzle/`. `drizzle-kit` is
deliberately not installed; generate with a pinned one-shot `bunx drizzle-kit@latest generate` and audit the
output.

## Code

TypeScript strict, ESM, named exports. Parsing goes through zod, vocabulary comes from enums and exported
constants, and comments stay out of the code. The full list, with the reasons, is in
[`CLAUDE.md`](CLAUDE.md). A change that works but reads as bolted on is a design problem: redesign it.

Docs describe the system as it is. A decision that shapes the code is recorded as a file under
`docs/decisions/` with `orc adr`, and project knowledge is written as claims; the format is in
[`docs/knowledge-files.md`](docs/knowledge-files.md).

## Commits

```
<type>(<scope>): <subject>

<body>
```

- `type` is one of `feat`, `fix`, `docs`, `refactor`, `test`, `perf`, `build`, `ci`, `chore`, `revert`.
- `scope` names the component (`kernel`, `cli`, `contracts`, `ui`, ...); commas go inside the parens.
- The subject says what is now true, lowercase, no period; the whole message is at most two lines.
- The body is at most one line saying what and why. No footer, no issue trailer, no AI mention.

One change per branch.

## Hooks

`git config core.hooksPath scripts/hooks` points git at the tracked hooks.

- `commit-msg` enforces the commit format by refusal. It never edits the message.
- `post-commit` records the commit as a `Door.hook` event in the project's log, detached and fail-open: a
  commit made with no project or no database is still a commit.

Each hook is a generic dispatcher (`scripts/hooks/<name>`) that runs the sibling `<name>.sh` or `<name>.ts`.

## Troubleshooting

- `orc` cannot reach Postgres: `docker compose up -d --wait`, then `docker compose logs postgres`.
- Dev state is wrecked: `docker compose down -v && docker compose up -d --wait && orc db migrate`, then
  `orc init` once if the main checkout has no `.orc/identity.json`.
- A hook never runs: `git config core.hooksPath` must read `scripts/hooks`, and `bun run hooks:install`
  restores the executable bit.
