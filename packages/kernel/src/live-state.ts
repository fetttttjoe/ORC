import { errorMessage, type EventRecord } from '@orc/contracts'
import { emptyFold, foldInto, type FoldAcc, type State } from './projections'
import type { EventLog } from './storage'

// A subscription-maintained index over the log, replacing `fold(await log.all())` on advisory read
// paths.
//
// NOT for reads that decide a write: this is not behind the project write lock, so check-then-append
// against it is a TOCTOU. Those stay inside `log.transaction`, reading through `tx`.
export interface LiveState {
  /**
   * A LIVE view, not a snapshot: the accumulator is mutated in place as events arrive, so read what
   * you need synchronously and do not retain it across an await.
   */
  current(): State
  close(): Promise<void>
}

export async function openLiveState(log: EventLog): Promise<LiveState> {
  let acc: FoldAcc = emptyFold()
  // `seq` is a global identity column: a truncation writes ABOVE the stream cursor, so delivery
  // continues normally and the subscription never reports the vanished history. The oldest
  // surviving row is the only signal. Same guard as ui-core/sessions.ts.
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
    // The stream rewound to 0 and is about to redeliver everything: empty, do NOT reseed. Reseeding
    // too would apply each event twice, and events without a runToken (run_requested,
    // reaction_failed) are not covered by the crash-dedup ledger.
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
