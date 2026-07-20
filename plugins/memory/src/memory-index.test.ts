import { afterAll, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { NOTE_KIND, NOTE_KINDS, type EventRecord, type MemoryNote, type NoteKind } from '@orc/contracts'
import { SurrealMemory } from './surreal'
import { eventFixture } from '@orc/contracts/fixtures'
import { createTestSurreal } from './test-helpers'
import { renderMemoryIndex, rebuildVaultMemory, SECTIONS } from './memory-index'


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
    expect(md).toContain('["Current architecture"]')
    expect(md).toContain('["Target architecture"]')
    expect(md).toContain('["Decisions and facts"]')
    expect(md).toContain('-->|depends_on|')
    expect(md).toContain('click n0 "db.md"')
    expect(md).toContain("Event 'envelope'") // quotes sanitized out of mermaid labels
    expect(md).toContain('Team server')
    expect(md).toContain('Why Postgres')
    expect(md).toContain('_Not yet documented: Research._') // the one section with no notes
    expect(md).toBe(renderMemoryIndex(notes)) // deterministic
  })

  // Observed on a real run: an agent wrote a `fact` summarising a `research` note and linked
  // `derived_from` back to it. Per-section graphs could not draw that edge — both endpoints have
  // to share a graph — so the link tying a conclusion to its evidence rendered nowhere, while
  // memory_neighbors traversed it fine. One graph with subgraphs is what makes it visible.
  it('draws an edge whose endpoints are in different sections', () => {
    const md = renderMemoryIndex([
      note({ id: 'summary', kind: 'fact', title: 'Summary', links: [{ id: 'finding', kind: 'derived_from' }] }),
      note({ id: 'finding', kind: 'research', title: 'Finding', sources: [{ url: 'https://e.test', retrievedAt: 'T' }] }),
    ])
    expect(md).toContain('-->|derived_from|')
    expect(md.match(/```mermaid/g)).toHaveLength(1) // one graph, so cross-section edges CAN exist
    // and the sections are still distinguishable within it
    expect(md).toContain('["Decisions and facts"]')
    expect(md).toContain('["Research"]')
  })

  it('names every section that has no notes, and says so plainly when there are none at all', () => {
    const md = renderMemoryIndex([])
    expect(md).toContain('_none_')
    for (const s of SECTIONS) expect(md).toContain(s.title)
    expect(md).not.toContain('```mermaid') // no empty graph block
  })

  // A kind missing from SECTIONS gets a note file but never appears in the human-facing index —
  // silently, since nothing errors. That is how `research` shipped: the sourced-research feature
  // writes cited findings that its own index then omits. Pin every kind the renderer must place,
  // so the next kind added to NOTE_KINDS fails here instead of going invisible.
  it('places every note kind in a section, or names it as deliberately unplaced', () => {
    const placed = new Set(SECTIONS.flatMap(s => s.kinds))
    // `plan` is deliberately absent: plan notes are reachable by path from the task they belong
    // to, and nothing has asked for a plan DAG view (system-hardening plan, slice 19).
    const deliberatelyUnplaced = new Set<NoteKind>([NOTE_KIND.plan])
    const missing = NOTE_KINDS.filter(k => !placed.has(k) && !deliberatelyUnplaced.has(k))
    expect(missing).toEqual([])
  })

  it('renders a research note into the index with its own section', () => {
    const md = renderMemoryIndex([
      note({ id: 'pgvector', kind: 'research', title: 'pgvector recall past 1M rows',
        sources: [{ url: 'https://example.test/b', retrievedAt: 'T' }] }),
    ])
    expect(md).toContain('["Research"]')
    expect(md).toContain('pgvector recall past 1M rows')
    expect(md).toContain('click n0 "pgvector.md"')
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
