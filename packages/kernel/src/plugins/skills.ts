import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { SkillManifest, type LoadedSkill, type SkillIndexEntry } from '@orc/contracts'

// open-spec frontmatter keys → SkillManifest fields (unknown keys are validation errors)
const KEY_MAP: Record<string, string> = {
  name: 'name', description: 'description', license: 'license',
  compatibility: 'compatibility', 'allowed-tools': 'allowedTools', metadata: 'metadata',
}

const unquote = (v: string): string => {
  const t = v.trim()
  return (t.startsWith('"') && t.endsWith('"') && t.length >= 2) || (t.startsWith("'") && t.endsWith("'") && t.length >= 2)
    ? t.slice(1, -1)
    : t
}

// ponytail: hand-rolled parser for the six-field flat schema + one metadata block —
// a YAML library arrives only if real third-party skills ship YAML this can't read.
export function parseSkillMd(
  text: string,
  dirName: string,
): { manifest: SkillManifest | null; errors: string[]; body: string } {
  const norm = text.replaceAll('\r\n', '\n')
  if (!norm.startsWith('---\n')) return { manifest: null, errors: ['missing frontmatter fence'], body: '' }
  const end = norm.indexOf('\n---', 4)
  if (end === -1) return { manifest: null, errors: ['unclosed frontmatter fence'], body: '' }
  const head = norm.slice(4, end).split('\n')
  const body = norm.slice(norm.indexOf('\n', end + 1) + 1)

  const raw: Record<string, unknown> = {}
  const errors: string[] = []
  let metadata: Record<string, string> | null = null
  for (const line of head) {
    if (line.trim() === '') continue
    if (metadata !== null && /^\s+\S/.test(line)) {
      const i = line.indexOf(':')
      if (i === -1) errors.push(`bad metadata line: '${line.trim()}'`)
      else metadata[line.slice(0, i).trim()] = unquote(line.slice(i + 1))
      continue
    }
    metadata = null
    const i = line.indexOf(':')
    if (i === -1) {
      errors.push(`bad frontmatter line: '${line.trim()}'`)
      continue
    }
    const key = line.slice(0, i).trim()
    const value = line.slice(i + 1)
    const mapped = KEY_MAP[key]
    if (!mapped) {
      errors.push(`unknown frontmatter field: '${key}'`)
      continue
    }
    if (mapped === 'metadata') {
      metadata = {}
      raw[mapped] = metadata
    } else {
      raw[mapped] = unquote(value)
    }
  }

  const parsed = SkillManifest.safeParse(raw)
  if (!parsed.success) errors.push(...parsed.error.issues.map(i => `${i.path.join('.') || 'frontmatter'}: ${i.message}`))
  else if (parsed.data.name !== dirName) errors.push(`name '${parsed.data.name}' must equal directory name '${dirName}'`)

  return { manifest: parsed.success ? parsed.data : null, errors, body }
}

interface CacheEntry { mtimeMs: number; size: number; entry: SkillIndexEntry }

const skillFile = (dir: string): string | null => {
  for (const f of ['SKILL.md', 'skill.md']) if (existsSync(path.join(dir, f))) return path.join(dir, f)
  return null
}

export class SkillIndex {
  private cache = new Map<string, CacheEntry>() // keyed by skill dir name
  private timer: ReturnType<typeof setInterval> | null = null

  private constructor(private readonly root: string) {}

  static async open(skillsDir: string): Promise<SkillIndex> {
    const idx = new SkillIndex(skillsDir)
    idx.rescan()
    return idx
  }

  list(): SkillIndexEntry[] {
    return [...this.cache.values()].map(c => c.entry).sort((a, b) => a.name.localeCompare(b.name))
  }

  async load(name: string): Promise<LoadedSkill> {
    const c = this.cache.get(name)
    if (!c) throw new Error(`unknown skill '${name}'`)
    if (!c.entry.valid) throw new Error(`invalid skill '${name}': ${c.entry.errors.join('; ')}`)
    const file = skillFile(c.entry.dir)
    if (!file) throw new Error(`unknown skill '${name}' (SKILL.md removed)`)
    const { body } = parseSkillMd(readFileSync(file, 'utf8'), name)
    return { name, body, hash: createHash('sha256').update(body).digest('hex') }
  }

  // ponytail: 500ms polling rescan, NOT fs.watch — Bun's recursive watch never reports
  // files inside dirs created after watch start (spike 2026-07-17); a full rescan is <1ms.
  watch(intervalMs = 500): void {
    if (this.timer) return
    this.timer = setInterval(() => this.rescan(), intervalMs)
    this.timer.unref?.()
  }

  close(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private rescan(): void {
    const seen = new Set<string>()
    let names: string[] = []
    try {
      names = readdirSync(this.root, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name)
    } catch {
      this.cache.clear() // root missing → empty index
      return
    }
    for (const name of names) {
      const dir = path.join(this.root, name)
      const file = skillFile(dir)
      if (!file) continue
      seen.add(name)
      let st
      try {
        st = statSync(file)
      } catch {
        continue // vanished mid-scan; next rescan settles it
      }
      const prev = this.cache.get(name)
      if (prev && prev.mtimeMs === st.mtimeMs && prev.size === st.size) continue
      let text: string
      try {
        text = readFileSync(file, 'utf8')
      } catch {
        continue // vanished mid-scan; next rescan settles it
      }
      const { manifest, errors } = parseSkillMd(text, name)
      this.cache.set(name, {
        mtimeMs: st.mtimeMs,
        size: st.size,
        entry: { name, dir, valid: errors.length === 0 && manifest !== null, errors, manifest },
      })
    }
    for (const name of this.cache.keys()) if (!seen.has(name)) this.cache.delete(name)
  }
}
