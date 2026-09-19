import { describe, expect, it } from 'bun:test'
import { ChatKind } from './chat'
import { ChatDigest } from './chat-digest'
import { ZERO_USAGE } from './execution'
import { Door } from './origin'

// A chat that ended nothing and caused nothing — still a whole digest, every field present.
const digest: Record<string, unknown> = {
  chatId: 'c1', kind: ChatKind.copilot, title: 'chat c1', workspaceId: null, taskId: null,
  door: Door.web, parent: null, externalRef: null, openedSeq: 1, lastSeq: 1, endedSeq: null,
  outcome: null, asked: null,
  caused: { tasks: [], plans: [], runs: [] },
  notes: { written: [], verified: [], deleted: [] },
  commits: [], artifacts: [], questions: { asked: 0, open: 0 }, usage: ZERO_USAGE, summary: null,
}

const without = (field: string): Record<string, unknown> => {
  const partial = { ...digest }
  delete partial[field]
  return partial
}

describe('ChatDigest', () => {
  it('parses a chat that has ended nothing and caused nothing', () => {
    const parsed = ChatDigest.parse(digest)
    expect(parsed.endedSeq).toBeNull()
    expect(parsed.caused).toEqual({ tasks: [], plans: [], runs: [] })
  })

  // Nullable, never absent: "this chat is still open" and "whoever folded this forgot the end" must
  // not look alike, and an ABSENT count reads as nothing having happened.
  it('rejects a half-folded digest, field by field', () => {
    for (const field of Object.keys(digest)) {
      expect(ChatDigest.safeParse(without(field)).success).toBe(false)
    }
  })
})
