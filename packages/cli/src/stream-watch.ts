import type { EventKind, EventRecord } from '@orc/contracts'
import type { Kernel } from '@orc/kernel'
import { summarizeEvent } from '@orc/ui-core'

export function formatStreamLine(e: EventRecord): string {
  const { line } = summarizeEvent(e)
  return `${String(e.seq).padStart(5)}  ${e.kind.padEnd(24)}  ${line}`
}

export interface StreamWatchOptions {
  // exclusive, like every other seq cursor on the wire; omitted means a live tail from now
  since?: number
  // undefined or empty means no filter
  kinds?: EventKind[]
}

export type EventFeed = Pick<Kernel, 'subscribe'>

export function watchStream(
  feed: EventFeed,
  opts: StreamWatchOptions,
  onLine: (line: string) => void,
): Promise<() => Promise<void>> {
  const kinds = opts.kinds && opts.kinds.length > 0 ? new Set(opts.kinds) : null
  return feed.subscribe({ fromSeq: opts.since }, e => {
    if (kinds && !kinds.has(e.kind)) return
    onLine(formatStreamLine(e))
  })
}
