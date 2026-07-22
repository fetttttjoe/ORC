# Migration Guides

This directory contains step-by-step guides for implementing major architectural changes and approved design decisions.

## Organization

Guides are organized by milestone and architectural area:

### M2 Execution Foundation (Core Infrastructure & APIs)

Essential infrastructure and core API changes needed to bring execution into the system.

- **[001-m2-postgres-consolidation.md](001-m2-postgres-consolidation.md)** — Database consolidation (SQLite → Postgres)
  - *Impact: Database schema, all storage layers, CLI infrastructure*
  - *Required before: Any M2 execution work*
  - *Rollback: Restore from backup; requires reverse migration*

- **[002-m2-execution-port-api.md](002-m2-execution-port-api.md)** — ExecutionPort API and DBOS integration
  - *Impact: Executor implementations, durable execution, checkpoint behavior*
  - *Required before: Implementing executors, approval gates*
  - *Rollback: Use previous ExecutionPort interface; manual event append*

- **[003-m2-plan-execution-model.md](003-m2-plan-execution-model.md)** — Plan execution model and DAG interpreter
  - *Impact: Task/step lifecycle, plan versioning, approval workflow*
  - *Required before: Running approved plans*
  - *Rollback: Use manual plan interpretation*

- **[004-m2-provider-registration.md](004-m2-provider-registration.md)** — Provider plugin registration and lifecycle
  - *Impact: Model provider setup, provider marketplace, custom providers*
  - *Required before: Adding new model providers*
  - *Rollback: Revert to hardcoded provider imports*

- **[005-m2-tool-implementation.md](005-m2-tool-implementation.md)** — Tool API and custom tool implementation
  - *Impact: Agent-facing tool definitions, tool execution, tool errors*
  - *Required before: Building custom tools*
  - *Rollback: Use previous tool schema*

- **[006-m2-deployment-infrastructure.md](006-m2-deployment-infrastructure.md)** — Deployment setup (docker-compose, unbundled DBOS, Postgres)
  - *Impact: Development environment, production infrastructure, setup automation*
  - *Required before: Any development with M2+*
  - *Rollback: Tear down compose stack, restore SQLite setup*

### M3 Plugins (Plugin Ecosystem & Trust)

Plugin system implementation: skills, MCP, extensions, and the trust model.

- **[007-m3-plugin-host-integration.md](007-m3-plugin-host-integration.md)** — Plugin host architecture and initialization
  - *Impact: Plugin loading, skill index, MCP client, extension loader*
  - *Required before: Building any plugins*
  - *Rollback: Bypass plugin host; hardcode plugins*

- **[008-m3-trust-store-setup.md](008-m3-trust-store-setup.md)** — Trust store implementation (.orc/trust.json)
  - *Impact: Security model, MCP server grants, extension activation*
  - *Required before: Sharing .orc/config.json; running shared plans*
  - *Rollback: Commit trust.json (security risk); use global permissions*

- **[009-m3-plan-schema-toolrefs.md](009-m3-plan-schema-toolrefs.md)** — Plan schema updates (PlanStep.toolRefs)
  - *Impact: Plan format, tool surface freezing, plan versioning*
  - *Required before: Using MCP tools in steps*
  - *Rollback: Remove toolRefs; resolve tools at runtime*

- **[010-m3-extension-manifest.md](010-m3-extension-manifest.md)** — Extension manifest format and lifecycle
  - *Impact: Extension authoring, registration API, activation lifecycle*
  - *Required before: Building custom extensions*
  - *Rollback: Use data-driven manifest; change activate/deactivate calls*

- **[011-m3-hook-system.md](011-m3-hook-system.md)** — Hook bus API and event observation
  - *Impact: Extension integration points, event handling, monitoring*
  - *Required before: Building event-aware extensions*
  - *Rollback: Remove hook subscriptions; poll event log*

- **[012-m3-mcp-server-integration.md](012-m3-mcp-server-integration.md)** — MCP server lifecycle and tool resolution
  - *Impact: Tool availability, server lifecycle, error handling*
  - *Required before: Using MCP servers*
  - *Rollback: Use static tool registry; no lazy spawn*

- **[013-m3-skill-layout.md](013-m3-skill-layout.md)** — Skill file layout and hot indexing
  - *Impact: Skill location, indexing, force-load behavior*
  - *Required before: Using skills in steps*
  - *Rollback: Move skills; disable watching*

### ADR-Specific Guides

Architecture decisions that span milestones or have their own upgrade paths.

- **[014-adr-008-signal-contract.md](014-adr-008-signal-contract.md)** — Signal API and per-run token validation (ADR-008)
  - *Impact: Step completion, executor implementations*
  - *Required before: Implementing custom executors*
  - *Rollback: Use string-based signals; remove token validation*

- **[015-adr-009-approval-policy.md](015-adr-009-approval-policy.md)** — Approval policy rules and gates (ADR-009)
  - *Impact: Plan approval, gate automation, risk management*
  - *Required before: Auto-approving any plans*
  - *Rollback: Remove policy rules; gate everything manually*

## How to Use These Guides

1. **Determine your current version:** Check `package.json` version or git tags.
2. **Identify the target milestone:** Consult the roadmap.
3. **Read guides in order:** Each guide lists its dependencies. Follow the dependency chain.
4. **Follow step-by-step procedures:** Each guide provides a concrete upgrade path.
5. **Test with the provided validation steps:** Every guide includes success criteria and testing.
6. **Keep rollback procedures nearby:** Store them in your change management process.

## Common Patterns Across Guides

### Structure of Each Guide

- **Summary:** What changes, why, and what breaks
- **Impact:** Systems affected, customers/deployments impacted
- **Timeline:** Deprecation period (if applicable), sunset date
- **Migration path:** Step-by-step procedure with examples
  - Before/after code samples
  - Configuration changes
  - Database/schema changes
  - Testing validation
- **Rollback procedure:** How to undo and recover
- **Known issues:** Caveats, gotchas, timing constraints
- **Verification checklist:** Green-light criteria

### Before You Start

- [ ] Back up your project database (especially pre-M2)
- [ ] Back up vault/ and .orc/ directories
- [ ] Test migration in a disposable environment first
- [ ] Identify any custom code that depends on changed APIs
- [ ] Review related memory notes and architectural decisions
- [ ] Prepare a rollback plan with timings

### After Migration

- [ ] Run test suite end-to-end
- [ ] Validate event log consistency (if applicable)
- [ ] Verify vault projection reflects new format
- [ ] Test with at least one full run/plan cycle
- [ ] Document any environment-specific overrides
- [ ] Commit changes and tag the new version

## Cross-Cutting Concerns

### Database Schema Changes

Migrations use Drizzle ORM (`drizzle-kit`). To apply:

```bash
# After checking out the new version
orc db migrate

# Verify migration applied
orc db status
```

If something goes wrong:

```bash
# Rollback (creates a new migration file reversing the last)
orc db rollback
```

### API Changes

Contracts live in `packages/contracts/src/`. If you have custom code depending on these, updates are **required**. The contracts package uses Zod for schema validation — type mismatches will be caught at runtime.

### Configuration Changes

`.orc/config.json` is backward-compatible (new fields are optional). `.orc/trust.json` (M3+) is required for MCP/extension grants and **must not be committed** — add to `.gitignore`.

### Deployment Infrastructure

M2+ requires a `docker-compose.yml`-managed Postgres. The provided stack is single-machine only. For small-team/server mode (later), the Postgres URL can point to a remote server — no code changes needed.

## Relationships Between Guides

```
001 (Postgres)
  ↓ prerequisite
002 (ExecutionPort) → 003 (Plan Execution)
  ↓
004 (Providers) ← 005 (Tools)
  ↓ prerequisite
006 (Infrastructure)

006 (Infrastructure)
  ↓ prerequisite
007 (Plugin Host) → 011 (Hooks)
  ↓
008 (Trust) → 009 (Plan Schema) → 010 (Manifest)
  ↓
012 (MCP) ← 013 (Skills)

014 (Signals) — independent, needed for custom executors
015 (Approval Policy) — independent, orthogonal to execution
```

## Related Documentation

- [Architecture Overview](../ARCHITECTURE.md) — System design, module dependencies, data flows
- [Glossary](../GLOSSARY.md) — Domain terminology, acronyms, key concepts
- [Seams Reference Guide](../seams/) — Critical architectural boundaries, failure modes, troubleshooting
- [Design Specifications](../superpowers/specs/) — Full design specs for each milestone
- [Plans Directory](../plans/INDEX.md) — Implementation plans and approval status

## Support

If a guide is unclear or you encounter an issue not covered:

1. Search the project knowledge graph (memory notes) for related decisions
2. Review the design spec for the relevant milestone
3. Check the [review findings](../../review-findings.md) for known issues
4. Open an issue with the guide version and your error

---

*Last updated: Phase 3.2 (2026-07-17)*
