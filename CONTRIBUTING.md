# Contributing to Orchestrator

Welcome! This guide covers development practices, documentation lifecycle, and the verification processes that keep the architecture discoverable and maintainable.

---

## Table of Contents

1. [Getting Started](#getting-started)
2. [Development Workflow](#development-workflow)
3. [Documentation Lifecycle](#documentation-lifecycle)
4. [Verification & Audit Process](#verification--audit-process)
5. [Code Review Expectations](#code-review-expectations)
6. [Testing & Test Organization](#testing--test-organization)
7. [Architecture Decisions (ADRs)](#architecture-decisions-adrs)
8. [Commit Message Conventions](#commit-message-conventions)
9. [Troubleshooting](#troubleshooting)

---

## Getting Started

### Prerequisites

- **Node.js**: Use Bun (which manages its own version)
- **Docker**: For Postgres and SurrealDB
- **Bun**: Install from https://bun.sh
- **Git**: For version control

### Initial Setup

```bash
# Clone the repository
git clone <repository-url>
cd orchestrator

# Start databases
docker compose up -d --wait
# Postgres runs on :5433 (loopback only)
# SurrealDB runs on :8000 (loopback only)

# Install dependencies
bun install

# Run migrations
bun run packages/cli/src/bin.ts db migrate

# Initialize project (one time)
bun run packages/cli/src/bin.ts init --name my-project

# Run tests
bun test

# Create CLI alias for convenience
alias orc="bun $PWD/packages/cli/src/bin.ts"

# Verify setup
orc status
```

### Configuration

- **Environment variables**:
  - `ANTHROPIC_API_KEY`: Required for Claude models (get from Anthropic console)
  - `ORC_DATABASE_URL`: Override default Postgres connection (default: `postgresql://postgres:orc@localhost:5433/orc`)
  - `ORC_MAX_ITERATIONS`: Default agent loop budget (default: 30)

- **Project config** (`.orc/config.json`): Created by `orc init`, contains:
  - `projectId` and `projectName` (committed, provides project isolation)
  - `maxIterations`: Agent loop budget (approved at plan time)
  - `redactEnv`: List of env var names to redact in vault (e.g., `ANTHROPIC_API_KEY`)
  - `mcpServers`: MCP server declarations (name, command, args, env names)
  - `extensions`: Extension file paths and entry points
  - `skillsDir`: Directory containing skill definitions

- **Trust grants** (`.orc/trust.json`): Created by `orc mcp trust` / `orc ext trust`, never committed:
  - Binds MCP servers to fingerprints (command + args + env names)
  - Binds extensions to file closure + `bun.lock`
  - Mode `0600` (readable only by user)
  - Run `orc mcp trust <id>` / `orc ext trust <path>` to create

---

## Development Workflow

### Branch Strategy

- **main**: Stable, tested, shipped. All changes require PR.
- **feature branches**: One feature per branch, named `feat/your-feature-name`
- **bugfix branches**: Named `fix/issue-description`
- **docs branches**: Named `docs/what-changed`

### Creating a Feature Branch

```bash
git checkout main
git pull origin main
git checkout -b feat/your-feature-name
```

### Before Committing

1. **Code must pass tests**:
   ```bash
   bun test
   # or test a specific file:
   bun test packages/kernel/src/storage.test.ts
   ```

2. **Code must follow style conventions**:
   - TypeScript strict mode (no implicit `any`)
   - Use `.ts` (not `.js`)
   - ESM imports (no CommonJS)
   - Named exports over default exports

3. **If you changed architecture**: Create or update an ADR (see [Architecture Decisions](#architecture-decisions-adrs))

4. **If you changed storage schema**: Commit a SQL migration in `packages/kernel/drizzle/`:
   ```bash
   bunx drizzle-kit@latest generate
   # Review the generated SQL
   git add packages/kernel/drizzle/
   ```
   > Note: `drizzle-kit` is deliberately not in `package.json` to keep the loader chain safe. Always use `bunx` with a pinned version.

### Commit Message Format

```
<type>(<scope>): <subject>

<body>

<footer>
```

- **type**: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`
- **scope**: component affected (`storage`, `execution`, `memory`, `plugins`, `cli`, `ui`, etc.)
- **subject**: Imperative mood, lowercase, no period (50 chars max)
- **body**: Explain what and why, not how (optional, wrapped at 72 chars)
- **footer**: Reference issues: `Fixes #123` or `Relates to docs#456` (optional)

**Examples**:

```
feat(execution): implement output receipt verification

Adds artifact_produced events that verify each declared output:
- Read file from workspace
- Compute SHA-256 receipt
- Commit atomically with step_completed

Fixes #234
```

```
docs(architecture): update ADR-0005 for DBOS upgrade

DBOS 2.0 now supports custom handlers. Updated ADR to reflect
current implementation and updated seams guide with new call paths.

Relates to task-xyz
```

### Creating a Pull Request

1. **Push your branch**:
   ```bash
   git push origin feat/your-feature-name
   ```

2. **Open PR on GitHub**:
   - Title: `<type>(<scope>): <subject>`
   - Description: Link to related issue; explain what changed and why
   - Check: Does your PR description explain the change to a new contributor?

3. **Wait for checks**:
   - Tests must pass (`bun test`)
   - Documentation verification (see [Verification & Audit Process](#verification--audit-process))
   - Code review from at least one maintainer

---

## Documentation Lifecycle

Every architectural change must be documented. Here's when and how.

### 1. Writing an Architectural Decision (ADR)

**Trigger**: Any decision about:
- New architectural boundaries or seams
- New storage schema
- New plugin contract or extension point
- Changes to critical invariants
- Changes to operational procedures

**Process**:

1. Create a new ADR in `docs/superpowers/specs/` or architecture notes:
   ```markdown
   # ADR-XXXX: [Decision Title]
   
   **Date**: YYYY-MM-DD
   **Status**: Proposed / Accepted / Superseded by ADR-XXXX
   **Context**: Why did we need to decide?
   **Decision**: What did we decide?
   **Consequences**: What changes as a result?
   **Alternatives Considered**: What else did we try?
   ```

2. Link the ADR in the masterplan note as a decision
3. If the ADR affects a seam, update `docs/seams-reference.md` with new invariants
4. Get approval from architecture owner (see code review)
5. Create a memory note to formalize the decision (see [ADRs & Memory](#architecture-decisions-adrs))

### 2. Updating Seams When Code Changes

**Trigger**: Code change to:
- Event storage or validation
- Operation journal or durability
- Execution flow or checkpointing
- Memory write or query
- Approval or feedback routing

**Process**:

1. Identify which seam(s) are affected:
   - **Event Log**: Storage, validation, redaction, idempotency
   - **Operation Journal**: Before-the-effect, transactions, recovery
   - **Execution Flow**: Checkpoints, step isolation, signal routing
   - **Memory/Knowledge**: Event-first writes, citations, rebuild
   - **Feedback & Approval**: Hash-bound approval, idempotent routing

2. Update `docs/seams-reference.md`:
   - Revise data format description (if schema changed)
   - Update invariants (if logic changed)
   - Add new error recovery procedure
   - Update performance notes
   - Link to test changes

3. Run verification check 4.2–4.6 (seams guide verification)

### 3. Adding a New Plan

**Trigger**: Any significant work:
- Feature (>10 hours)
- Refactoring (code or architecture)
- Operations (process, infra, tooling)

**Process**:

1. Create plan draft in `docs/plans/<name>.md`:
   ```markdown
   # [Plan Title]
   
   **ID**: plan-YYYYMMDD-description
   **Status**: Proposed / Approved / In Progress / Complete
   **Owner**: [Name]
   **Dependencies**: [List other plans or ADRs]
   
   ## Scope
   
   [What does this accomplish?]
   
   ## Requirements
   
   [What must be true?]
   
   ## Acceptance Criteria
   
   [How do we know it's done?]
   ```

2. Add to `docs/plans/INDEX.md` with status marker:
   - ✅ for approved/shipped
   - 📋 for pending approval
   - 🔄 for deferred/revisit

3. If plan changes architecture, create corresponding ADR

4. Submit plan in PR; get approval before starting work

### 4. Updating README When Adding Documentation

**Trigger**: New file in:
- `docs/` (new .md file)
- `docs/plans/` (new plan)
- `docs/seams/` (new seam guide section)

**Process**:

1. If new top-level doc, add to Quick Navigation table in README:
   ```markdown
   | **Topic** | Description | Link |
   |---|---|---|
   | **New Topic** | What it covers | `docs/newfile.md` |
   ```

2. If new seam, add to seams-reference.md table of contents

3. If new plan, add to plans/INDEX.md

4. Run verification check 1.3–1.4 (README links)

### 5. Publishing Ideas & Deferred Work

**Trigger**: Feature that won't ship soon but should be tracked

**Process**:

1. Add to `docs/IDEAS.md`:
   ```markdown
   - **[Idea Title]**
   - Trigger: [When should we revisit this?]
   - Effort: [T-shirt size: S/M/L/XL]
   - Owner: [Who should lead this?]
   - Details: [2–3 sentences]
   ```

2. If idea involves architectural change, formalize as a note in memory:
   ```bash
   orc memory write --id idea-short-name \
     --title "Idea: [Full Title]" \
     --kind idea \
     --body "..."
   ```

3. Link in `docs/IDEAS-MEMORY-INDEX.md` (auto-generated from memory)

---

## Verification & Audit Process

### Per-PR Verification

Before code review, ensure:

1. **All tests pass**: `bun test`
2. **No console errors**: Check CI output
3. **Documentation updated** (if applicable):
   - Did you change architecture? Add/update ADR
   - Did you change a seam? Update seams-reference.md
   - Did you add a new file? Update README/INDEX
4. **Run spot checks**:
   ```bash
   # README links
   grep "docs/ARCHITECTURE\|docs/EXTENDING\|docs/seams" README.md
   
   # Plans INDEX
   test -f docs/plans/INDEX.md && echo "✓ plans index exists"
   
   # Seams guide
   test -f docs/seams-reference.md && echo "✓ seams guide exists"
   ```

### Code Review Expectations

Reviewers will check:

1. **Tests exist and pass**
2. **Code follows style conventions**
3. **Architecture decisions are documented**:
   - If code touches a seam, seams guide is updated
   - If code implements an ADR, the ADR is linked
   - If code changes storage, migrations are committed
4. **No orphaned decisions**:
   - No TODOs referencing architectural choices
   - No major decisions in commit messages only
5. **Links aren't broken**:
   - README → docs/ references are valid
   - Seams guide → test file references are valid

### Quarterly Verification Audits

Every 3 months (Jan, Apr, Jul, Oct), the architecture owner runs a full audit:

1. **When**: First week of month, ~2 hours
2. **What**: Complete `docs/VERIFICATION-CHECKLIST.md` (checks 1–10)
3. **Output**: Audit report filed in `docs/audits/YYYY-MM-DD.md`
4. **Follow-up**: Create issues for any gaps found

**To run an audit**:

```bash
# Pull latest
git checkout main && git pull origin main

# Run checklist (manual or automated)
# See docs/VERIFICATION-CHECKLIST.md for full checklist

# File results
mkdir -p docs/audits
cat > docs/audits/$(date +%Y-%m-%d).md << 'EOF'
# Documentation Audit — $(date +%Y-%m-%d)

**Auditor:** [Your name]
**Results:**
- [ ] README & Navigation: ✅ Pass
- [ ] Plans Directory: ✅ Pass
- [ ] ADRs & Memory: ✅ Pass
- [ ] Seams Guide: ✅ Pass
- [ ] Code/Doc Alignment: ✅ Pass
- [ ] Orphaned Decisions: ✅ Pass
- [ ] Glossary: ✅ Pass
- [ ] Ideas Tracking: ✅ Pass
- [ ] Links: ✅ Pass

**Issues:** None

**Next Audit:** [3 months from today]
EOF

# Commit
git add docs/audits/
git commit -m "docs(audit): $(date +%Y-%m-%d) quarterly verification"
git push origin main
```

### Automated Verification (Optional)

If CI/CD is configured (see `docs/VERIFICATION-CHECKLIST.md` section 11):

- **On every PR**: Links in README/docs are checked
- **On every merge to main**: Full link verification
- **Monthly**: Full checklist run (if automated)

Current CI/CD: `.github/workflows/ci.yml`
- Runs `bun test`
- Checks TypeScript compilation

To add doc verification, update `.github/workflows/` (see section 11 of checklist).

---

## Code Review Expectations

### What Reviewers Look For

When you open a PR, expect reviewers to ask about:

1. **Does this change an invariant or seam?**
   - If yes: Is the seams guide updated?
   - If no: Can you prove it by citing a seam definition?

2. **Is there a test for this?**
   - Test files live alongside source in `.test.ts` files
   - Expect >80% code coverage
   - New features should add tests

3. **Does this implement an ADR?**
   - If yes: Is the ADR linked in commit message or PR?
   - If the ADR is new: Is it approved first?

4. **Does this introduce a new decision?**
   - If yes: Should this be an ADR instead of a code comment?

5. **Is documentation up to date?**
   - Code changes architecture? Update ARCHITECTURE.md
   - Code changes extension points? Update EXTENDING.md
   - Code adds a seam or changes one? Update seams-reference.md

### Merging to Main

A PR merges when:

1. ✅ All tests pass
2. ✅ At least one approved code review
3. ✅ Documentation is current (reviewer verified)
4. ✅ No unresolved conversations
5. ✅ Branch is up to date with main

---

## Testing & Test Organization

### Test Structure

Tests live alongside source code in `.test.ts` files:

```
packages/kernel/src/
├── storage.ts          (production code)
├── storage.test.ts     (tests)
├── execution.ts
├── execution.test.ts
└── ...
```

### Running Tests

```bash
# All tests
bun test

# Watch mode (re-run on file change)
bun test --watch

# Single test file
bun test packages/kernel/src/storage.test.ts

# Tests matching a pattern
bun test --test-name-pattern="Event Log"

# Coverage report
bun test --coverage
```

### Writing Tests

Tests use Bun's built-in test runner (compatible with Node's `test` module):

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Storage } from './storage';

describe('Storage: Event Log', () => {
  let storage: Storage;
  
  beforeEach(async () => {
    storage = new Storage(); // or use test fixture
  });
  
  afterEach(async () => {
    // cleanup
  });
  
  it('should append events idempotently', async () => {
    const event = { kind: 'task_created', taskId: 'xyz' };
    
    const result1 = await storage.append(event);
    const result2 = await storage.append(event); // idempotent key
    
    expect(result1).toEqual(result2);
  });
});
```

### Test Coverage Expectations

- **New code**: Expect >80% coverage in PR
- **Seam code**: 100% coverage required (invariants are tested)
- **Exception paths**: Coverage for error cases required
- **Refactoring**: Coverage should improve or stay same (not decrease)

### Linking Tests to Documentation

When writing tests:

1. **Reference the seam** in test comments:
   ```typescript
   // Tests Event Log Seam invariant: idempotency
   it('idempotent append with same input', async () => { ... });
   ```

2. **Document what's being tested**:
   ```typescript
   // Given: Project isolation active
   // When: Two projects write events with same ID
   // Then: Each gets a unique sequence, no conflict
   it('enforces project isolation', async () => { ... });
   ```

3. **Update seams-reference.md** to link test file:
   ```markdown
   **Test references:** `packages/kernel/src/storage.test.ts` line 234 (project isolation)
   ```

---

## Architecture Decisions (ADRs)

### When to Write an ADR

Write an ADR when you're making a decision that:

- Affects multiple parts of the system
- Locks in an approach for >1 release
- Involves a tradeoff (performance vs. correctness, simplicity vs. power)
- Changes a stored invariant
- Changes how developers extend the system

**Don't** write an ADR for:
- Bug fixes
- Refactoring that doesn't change behavior
- Performance optimizations that don't change invariants
- Documentation updates

### ADR Template

```markdown
# ADR-XXXX: [Title]

**Status**: Proposed | Accepted | Superseded

**Date**: YYYY-MM-DD

**Decision Makers**: [Names]

## Context

[Why did we need to decide?]

## Decision

[What did we decide?]

## Consequences

[What changes as a result?]

- **Benefits**: [What's better?]
- **Drawbacks**: [What's worse?]
- **Affected Components**: [What needs to change?]

## Alternatives Considered

1. **[Alternative A]**
   - Pros: [Why this could work]
   - Cons: [Why we rejected it]

2. **[Alternative B]**
   - Pros: [Why this could work]
   - Cons: [Why we rejected it]

## References

- [Related ADR or spec]
- [Implementation PR: #123]
- [Memory note: adr-xxxx-title]
```

### Publishing an ADR

1. **Draft**: Write in `.md` or memory note
2. **Review**: Share with architecture owner
3. **Approve**: Decision makers agree
4. **Publish**: File in docs (or memory, or both)
5. **Implement**: Code follows the ADR
6. **Update**: If situation changes, mark as Superseded

### ADRs in Memory

ADRs are also stored as memory notes for searchability:

```bash
orc memory write \
  --id adr-0006-surrealdb-knowledge-graph \
  --title "ADR-0006: SurrealDB for Knowledge Graph" \
  --kind decision \
  --categories architecture,memory,tooling \
  --tags adr,database,knowledge-graph \
  --body "[Full ADR text here]"
```

Then link from other notes:

```bash
orc memory write \
  --id architecture-current \
  --link adr-0006-surrealdb-knowledge-graph:depends_on \
  # ... updates architecture note with a link to the ADR
```

---

## Commit Message Conventions

Follow the format below for clarity and consistency:

```
<type>(<scope>): <subject>

<body>

<footer>
```

### Types

- `feat`: A new feature
- `fix`: A bug fix
- `docs`: Documentation only
- `refactor`: Code change that isn't a feature or bugfix
- `test`: Adding or updating tests
- `chore`: Changes to build, dependencies, tooling
- `perf`: Performance improvement

### Scopes

Component or module affected:

- `storage`: Event log, journal, migrations
- `execution`: Workflow, steps, operations, checkpoints
- `memory`: Knowledge graph, SurrealDB, notes
- `plugins`: Plugin system, executors, models, tools
- `vault`: Projections, markdown rendering
- `cli`: Command-line interface
- `ui`: Web UI (if applicable)
- `arch`: Architecture/ADRs
- `docs`: Documentation files
- `config`: Configuration schema
- `test`: Test infrastructure

### Examples

```
feat(storage): add artifact receipt verification

Adds artifact_produced event that verifies each declared output:
- Read file from workspace and compute SHA-256
- Verify against declared outputs
- Commit atomically with step_completed

Fixes #456
```

```
docs(arch): update ADR-0002 for event retention policy

Changed retention from 7 days to 90 days after analysis showed
performance impact of frequent log rotations. Updated seams guide
with new query patterns for auditing.

Relates to #789
```

```
refactor(memory): extract citation validation to separate module

No behavior change; improves testability and reduces complexity
of the note-write path.
```

---

## Troubleshooting

### Common Issues

#### Tests fail locally but pass in CI

**Diagnosis**: Database state or timing issue

**Fix**:
```bash
# Reset databases
docker compose down -v && docker compose up -d --wait
bun run packages/cli/src/bin.ts db migrate

# Run tests again
bun test
```

#### Documentation links are broken

**Diagnosis**: File was moved or deleted

**Fix**:
```bash
# Find what links to it
grep -r "old-file-name.md" docs/ README.md

# Update links to new location
sed -i 's|docs/old-file|docs/new-file|g' README.md docs/*.md

# Verify
grep "new-file" docs/*.md README.md | head -5
```

#### Cannot trust an MCP server

**Diagnosis**: Trust grant is invalid or missing

**Fix**:
```bash
# List trusted servers
cat .orc/trust.json

# Re-trust the server (will prompt for consent)
orc mcp trust <server-id>

# Verify
cat .orc/trust.json | jq '.mcpServers.<server-id>'
```

#### Cannot run Postgres or SurrealDB

**Diagnosis**: Docker issue

**Fix**:
```bash
# Check running containers
docker ps

# Restart databases
docker compose down
docker compose up -d --wait

# Check logs
docker compose logs postgres
docker compose logs surrealdb

# Verify connectivity
psql $ORC_DATABASE_URL -c "SELECT 1"
curl http://localhost:8000/health
```

### Getting Help

1. **Check existing issues**: https://github.com/[org]/orchestrator/issues
2. **Search memory notes**: `orc memory ls --query "your question"`
3. **Read seams guide**: `docs/seams-reference.md` (troubleshooting section)
4. **Ask on Slack/Discord**: Link to this guide + reproduction steps
5. **File an issue**: Include:
   - `bun --version`
   - `orc status`
   - Error message (full output)
   - Steps to reproduce

---

## Summary

| Activity | Owner | Frequency | Documentation |
|---|---|---|---|
| Write code | Developer | Per PR | Code review checks |
| Write tests | Developer | Per PR | seams-reference.md |
| Create ADR | Architect | Per decision | docs/, memory |
| Add plan | PM | Per epic | docs/plans/INDEX.md |
| Update seams | Developer | Per seam change | docs/seams-reference.md |
| Code review | Maintainer | Per PR | PR comments |
| Quarterly audit | Architect | Q1/Q2/Q3/Q4 | docs/audits/ |

---

**Last Updated**: 2026-07-21
**Maintained By**: Architecture Team
**See Also**: `docs/VERIFICATION-CHECKLIST.md` (complete verification guide)
