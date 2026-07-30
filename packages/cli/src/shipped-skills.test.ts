import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ROLE_SKILL } from '@orc/contracts'
import { parseSkillMd } from '@orc/kernel'
import { SHIPPED_SKILLS } from './main'

// The tracked shipped-skill sources (exceptions inside gitignored vault/). The role skills carry
// contract prose the freeze used to inline as kernel constants (grounded-plan.ts); these pin the
// battle-tested sentences so an operator edit that guts a rule fails the build, not a live audit.
const DIR = fileURLToPath(new URL('../../../vault/skills', import.meta.url))

const read = (name: string) => parseSkillMd(readFileSync(path.join(DIR, name, 'SKILL.md'), 'utf8'), name)

describe('shipped skills', () => {
  test.each(SHIPPED_SKILLS)('%s parses under the strict frontmatter', name => {
    const { manifest, errors } = read(name)
    expect(errors).toEqual([])
    expect(manifest?.name).toBe(name)
  })

  test('role-auditor pins the auditor + heal contract sentences', () => {
    const { body } = read(ROLE_SKILL.auditor)
    expect(body).toContain("if your audit finds ANY defect, signal outcome 'failure'")
    expect(body).toContain('Success means zero defects.')
    expect(body).toContain('scoped_changes')
    expect(body).toContain('not from a working-tree diff')
    expect(body).toContain('never licenses skipping the test/typecheck gate')
    expect(body).toContain('never excuses a defect in a file that IS in scope')
    expect(body).toContain('empty set is not evidence of success')
    expect(body).toContain('title and summary')
    expect(body).toContain('retrieval surface')
    // heal-or-confirm: candidates come from scoped_changes' citingNotes (drift flags lag
    // uncommitted work — observed twice as post-commit drift), and a still-true note gets a
    // confirm write so the commit restamp can reach it
    expect(body).toContain('citingNotes')
    expect(body).toContain('CONFIRM — memory_write with the SAME id and the content unchanged')
  })

  test('role-committer pins the commit contract sentences', () => {
    const { body } = read(ROLE_SKILL.committer)
    expect(body).toContain('commit_preview')
    expect(body).toContain('READ the diff it returns')
    expect(body).toContain('refuses whenever the tree no longer matches')
    expect(body).toContain("'Nothing to commit' is a valid outcome")
    expect(body).toContain('STILL call git_commit once')
    // the receipt's honesty line: leftovers the auditor did not verify travel in the summary
    expect(body).toContain('stillDrifted')
  })
})
