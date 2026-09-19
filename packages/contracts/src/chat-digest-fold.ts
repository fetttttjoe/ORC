import { ChatKind, type ChatOpenedPayload } from './chat'
import { ChatDigest } from './chat-digest'
import { EVENT_KIND, type EventRecord } from './event-kinds'
import { PAYLOAD_SCHEMAS } from './events'
import { addUsage, type Usage, ZERO_USAGE } from './execution'
import { feedbackKey, openFeedbackTopics, type FeedbackEvent } from './feedback-open'
import type { Door } from './origin'
import { TASK_STATUS, type TaskStatus } from './task'

// The FOLD that derives a digest from the log alone. Nothing about a chat is stored except its
// chat_opened: the end, the cost and everything it caused are derived here, so a chat cannot be
// half-recorded by a client that died before writing its closing row.

interface Opened { payload: ChatOpenedPayload; door: Door; seq: number }

// A status change that COULD be a chat's end. Which task it belongs to is decided in the field
// table, not while folding: chat_opened may arrive after it, so the chat's own task is not yet known.
interface End { seq: number; taskId: string; to: TaskStatus }

interface Acc {
  chatId: string
  opened: Opened | null
  lastSeq: number
  ends: End[]
  asked: string | null
  tasks: string[]
  plans: string[]
  runs: string[]
  written: Set<string>
  verified: Set<string>
  deleted: Set<string>
  commits: string[]
  artifacts: string[]
  feedback: FeedbackEvent[]
  usage: Usage
  summary: string | null
}

const emptyAcc = (chatId: string): Acc => ({
  chatId, opened: null, lastSeq: 0, ends: [], asked: null,
  tasks: [], plans: [], runs: [], written: new Set(), verified: new Set(), deleted: new Set(),
  commits: [], artifacts: [], feedback: [], usage: ZERO_USAGE, summary: null,
})

// A chat that was opened. The fold accumulates every chatId it sees; only these become digests,
// because a digest with no chat_opened could state neither its kind nor what it is about.
interface Ready extends Acc { opened: Opened }

const askedKeys = (events: ReadonlyArray<FeedbackEvent>): Set<string> => {
  const keys = new Set<string>()
  for (const e of events) {
    if (e.taskId === null || e.kind !== EVENT_KIND.feedback_requested) continue
    const p = PAYLOAD_SCHEMAS.feedback_requested.safeParse(e.payload)
    if (p.success) keys.add(feedbackKey(e.taskId, p.data.topic))
  }
  return keys
}

const isRun = (a: Ready): boolean => a.opened.payload.kind === ChatKind.run

// A split child's status stamps are appended under the PARENT run's chat, so a change naming any
// other task would report that task's status as this run's outcome.
const ownEnd = (a: Ready): End | null => {
  const taskId = a.opened.payload.taskId
  if (!isRun(a) || taskId === null) return null
  return a.ends.filter((e) => e.taskId === taskId).at(-1) ?? null
}

// One folder per field, so a field added to ChatDigest and not folded fails the BUILD — the guard
// DraftCoversTiers and FitterCoversNote exist for: a silently dropped field reads as "this chat
// caused nothing", which is indistinguishable from the truth.
type DigestFields = { [K in keyof ChatDigest]: (a: Ready) => ChatDigest[K] }

const FIELDS: DigestFields = {
  chatId: (a) => a.chatId,
  kind: (a) => a.opened.payload.kind,
  title: (a) => a.opened.payload.title,
  workspaceId: (a) => a.opened.payload.workspaceId,
  taskId: (a) => a.opened.payload.taskId,
  door: (a) => a.opened.door,
  parent: (a) => a.opened.payload.parent,
  externalRef: (a) => a.opened.payload.externalRef,
  openedSeq: (a) => a.opened.seq,
  lastSeq: (a) => a.lastSeq,
  endedSeq: (a) => ownEnd(a)?.seq ?? null,
  outcome: (a) => ownEnd(a)?.to ?? null,
  asked: (a) => a.asked,
  caused: (a) => ({ tasks: a.tasks, plans: a.plans, runs: a.runs }),
  notes: (a) => ({ written: [...a.written], verified: [...a.verified], deleted: [...a.deleted] }),
  commits: (a) => a.commits,
  artifacts: (a) => a.artifacts,
  questions: (a) => ({ asked: askedKeys(a.feedback).size, open: openFeedbackTopics(a.feedback).size }),
  usage: (a) => a.usage,
  summary: (a) => a.summary,
}

// Parsed rather than assembled: the table above proves every field was FOLDED, and this proves the
// folded value is the shape the schema promises.
const build = (a: Ready): ChatDigest => {
  const folded = Object.entries(FIELDS).map(([key, fold]): [string, unknown] => [key, fold(a)])
  return ChatDigest.parse(Object.fromEntries(folded))
}

function absorb(acc: Acc, event: EventRecord): void {
  acc.lastSeq = Math.max(acc.lastSeq, event.seq)
  if (event.usage !== null) acc.usage = addUsage(acc.usage, event.usage)
  switch (event.kind) {
    case EVENT_KIND.task_created: {
      const p = PAYLOAD_SCHEMAS.task_created.safeParse(event.payload)
      if (p.success) acc.tasks.push(p.data.task.id)
      return
    }
    case EVENT_KIND.plan_proposed: {
      const p = PAYLOAD_SCHEMAS.plan_proposed.safeParse(event.payload)
      if (p.success) acc.plans.push(p.data.plan.taskId)
      return
    }
    case EVENT_KIND.task_status_changed: {
      const p = PAYLOAD_SCHEMAS.task_status_changed.safeParse(event.payload)
      if (!p.success || p.data.to === TASK_STATUS.running) return
      acc.ends.push({ seq: event.seq, taskId: p.data.taskId, to: p.data.to })
      return
    }
    case EVENT_KIND.step_completed: {
      const p = PAYLOAD_SCHEMAS.step_completed.safeParse(event.payload)
      if (p.success) acc.summary = p.data.summary
      return
    }
    case EVENT_KIND.copilot_exchange: {
      const p = PAYLOAD_SCHEMAS.copilot_exchange.safeParse(event.payload)
      if (p.success && acc.asked === null) acc.asked = p.data.user
      return
    }
    case EVENT_KIND.memory_written: {
      const p = PAYLOAD_SCHEMAS.memory_written.safeParse(event.payload)
      if (p.success) acc.written.add(p.data.note.id)
      return
    }
    case EVENT_KIND.memory_verified: {
      const p = PAYLOAD_SCHEMAS.memory_verified.safeParse(event.payload)
      if (p.success) acc.verified.add(p.data.id)
      return
    }
    case EVENT_KIND.memory_deleted: {
      const p = PAYLOAD_SCHEMAS.memory_deleted.safeParse(event.payload)
      if (p.success) acc.deleted.add(p.data.id)
      return
    }
    case EVENT_KIND.commit_recorded: {
      const p = PAYLOAD_SCHEMAS.commit_recorded.safeParse(event.payload)
      if (p.success) acc.commits.push(p.data.sha)
      return
    }
    case EVENT_KIND.artifact_produced: {
      const p = PAYLOAD_SCHEMAS.artifact_produced.safeParse(event.payload)
      if (p.success) acc.artifacts.push(p.data.path)
      return
    }
    case EVENT_KIND.feedback_requested:
    case EVENT_KIND.feedback_provided:
      acc.feedback.push(event)
      return
    default:
      return
  }
}

/**
 * Every opened chat in `events` (LOG ORDER), newest-opened first.
 *
 * One pass: a chat's own events may sit at LOWER seqs than its chat_opened — a copilot exchange and
 * the open that names it are appended together once the exchange ends — so nothing here may treat
 * chat_opened as a chat's first event, and a second pass would only re-read what the first saw.
 * Events with chatId null belong to no chat and are dropped.
 */
export function chatDigests(events: ReadonlyArray<EventRecord>): ChatDigest[] {
  const accs = new Map<string, Acc>()
  const accOf = (chatId: string): Acc => {
    const existing = accs.get(chatId)
    if (existing !== undefined) return existing
    const fresh = emptyAcc(chatId)
    accs.set(chatId, fresh)
    return fresh
  }

  for (const event of events) {
    if (event.chatId === null) continue
    const acc = accOf(event.chatId)
    if (event.kind === EVENT_KIND.chat_opened) {
      const p = PAYLOAD_SCHEMAS.chat_opened.safeParse(event.payload)
      if (p.success) {
        acc.opened = { payload: p.data, door: event.door, seq: event.seq }
        // the child names its parent, so the parent's caused.runs is read off the same event
        if (p.data.parent !== null) accOf(p.data.parent.chatId).runs.push(p.data.chatId)
      }
    }
    absorb(acc, event)
  }

  const digests: ChatDigest[] = []
  for (const acc of accs.values()) {
    if (acc.opened === null) continue
    digests.push(build({ ...acc, opened: acc.opened }))
  }
  return digests.sort((a, b) => b.openedSeq - a.openedSeq)
}
