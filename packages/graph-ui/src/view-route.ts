import { readView, type ReadModel, type ViewResult } from '@orc/ui-core'
import { viewParams, type ViewName } from '@orc/ui-core/wire'

/**
 * What a DOOR can answer for a view the log cannot fill, consulted only when the view came back
 * empty — so the log wins the moment it has anything to say.
 *
 * It exists for the model catalog and would be a branch in this route without it. The catalog is a
 * fold of models_discovered events, so it is empty until a discovery has been appended — the state
 * every project boots in, where an empty picker disables "create request" entirely. Live discovery
 * calls provider APIs, which a view (a pure fold, answerable read-only) may never do, so the answer
 * belongs to whichever door holds the provider config.
 *
 * Keyed by view name, with each answer typed as THAT view's result: a door offering a shape the
 * browser's schema would reject fails the build here, instead of being served under the view's name
 * and rejected at the pane.
 *
 * Empty means an empty ARRAY: a door can offer a list the log has not collected yet, never a
 * subject that does not exist — that is the view's own null, and this route answers it 404.
 */
export type DoorAnswers = { readonly [N in ViewName]?: () => Promise<ViewResult<N>> }

/**
 * One HTTP read, for any view. Pure over a ReadModel: everything about WHICH read is answered and
 * with what status is readView's, so a second door serves the same views without a second copy of
 * the parse-then-read sequence, and this file's tests need no server.
 *
 * `q` is the raw query value the URL carried. `viewParams` reads it, and lives beside the builder
 * that writes it so the two halves of the format cannot drift apart.
 */
export async function viewResponse(model: ReadModel, name: string, q: string | null, whenEmpty: DoorAnswers = {}): Promise<Response> {
  const params = viewParams(q)
  if (!params.ok) return Response.json({ error: params.error }, { status: 400 })
  const out = readView(model, name, params.params)
  if (!out.ok) return Response.json({ error: out.error }, { status: out.status })
  // indexed by the view the registry RESOLVED, never by the raw path segment — the enum lookup
  // happens once, inside readView
  const door = Array.isArray(out.data) && out.data.length === 0 ? whenEmpty[out.name] : undefined
  return Response.json({ seq: out.seq, data: door ? await door() : out.data })
}
