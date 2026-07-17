import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { SkillIndex, parseSkillMd } from './skills'

const SKILL = (name: string, desc = 'demo skill, use for demos') => `---
name: ${name}
description: ${desc}
---

# Body of ${name}

Do the thing.
`

let dirs: string[] = []
function tempSkills(): string {
  const d = mkdtempSync(path.join(tmpdir(), 'orc-skills-'))
  dirs.push(d)
  return d
}
function writeSkill(root: string, name: string, content?: string): void {
  mkdirSync(path.join(root, name), { recursive: true })
  writeFileSync(path.join(root, name, 'SKILL.md'), content ?? SKILL(name))
}
const open = async (d: string) => {
  const idx = await SkillIndex.open(d)
  return idx
}
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  dirs = []
})

describe('parseSkillMd', () => {
  it('parses frontmatter + body', () => {
    const r = parseSkillMd(SKILL('my-skill'), 'my-skill')
    expect(r.manifest?.name).toBe('my-skill')
    expect(r.errors).toEqual([])
    expect(r.body).toContain('# Body of my-skill')
  })

  it('maps allowed-tools and parses a metadata block', () => {
    const text = `---\nname: a\ndescription: d\nallowed-tools: Bash(git:*) Read\nmetadata:\n  author: y\n  version: "1.0"\n---\nbody`
    const r = parseSkillMd(text, 'a')
    expect(r.manifest?.allowedTools).toBe('Bash(git:*) Read')
    expect(r.manifest?.metadata).toEqual({ author: 'y', version: '1.0' })
  })

  it('strips quotes from quoted values and keeps colons in plain values', () => {
    const text = `---\nname: a\ndescription: "does: quoted things"\nlicense: MIT: see LICENSE\n---\nb`
    const r = parseSkillMd(text, 'a')
    expect(r.manifest?.description).toBe('does: quoted things')
    expect(r.manifest?.license).toBe('MIT: see LICENSE')
  })

  it('rejects a missing fence, name/dir mismatch, and unknown keys', () => {
    expect(parseSkillMd('no frontmatter', 'a').errors).not.toEqual([])
    expect(parseSkillMd(SKILL('other-name'), 'a').errors.join()).toContain('directory')
    expect(parseSkillMd(`---\nname: a\ndescription: d\nmodel: x\n---\nb`, 'a').errors.join()).toContain('model')
  })

  it('handles CRLF', () => {
    const r = parseSkillMd(`---\r\nname: a\r\ndescription: d\r\n---\r\nbody\r\n`, 'a')
    expect(r.errors).toEqual([])
    expect(r.manifest?.description).toBe('d')
  })
})

describe('SkillIndex', () => {
  it('scans valid and invalid skills; missing dir → empty index', async () => {
    const root = tempSkills()
    writeSkill(root, 'good-skill')
    writeSkill(root, 'bad-skill', `---\nname: MISMATCH\ndescription: d\n---\nb`)
    mkdirSync(path.join(root, 'no-skill-md')) // dir without SKILL.md → ignored
    const idx = await open(root)
    const entries = idx.list()
    expect(entries.map(e => [e.name, e.valid])).toEqual([['bad-skill', false], ['good-skill', true]])
    expect(entries[0]!.errors.length).toBeGreaterThan(0)

    const empty = await open(path.join(root, 'does-not-exist'))
    expect(empty.list()).toEqual([])
  })

  it('load() returns body + sha256 hash; throws on unknown or invalid', async () => {
    const root = tempSkills()
    writeSkill(root, 'good-skill')
    writeSkill(root, 'bad-skill', `---\nname: nope\ndescription: d\n---\nb`)
    const idx = await open(root)
    const s = await idx.load('good-skill')
    expect(s.body).toContain('# Body of good-skill')
    expect(s.hash).toMatch(/^[0-9a-f]{64}$/)
    await expect(idx.load('missing')).rejects.toThrow(/unknown skill/)
    await expect(idx.load('bad-skill')).rejects.toThrow(/invalid skill/)
  })

  it('watch() indexes a NEW skill dir created after watch start within 1s', async () => {
    const root = tempSkills()
    const idx = await open(root)
    idx.watch(50) // fast interval for the test; production default 500
    try {
      writeSkill(root, 'late-skill')
      const deadline = Date.now() + 1000
      while (Date.now() < deadline && !idx.list().some(e => e.name === 'late-skill'))
        await new Promise(r => setTimeout(r, 20))
      expect(idx.list().some(e => e.name === 'late-skill' && e.valid)).toBe(true)
    } finally {
      idx.close()
    }
  })

  it('watch() picks up edits and deletions', async () => {
    const root = tempSkills()
    writeSkill(root, 'evolving')
    const idx = await open(root)
    idx.watch(50)
    try {
      // edit: description changes (force distinct mtime content-wise; size changes too)
      writeSkill(root, 'evolving', SKILL('evolving', 'now with a much longer description'))
      let deadline = Date.now() + 1000
      while (Date.now() < deadline && idx.list().find(e => e.name === 'evolving')?.manifest?.description !== 'now with a much longer description')
        await new Promise(r => setTimeout(r, 20))
      expect(idx.list().find(e => e.name === 'evolving')?.manifest?.description).toBe('now with a much longer description')

      rmSync(path.join(root, 'evolving'), { recursive: true })
      deadline = Date.now() + 1000
      while (Date.now() < deadline && idx.list().some(e => e.name === 'evolving'))
        await new Promise(r => setTimeout(r, 20))
      expect(idx.list().some(e => e.name === 'evolving')).toBe(false)
    } finally {
      idx.close()
    }
  })
})
