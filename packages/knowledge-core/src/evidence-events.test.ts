import { describe, expect, it } from 'bun:test'
import { CheckVerdict, DeliveryMode, EVENT_KIND, FS_READ_TOOL_NAME } from '@orc/contracts'
import { authorFixture } from '@orc/contracts/fixtures'
import { EvidenceKind } from './evidence'
import { evidenceEventsOf, type EvidenceRecord } from './evidence-events'

const author = authorFixture()
const record = (seq: number, kind: string, payload: unknown, runToken: string | null = 'r1'): EvidenceRecord => ({ seq, kind, runToken, payload })
const written = (over: Record<string, unknown> = {}) => ({
  added: [{ id: 'aaaa0001', location: 'knowledge/src/a.ts.md' }], changed: [], retired: [{ id: 'aaaa0002', location: 'knowledge/src/a.ts.md' }],
  files: ['knowledge/src/a.ts.md'], why: null, decision: null, decisionsRecorded: [], decisionsSuperseded: [],
  asserted: [{ id: 'aaaa0001', text: 'a writes', anchors: [{ path: 'src/a.ts', symbol: 'alpha', digest: 'd1' }] }],
  author, ...over,
})
const toolCall = (toolName: string, input: unknown) => ({ stepId: 's1', runToken: 'r1', iteration: 1, toolCallId: 'c1', toolName, input })
const checked = (verdict: CheckVerdict) => ({ id: 'aaaa0001', verdict, text: 'a writes', anchors: [{ path: 'src/a.ts', symbol: null, digest: 'd2' }], why: 'read it', author })

describe('evidenceEventsOf', () => {
  it('decodes one record of each kind', () => {
    expect(evidenceEventsOf([
      record(1, EVENT_KIND.knowledge_written, written()),
      record(2, EVENT_KIND.knowledge_checked, checked(CheckVerdict.holds), null),
      record(3, EVENT_KIND.knowledge_checked, checked(CheckVerdict.false), null),
      record(4, EVENT_KIND.knowledge_delivered, { ids: ['aaaa0001'], mode: DeliveryMode.preload, subject: 'src/a.ts', author }),
      record(5, EVENT_KIND.tool_call, toolCall(FS_READ_TOOL_NAME, { path: './src//lib/../a.ts', start: 3 })),
    ])).toEqual([
      { kind: EvidenceKind.asserted, seq: 1, run: 'r1', id: 'aaaa0001', text: 'a writes', anchors: [{ path: 'src/a.ts', symbol: 'alpha', digest: 'd1' }] },
      { kind: EvidenceKind.retired, seq: 1, run: 'r1', id: 'aaaa0002' },
      { kind: EvidenceKind.checked, seq: 2, run: null, id: 'aaaa0001', text: 'a writes', verdict: CheckVerdict.holds, accepts: true, anchors: [{ path: 'src/a.ts', symbol: null, digest: 'd2' }] },
      { kind: EvidenceKind.checked, seq: 3, run: null, id: 'aaaa0001', text: 'a writes', verdict: CheckVerdict.false, accepts: false, anchors: [{ path: 'src/a.ts', symbol: null, digest: 'd2' }] },
      { kind: EvidenceKind.delivered, seq: 4, run: 'r1', ids: ['aaaa0001'], mode: DeliveryMode.preload },
      { kind: EvidenceKind.read, seq: 5, run: 'r1', path: 'src/a.ts' },
    ])
  })

  it('a knowledge_written without asserted yields nothing, not even its retires', () => {
    const { asserted: _dropped, ...old } = written()
    expect(evidenceEventsOf([record(1, EVENT_KIND.knowledge_written, old)])).toEqual([])
  })

  it('an fs_list call, an fs_read without a string path, a malformed check and an unrelated kind yield nothing', () => {
    expect(evidenceEventsOf([
      record(1, EVENT_KIND.tool_call, toolCall('fs_list', { path: 'src' })),
      record(2, EVENT_KIND.tool_call, toolCall(FS_READ_TOOL_NAME, { path: 42 })),
      record(3, EVENT_KIND.knowledge_checked, { id: 'aaaa0001', verdict: 'maybe' }),
      record(4, EVENT_KIND.task_created, { task: {} }),
    ])).toEqual([])
  })
})
