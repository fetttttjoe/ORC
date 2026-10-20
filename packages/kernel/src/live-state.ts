import { errorMessage, type EventRecord } from '@orc/contracts'
import { emptyFold, foldInto, type FoldAcc, type State } from './projections'
import type { EventLog } from './storage'

// advisory reads only: not behind the write lock, so check-then-append on it is a TOCTOU
export interface LiveState {
  /** A live view mutated in place: read synchronously, never hold it across an await. */
  current(): State
  close(): Promise<void>
}

export async function openLiveState(log: EventLog): Promise<LiveState> {
  let acc: FoldAcc = emptyFold()
  // truncation writes above the stream cursor, so the oldest surviving row is the only signal
  let earliest = 0
  let cursor = 0

  const reseed = async (): Promise<void> => {
    const events = await log.all()
    acc = events.reduce(foldInto, emptyFold())
    earliest = events[0]?.seq ?? 0
    cursor = events.at(-1)?.seq ?? 0
  }

  await reseed()

  const unsubscribe = await log.subscribe({
    fromSeq: cursor,
    // no reseed: the stream replays everything, and tokenless events escape the crash-dedup ledger
    onReset: () => { acc = emptyFold(); earliest = 0 },
  }, async (e: EventRecord) => {
    // Truncated in place — nothing gets redelivered, so rebuild from the log here.
    if (earliest !== 0 && (await log.earliestSeq()) !== earliest) {
      await reseed()
      return
    }
    acc = foldInto(acc, e)
    if (earliest === 0) earliest = e.seq
  })

  return {
    current: () => acc.state,
    close: async () => {
      // teardown must not mask the caller's own failure
      try { await unsubscribe() } catch (err) { console.warn(`live state: ${errorMessage(err)}`) }
    },
  }
}
