import { afterAll, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { EventRecord, MemoryNote } from '@orc/contracts'
import { SurrealMemory } from './surreal'
import { eventFixture } from '@orc/contracts/fixtures'
import { createTestSurreal } from './test-helpers'
import { renderMemoryIndex, rebuildVaultMemory } from './memory-index'

const drops: (() => Promise<void>)[] = []
afterAll(async () => { for (const d of drops) await d() })

const note = (over: Partial<MemoryNote>): MemoryNote => ({
  id: 'n', scope: 'project', kind: 'fact', sourceRevision: null, title: 'N',
  categories: [], tags: [], links: [], paths: [], rules: [], summary: '', body: 'body',
  retention: 'durable', sources: [], rationale: '', uncertainty: [],
  createdAt: 'T', createdBy: 'cli', updatedAt: 'T', updatedBy: 'cli', revision: 1, ...over,
})

describe('renderMemoryIndex', () => {
  // A title is z.string().max(200) with no newline restriction and the memory_write tool
  // advertises the same, so an agent can author one. A raw newline ends the mermaid statement:
  // the block terminates early, the fence count goes odd, and the rest of the title renders as
  // live markdown — every note in the section disappears from the human-facing index.
  it('keeps an agent-authored newline from escaping the mermaid block', () => {
    const md = renderMemoryIndex([
      note({ id: 'evil', kind: 'architecture_current', title: 'Auth\n```\n## Injected heading' }),
    ])
    const lines = md.split('\n')
    // the whole label stays one mermaid statement — nothing of it lands as document markdown
    expect(lines.some(l => l.includes('n0[') && l.includes('Auth') && l.includes('Injected heading'))).toBe(true)
    expect(lines).not.toContain('## Injected heading')
    expect(lines.filter(l => l.trim() === '```')).toHaveLength(1) // the block still closes exactly once
  })

  it('groups notes into current/target/decision sections with labeled edges and note links', () => {
    const notes = [
      note({ id: 'db', kind: 'architecture_current', title: 'Postgres log', links: [{ id: 'events', kind: 'depends_on' }] }),
      note({ id: 'events', kind: 'architecture_current', title: 'Event "envelope"' }),
      note({ id: 'server', kind: 'architecture_target', title: 'Team server' }),
      note({ id: 'why-pg', kind: 'decision', title: 'Why Postgres' }),
      note({ id: 'plain', kind: 'fact', title: 'A fact' }),
    ]
    const md = renderMemoryIndex(notes)
    expect(md).toContain('## Current architecture')
    expect(md).toContain('## Target architecture')
    expect(md).toContain('## Decisions and facts')
    expect(md).toContain('-->|depends_on|')
    expect(md).toContain('click n0 "db.md"')
    expect(md).toContain("Event 'envelope'") // quotes sanitized out of mermaid labels
    expect(md).toContain('Team server')
    expect(md).toContain('Why Postgres')
    expect(md).toBe(renderMemoryIndex(notes)) // deterministic
  })

  it('renders explicit empty sections', () => {
    const md = renderMemoryIndex([])
    expect(md.match(/_none_/g)).toHaveLength(3)
  })
})

describe('rebuildVaultMemory', () => {
  it('repairs deleted files, removes stale files, and writes a deterministic index', async () => {
    const t = await createTestSurreal(); drops.push(t.drop)
    const m = await SurrealMemory.open(t)
    const vaultDir = mkdtempSync(path.join(tmpdir(), 'orc-memidx-'))
    const written = (seq: number, id: string): EventRecord => eventFixture({
      seq, taskId: null, kind: 'memory_written',
      payload: {
        note: {
          id, scope: 'project', kind: 'fact', sourceRevision: null, title: id,
          categories: [], tags: [], links: [], paths: [], rules: [], summary: '', body: 'body',
        },
        author: { source: 'cli' },
      },
      ts: '2026-07-18T00:00:00Z',
    })
    await m.applyEvent(written(1, 'alpha'))
    await m.applyEvent(written(2, 'beta'))

    await rebuildVaultMemory(m, vaultDir)
    const alphaPath = path.join(vaultDir, 'memory', 'alpha.md')
    expect(existsSync(alphaPath)).toBe(true)
    expect(existsSync(path.join(vaultDir, 'memory', 'index.md'))).toBe(true)

    // manual damage: delete a projected file, plant a stale one
    rmSync(alphaPath)
    writeFileSync(path.join(vaultDir, 'memory', 'stale.md'), 'stale')
    await rebuildVaultMemory(m, vaultDir)
    expect(existsSync(alphaPath)).toBe(true) // reappeared
    expect(existsSync(path.join(vaultDir, 'memory', 'stale.md'))).toBe(false) // gone

    const first = readFileSync(path.join(vaultDir, 'memory', 'index.md'), 'utf8')
    await rebuildVaultMemory(m, vaultDir)
    expect(readFileSync(path.join(vaultDir, 'memory', 'index.md'), 'utf8')).toBe(first) // byte-identical
    await m.close()
  })
})
