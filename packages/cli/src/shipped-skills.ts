import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ROLE_SKILL } from '@orc/contracts'

// The skills orc ships, and the ONE way a project's skills directory comes to exist. Lifted out of
// main.ts so a test harness can call exactly what `orc init` calls: a harness that instead pointed
// its config at this repo's own vault, or stubbed the SkillIndex, would be a second resolver — and
// the first thing it would hide is a newly shipped skill that no real project has yet (measured:
// the kernel's appended finish step declares role-finisher, and every harness with an unseeded temp
// skills dir failed at step init with "unknown skill 'role-finisher'").
const SHIPPED_SKILLS_DIR = fileURLToPath(new URL('../../../vault/skills', import.meta.url))

export const SHIPPED_SKILLS = ['codebase-analysis', 'plan-authoring', 'documentation', 'web-research', ROLE_SKILL.auditor, ROLE_SKILL.committer, ROLE_SKILL.finisher]

// Copies every shipped skill the target does not already have, and returns the names it wrote (so a
// caller can say what it did, or say nothing changed). NEVER overwrites: the bodies are
// operator-editable — a skill's prose is theirs once seeded — so re-running init tops up the set
// instead of reverting local edits.
export function seedShippedSkills(skillsDir: string): string[] {
  const seeded: string[] = []
  for (const name of SHIPPED_SKILLS) {
    const target = path.join(skillsDir, name, 'SKILL.md')
    if (existsSync(target)) continue
    mkdirSync(path.dirname(target), { recursive: true })
    copyFileSync(path.join(SHIPPED_SKILLS_DIR, name, 'SKILL.md'), target)
    seeded.push(name)
  }
  return seeded
}
