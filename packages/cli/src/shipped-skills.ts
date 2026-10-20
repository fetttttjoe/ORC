import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ROLE_SKILL } from '@orc/contracts'

// the one way a project's skills dir comes to exist: `orc init` and test harnesses call it
const SHIPPED_SKILLS_DIR = fileURLToPath(new URL('../../../vault/skills', import.meta.url))

export const SHIPPED_SKILLS = ['codebase-analysis', 'plan-authoring', 'documentation', 'web-research', ROLE_SKILL.auditor, ROLE_SKILL.committer, ROLE_SKILL.finisher]

// NEVER overwrites: skill bodies are operator-editable, so re-running init only tops up
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
