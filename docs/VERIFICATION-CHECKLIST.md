# Documentation Verification Checklist

This checklist ensures documentation stays current, accurate, and discoverable throughout the development lifecycle. Use it during:

- **PR/Code Review**: Before merging any code change
- **ADR Creation**: Before publishing a new architectural decision
- **Plan Approval**: Before finalizing any new plan or major process change
- **Release**: Before each release candidate
- **Quarterly Audit**: Every 3 months as part of the architecture review

---

## 1. README & Navigation Integrity

Use these checks to verify the documentation hub remains a reliable entry point.

- [ ] **README.md exists and is readable**
  - Command: `test -f README.md && wc -l README.md`
  - Expected: File exists and has content (>100 lines)
  - Failure mode: Unreadable entry point; all downstream navigation fails

- [ ] **Architecture & Documentation section is present**
  - Command: `grep -A 20 "Architecture & Documentation" README.md | head -5`
  - Expected: Section header visible and followed by Quick Navigation table
  - Failure mode: New contributors cannot find architecture docs

- [ ] **All Quick Navigation links exist and are accessible**
  - Links to check:
    - `docs/ARCHITECTURE.md` (architecture overview)
    - `docs/EXTENDING.md` (extension points)
    - `docs/plans/INDEX.md` (decisions & roadmap)
    - `docs/seams-reference.md` (seams reference)
    - `docs/GLOSSARY.md` (glossary)
    - `docs/IDEAS.md` (ideas & backlog)
  - Command: `for f in docs/ARCHITECTURE.md docs/EXTENDING.md docs/plans/INDEX.md docs/seams-reference.md docs/GLOSSARY.md docs/IDEAS.md; do test -f "$f" && echo "✓ $f" || echo "✗ $f"; done`
  - Expected: All files exist
  - Failure mode: Broken links in README; navigation fails

- [ ] **README links are not broken (internal consistency)**
  - Command: `grep -o '\[.*\](.*\.md)' README.md | grep -v 'http' | sort | uniq`
  - Expected: All referenced .md files exist in the repo
  - Failure mode: Users follow a link from README and get 404

- [ ] **See Also section includes documentation plan link**
  - Command: `grep -A 5 "See Also" README.md | grep -E "plans|documentation"`
  - Expected: References to plans/INDEX.md or documentation roadmap
  - Failure mode: Documentation process is invisible to contributors

---

## 2. Plans Directory & Approval Status

Use these checks to keep the plans catalog current and approval status clear.

- [ ] **docs/plans/INDEX.md exists and is current**
  - Command: `test -f docs/plans/INDEX.md && wc -l docs/plans/INDEX.md`
  - Expected: File exists (>100 lines)
  - Failure mode: Plans are orphaned; approval status unknown

- [ ] **All plan files are indexed**
  - Command: `ls -1 docs/plans/*.md | wc -l && grep -c "^##\|^\-.*\|Status:" docs/plans/INDEX.md`
  - Expected: Index mentions all plan files; status legend is present
  - Failure mode: Plans exist but are not discoverable

- [ ] **Approval status is clearly marked**
  - Checks per plan entry:
    - ✅ for approved and shipped
    - 📋 for pending approval or in-progress
    - 🔄 for deferred/revisit
  - Command: `grep -E "✅|📋|🔄" docs/plans/INDEX.md | wc -l`
  - Expected: Every plan has a status indicator
  - Failure mode: Unclear which decisions are final vs tentative

- [ ] **Plan dependencies are documented**
  - Command: `grep -i "depends on\|blocked by\|requires" docs/plans/INDEX.md | head -3`
  - Expected: Cross-references and dependency notes present
  - Failure mode: Hidden blockers; surprises during execution

- [ ] **Phase 2 status is accurate**
  - Checks:
    - Phase 2.1: README Enhancement — ✅ Complete
    - Phase 2.2: Plans Index — ✅ Complete
    - Phase 2.3: ADR Formalization — ✅ Complete
    - Phase 2.4: Seams Guide — ✅ Complete
  - Command: `grep -A 5 "Phase 2" docs/plans/INDEX.md | grep -E "✅|📋"`
  - Expected: All Phase 2 items marked ✅ Complete
  - Failure mode: Incorrect project status in communication

---

## 3. ADR & Memory Graph Alignment

Use these checks to ensure all architectural decisions are captured and linked.

- [ ] **All 8 ADRs are documented in spec**
  - Expected ADRs:
    1. Project identity & multi-tenancy (ADR-0001)
    2. Event sourcing & audit trail (ADR-0002)
    3. Operation journal & durability (ADR-0003)
    4. At-least-once execution (ADR-0004)
    5. DBOS Transact for workflows (ADR-0005)
    6. SurrealDB for knowledge graph (ADR-0006)
    7. Zero-trust plugins (ADR-0007)
    8. Degraded memory tolerance (ADR-0008)
  - Command: `grep -r "ADR\|Architectural Decision" docs/superpowers/specs/ | wc -l`
  - Expected: All 8 mentioned
  - Failure mode: Decisions lost to tribal knowledge

- [ ] **Each ADR has a corresponding memory note**
  - Command: `orc memory ls --tag architecture | grep -i "adr\|decision" | wc -l`
  - Expected: ≥8 notes found
  - Failure mode: Decisions not discoverable via `memory_search`

- [ ] **Memory notes are linked to code paths**
  - Spot check (sample 3 ADRs):
    - Command: `orc memory read adr-0001-project-identity --format=json | jq '.paths | length'`
    - Expected: >0 (at least one code path per ADR)
    - Failure mode: Decisions disconnected from implementation

- [ ] **No orphaned decision files in docs/**
  - Command: `find docs/ -name "*.md" -type f | xargs grep -l "decision\|ADR" | grep -v plans | grep -v ARCHITECTURE | sort`
  - Expected: Output should be empty (all decisions tracked in memory or spec)
  - Failure mode: Decisions buried in random files

---

## 4. Seams Reference Guide & Test Coverage

Use these checks to ensure the seams guide is complete and linked to tests.

- [ ] **Seams reference guide exists**
  - Command: `test -f docs/seams-reference.md && grep -c "^##" docs/seams-reference.md`
  - Expected: File exists and has multiple sections (>10 headings)
  - Failure mode: Architectural boundaries are undocumented

- [ ] **All 5 critical seams are documented**
  - Expected seams:
    1. Event Log (append-only, project isolation, idempotency)
    2. Operation Journal (before-the-effect, deterministic IDs, recovery)
    3. Execution Flow (checkpoint reuse, step ordering, signal routing)
    4. Memory/Knowledge (event-first, citations, degraded mode)
    5. Feedback & Approval (idempotent outbox, hash-bound approval)
  - Command: `grep -E "^## .*[Ss]eam|^### " docs/seams-reference.md | head -15`
  - Expected: All 5 seams listed with subsections
  - Failure mode: Undocumented boundaries → inconsistent extensions

- [ ] **Each seam documents invariants and error handling**
  - Sample check (Event Log seam):
    - Command: `grep -A 50 "^## Event Log" docs/seams-reference.md | grep -E "Invariant|Error|Recovery" | head -3`
    - Expected: At least 3 invariants and 2 error scenarios per seam
    - Failure mode: Developers don't know what can/cannot be violated

- [ ] **Seams reference links to test files**
  - Command: `grep -c "test.ts\|\.test\|testing\|spec" docs/seams-reference.md`
  - Expected: >10 test references
  - Failure mode: Seams documented but test coverage is unclear

- [ ] **README links to seams guide**
  - Command: `grep "seams-reference" README.md`
  - Expected: Link is present
  - Failure mode: New contributors never find the seams guide

- [ ] **docs/seams/ directory is organized**
  - Command: `ls -la docs/seams/`
  - Expected: At least seams/README.md and seams/reference.md present
  - Failure mode: Seams documentation scattered

---

## 5. Architecture Notes Match Code

Use these checks to keep architecture documentation synchronized with implementation.

- [ ] **Architecture overview document (ARCHITECTURE.md) is current**
  - Command: `test -f docs/ARCHITECTURE.md && grep -c "^##\|^###" docs/ARCHITECTURE.md`
  - Expected: Document exists with multiple sections
  - Failure mode: Architects' mental model is outdated

- [ ] **Key code paths are documented**
  - Spot check for:
    - Event ingestion path (request → validation → storage → event)
    - Execution path (plan → step → operation → checkpoint → DBOS)
    - Memory path (event → SurrealDB write → vault rebuild)
  - Command: `grep -r "event_produced\|execution_started\|memory_written" docs/*.md | wc -l`
  - Expected: >5 references across documentation
  - Failure mode: Code flow is undocumented

- [ ] **No major code changes without doc updates**
  - Code paths to monitor:
    - `packages/kernel/src/` (execution & storage)
    - `packages/plugins/` (plugin system)
    - `packages/memory/` (knowledge graph)
    - `packages/vault/` (projections)
  - Trigger: If any file in these paths changed, verify corresponding doc update
  - Failure mode: Code drifts from documentation

- [ ] **EXTENDING.md documents current extension points**
  - Command: `grep -E "^## |^### " docs/EXTENDING.md | head -10`
  - Expected: All extension points listed (executors, models, plugins, events, tools, skills)
  - Failure mode: New developers don't know how to extend

---

## 6. Decisions Without ADRs

Use these checks to prevent decisions from slipping into code without proper capture.

- [ ] **No TODO/FIXME comments referencing architectural decisions**
  - Command: `grep -r "TODO.*decide\|FIXME.*arch\|TODO.*design" packages/ --include="*.ts" --include="*.js" | wc -l`
  - Expected: 0 matches (decisions should be explicit ADRs, not comments)
  - Failure mode: Decisions made implicitly; hard to audit

- [ ] **No decisions in commit messages only**
  - Spot check recent commits:
    - Command: `git log --oneline -20 | head -5`
    - Expected: Commit messages reference plans/ADRs or are implementation details
    - Failure mode: Decisions lost to git history

- [ ] **All major config changes are documented**
  - Places to check:
    - `.orc/config.json` (keys, schema)
    - Environment variables (ORC_*, DBOS_*)
    - Database migrations (schema changes in `packages/kernel/drizzle/`)
  - Expected: Config options documented in CONTRIBUTING.md or README
  - Failure mode: Operators don't know about knobs

---

## 7. Glossary & Terms Consistency

Use these checks to keep terminology consistent across docs.

- [ ] **GLOSSARY.md is comprehensive and current**
  - Command: `test -f docs/GLOSSARY.md && grep -c "^##\|^- \*\*" docs/GLOSSARY.md`
  - Expected: File exists with 80+ terms
  - Failure mode: Undefined jargon in documentation

- [ ] **Key architectural terms are defined in glossary**
  - Terms to check:
    - Event, Fold, Seam, Plugin, MCP, Approval, Artifact, Memory note, Research note, Project, Task, Plan, Split, Kernel, DBOS, Redaction
  - Command: `for term in Event Fold Seam Plugin MCP Approval Artifact; do grep -q "^- \*\*$term\*\*" docs/GLOSSARY.md && echo "✓ $term" || echo "✗ $term"; done`
  - Expected: All key terms defined
  - Failure mode: Inconsistent terminology

- [ ] **Glossary links to relevant docs**
  - Command: `grep -c "^\[" docs/GLOSSARY.md` (count markdown links in glossary)
  - Expected: >20 cross-references
  - Failure mode: Definitions are isolated; no navigation

---

## 8. Documentation Debt & Ideas

Use these checks to track deferred work and emerging ideas.

- [ ] **ideas.md exists and is indexed in memory**
  - Command: `test -f docs/IDEAS.md && orc memory ls --query ideas`
  - Expected: File exists and has corresponding memory index
  - Failure mode: Ideas are forgotten instead of tracked

- [ ] **All ideas have trigger conditions**
  - Command: `grep -E "^- \*\*|^  - Trigger:" docs/IDEAS.md | head -10`
  - Expected: Every idea has one or more conditions for when to ship
  - Failure mode: Backlog grows without focus

- [ ] **Phase 3 plans are documented and linked**
  - Expected Phase 3 items:
    - Phase 3.1: Glossary extraction
    - Phase 3.2: Migration guides
    - Phase 3.3: Verification cadence (this step)
  - Command: `grep "Phase 3" docs/plans/INDEX.md | wc -l`
  - Expected: ≥3 Phase 3 entries
  - Failure mode: Future work is unclear

---

## 9. Links & Cross-References

Use these checks to ensure documentation is navigable.

- [ ] **No broken links in main docs**
  - Documentation files to check:
    - README.md
    - docs/ARCHITECTURE.md
    - docs/EXTENDING.md
    - docs/seams-reference.md
    - docs/GLOSSARY.md
  - Command: `grep -h -o '\[.*\](.*\.md)' README.md docs/ARCHITECTURE.md docs/EXTENDING.md docs/seams-reference.md docs/GLOSSARY.md | cut -d'(' -f2 | cut -d')' -f1 | sort | uniq > /tmp/links.txt && while read link; do test -f "$link" || echo "✗ broken: $link"; done < /tmp/links.txt`
  - Expected: All files found
  - Failure mode: Documentation navigation is broken

- [ ] **Cross-references are reciprocal**
  - Spot check:
    - ARCHITECTURE.md links to EXTENDING.md
    - EXTENDING.md links back to ARCHITECTURE.md
    - seams-reference.md links to both
  - Command: `grep "EXTENDING" docs/ARCHITECTURE.md && grep "ARCHITECTURE" docs/EXTENDING.md && echo "✓ reciprocal"`
  - Expected: Bidirectional references exist
  - Failure mode: Navigators get stuck in dead ends

---

## 10. Quarterly Full Audit Checklist

Run this complete checklist every 3 months (or after major releases).

### Timeline Setup
- [ ] Schedule 2-hour audit window
- [ ] Assign auditor (architecture owner or senior engineer)
- [ ] Clear calendar (no interruptions during audit)

### Pre-Audit
- [ ] Pull latest `main` branch
- [ ] Run `orc status` to verify cluster health
- [ ] Ensure test suite passes (`bun test`)

### During Audit
- [ ] Review all README sections (completion: checks 1.1–1.5 above)
- [ ] Verify plans status (completion: checks 2.1–2.5 above)
- [ ] Audit ADRs & memory notes (completion: checks 3.1–3.4 above)
- [ ] Validate seams guide (completion: checks 4.1–4.6 above)
- [ ] Check code/doc alignment (completion: checks 5.1–5.3 above)
- [ ] Scan for orphaned decisions (completion: check 6.1–6.3 above)
- [ ] Verify glossary (completion: check 7.1–7.2 above)
- [ ] Review deferred ideas (completion: check 8.1–8.3 above)
- [ ] Test links (completion: check 9.1–9.2 above)
- [ ] Record findings in audit report (see below)

### Audit Report Template

```markdown
# Documentation Audit — [YYYY-MM-DD]

**Auditor:** [Name]
**Duration:** [X hours]
**Cluster Health:** [✅ Healthy / ⚠️ Degraded]

## Checklist Results

### README & Navigation
- [ ] All sections present
- [ ] Links working
- [ ] Quick Navigation complete
- **Issues found:** [list any]

### Plans Directory
- [ ] INDEX.md current
- [ ] All plans indexed
- [ ] Approval status clear
- **Issues found:** [list any]

### ADRs & Memory
- [ ] All 8 ADRs documented
- [ ] Memory notes linked
- [ ] Paths tracked
- **Issues found:** [list any]

### Seams Guide
- [ ] 5 seams documented
- [ ] Invariants & errors recorded
- [ ] Tests linked
- **Issues found:** [list any]

### Code/Doc Alignment
- [ ] ARCHITECTURE.md current
- [ ] Key paths documented
- [ ] EXTENDING.md accurate
- **Issues found:** [list any]

## Follow-up Actions

- [ ] [Specific fix needed]
- [ ] [Doc update required]
- [ ] [Code cleanup task]

## Next Audit Scheduled

**Date:** [3 months from now]
**Auditor:** [Assign]

---
**Report filed:** [Commit hash or task ID]
```

---

## Process Integration: When to Use This Checklist

### Per-PR (Code Review)
1. If code changes touch architectural boundaries or storage format:
   - Run checks **5.1–5.3** (code/doc alignment)
   - Run checks **6.1–6.3** (new decisions without ADRs)
   - Update docs before merge

2. If you're adding a new test:
   - Verify check **4.4** (seams linked to tests) still passes
   - Update test references in seams guide if needed

### Per-ADR (Decision Approval)
1. Before publishing an ADR:
   - Create corresponding memory note (check **3.2**)
   - Update seams guide if it affects architectural boundaries (check **4.2**)
   - Link code paths (check **3.3**)

2. After ADR approval:
   - Update plans/INDEX.md (check **2.3**, **2.4**)
   - Add to GLOSSARY.md if introducing new terms (check **7.1**)

### Per-Plan (Plan Approval)
1. Before approving a plan:
   - Add to plans/INDEX.md with status (check **2.3**)
   - Document dependencies (check **2.4**)
   - If plan changes architecture, create/update ADR first (check **3.1**)

### Per-Release (Release Candidate)
1. Before declaring RC:
   - Run full checklist (checks 1–10 above)
   - Fix any broken links (check **9.1**)
   - Record in vault/releases/

### Quarterly (Full Audit)
1. Third week of Jan, Apr, Jul, Oct:
   - Run **Quarterly Full Audit Checklist** (check 10 above)
   - File audit report in docs/audits/
   - Schedule next auditor

---

## Failure Modes & Recovery

| Failure Mode | Root Cause | Recovery |
|---|---|---|
| Broken links in README | File moved or deleted | Audit checks 1.3–1.4; fix paths |
| Plans orphaned | INDEX.md not updated | Audit checks 2.1–2.2; re-index |
| ADR written but not in memory | Memory graph not updated | Audit checks 3.2; formalize as note |
| Seams undocumented | Seams guide not updated | Audit check 4.2; document invariants |
| Code drifted from docs | No verification after merge | Audit check 5.3; code review requirement |
| Decision made as inline comment | No ADR process followed | Audit check 6.1; retroactive ADR |
| Glossary undefined | Terms accumulate | Audit check 7.1; quarterly pass |
| Ideas forgotten | Not tracked in memory | Audit check 8.1; formalize in IDEAS.md |
| Documentation site broken | CI/CD hook missing | See section 11 below |

---

## 11. CI/CD Verification (Optional Automation)

If implementing automated verification:

### GitHub Actions Workflow Example

```yaml
# .github/workflows/doc-verify.yml
name: Documentation Verification

on:
  pull_request:
    paths:
      - 'docs/**'
      - 'README.md'
      - 'CONTRIBUTING.md'
      - 'packages/*/src/**'
  schedule:
    - cron: '0 9 1 * *'  # Monthly, first of month at 9 AM UTC

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - name: Check README links
        run: |
          for f in docs/ARCHITECTURE.md docs/EXTENDING.md docs/plans/INDEX.md \
                   docs/seams-reference.md docs/GLOSSARY.md docs/IDEAS.md; do
            test -f "$f" || (echo "✗ $f missing" && exit 1)
          done
          echo "✓ All README links valid"
      
      - name: Check plans/INDEX.md exists
        run: test -f docs/plans/INDEX.md || (echo "✗ plans/INDEX.md missing" && exit 1)
      
      - name: Check seams/reference.md exists
        run: test -f docs/seams-reference.md || (echo "✗ seams/reference.md missing" && exit 1)
      
      - name: Check for broken markdown links (optional)
        uses: gaurav-nelson/github-action-markdown-link-check@v1
        with:
          use-quiet-mode: 'yes'
          folder-path: 'docs/'
          file-path: 'README.md'
```

### Pre-Commit Hook Example

```bash
#!/bin/bash
# .git/hooks/pre-commit

echo "Running documentation verification..."

# Check critical files exist
for f in README.md docs/ARCHITECTURE.md docs/EXTENDING.md docs/seams-reference.md \
         docs/GLOSSARY.md docs/plans/INDEX.md; do
  if ! test -f "$f"; then
    echo "✗ Missing critical file: $f"
    exit 1
  fi
done

# Check README links
while IFS= read -r link; do
  if ! test -f "$link"; then
    echo "✗ Broken link in README: $link"
    exit 1
  fi
done < <(grep -o '\[.*\](.*\.md)' README.md | grep -v 'http' | cut -d'(' -f2 | cut -d')' -f1)

echo "✓ Documentation verification passed"
exit 0
```

---

## Next Steps

1. **Establish Audit Schedule**: Assign quarterly auditors in project calendar
2. **Add to CI/CD** (optional): Integrate GitHub Actions workflow above
3. **Document in CONTRIBUTING.md**: Add section pointing to this checklist
4. **Run First Audit**: Complete one full audit cycle to prove repeatability
5. **Track Audit Reports**: Store in `docs/audits/` for reference

---

## Quick Reference

| Check | Frequency | Owner | Blocker? |
|---|---|---|---|
| 1. README & Navigation | Per PR | Reviewer | Yes |
| 2. Plans Directory | Per plan approval | PM | Yes |
| 3. ADRs & Memory | Per ADR | Architect | Yes |
| 4. Seams Guide | Per seam change | Architect | No |
| 5. Code/Doc Alignment | Per major change | Code owner | Yes |
| 6. Orphaned Decisions | Per PR | Reviewer | No |
| 7. Glossary | Quarterly | Auditor | No |
| 8. Ideas Tracking | Quarterly | Auditor | No |
| 9. Links | Quarterly | Auditor | Yes |
| 10. Full Audit | Quarterly | Auditor | No |
| 11. CI/CD Hooks | Per release | DevOps | Yes |

---

**Last Updated:** 2026-07-21
**Version:** 1.0 (initial version)
**Status:** Published, in use
