import { toast } from 'svelte-sonner'

/**
 * The one notification surface. Tone is the vocabulary the rest of the app already speaks
 * (ok / warn / error), mapped onto sonner here so no caller reaches for a raw toast variant.
 */
export type Tone = 'ok' | 'warn' | 'error'

export function notify(message: string, tone: Tone = 'ok'): void {
  if (tone === 'error') toast.error(message)
  else if (tone === 'warn') toast.warning(message)
  else toast.success(message)
}
