import { CORPUS_CHANGE } from '../event-classes'
import { TOUCHABLE } from '../wire'
import type { Touchable } from './view'

// Corpus health — the drift ratio, the pending backlog, the note counts — is a read a client holds
// and this log can make stale, but it is not a view: answering it probes SurrealDB and git, where a
// view is a pure fold of the log. So it owns a staleness rule and nothing else.
//
// One touch pattern, because the reading is whole-corpus: there is no narrower query to name.
export const health: Touchable = {
  name: TOUCHABLE.health,
  touches: event => (CORPUS_CHANGE.has(event.kind) ? [{}] : []),
}
