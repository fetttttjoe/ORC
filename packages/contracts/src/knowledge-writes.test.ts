import { describe, expect, it } from 'bun:test'
import { foldKnowledgeWrites, NO_KNOWLEDGE_WRITES, type WrittenRef, type WrittenRefs } from './knowledge-writes'

const ref = (id: string, location = `k/${id}.md`): WrittenRef => ({ id, location })
const write = (over: Partial<WrittenRefs>): WrittenRefs => ({ added: [], changed: [], retired: [], files: [], ...over })

describe('foldKnowledgeWrites', () => {
  it('nothing written folds to nothing', () => {
    expect(foldKnowledgeWrites([])).toEqual(NO_KNOWLEDGE_WRITES)
  })
  it('added and changed claims are live at their latest location, in first-write order', () => {
    expect(foldKnowledgeWrites([
      write({ added: [ref('aaaaaaaa'), ref('bbbbbbbb')] }),
      write({ changed: [ref('aaaaaaaa', 'k/moved.md'), ref('cccccccc')] }),
    ]).live).toEqual([ref('aaaaaaaa', 'k/moved.md'), ref('bbbbbbbb'), ref('cccccccc')])
  })
  it('a later retire takes a claim out of live and lists it as retired', () => {
    const folded = foldKnowledgeWrites([write({ added: [ref('aaaaaaaa'), ref('bbbbbbbb')] }), write({ retired: [ref('aaaaaaaa')] })])
    expect(folded.live).toEqual([ref('bbbbbbbb')])
    expect(folded.retired).toEqual([ref('aaaaaaaa')])
  })
  it('files are the sorted union of every write', () => {
    expect(foldKnowledgeWrites([write({ files: ['k/b.md', 'k/a.md'] }), write({ files: ['k/a.md', 'k/c.md'] })]).files)
      .toEqual(['k/a.md', 'k/b.md', 'k/c.md'])
  })
})
