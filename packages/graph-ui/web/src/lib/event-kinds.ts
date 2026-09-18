import { EVENT_KIND } from '@orc/contracts/event-kinds'
// The classification lives beside the views that read it — the server decides what one event
// makes stale, and this app decides which rows are ticker noise, from ONE set.
import { WORKING } from '@orc/ui-core/event-classes'

export { EVENT_KIND, WORKING }
