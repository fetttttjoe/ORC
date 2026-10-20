import { readView, type ReadModel, type ViewResult } from '@orc/ui-core'
import { viewParams, type ViewName } from '@orc/ui-core/wire'

// Answers for a view the log cannot fill, consulted only when the view came back empty
export type DoorAnswers = { readonly [N in ViewName]?: () => Promise<ViewResult<N>> }

export async function viewResponse(model: ReadModel, name: string, q: string | null, whenEmpty: DoorAnswers = {}): Promise<Response> {
  const params = viewParams(q)
  if (!params.ok) return Response.json({ error: params.error }, { status: 400 })
  const out = readView(model, name, params.params)
  if (!out.ok) return Response.json({ error: out.error }, { status: out.status })
  const door = Array.isArray(out.data) && out.data.length === 0 ? whenEmpty[out.name] : undefined
  return Response.json({ seq: out.seq, data: door ? await door() : out.data })
}
