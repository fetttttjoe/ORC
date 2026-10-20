import { toast } from 'svelte-sonner'

// The one notification surface; tone maps onto sonner here so no caller uses a raw variant
export type Tone = 'ok' | 'warn' | 'error'

export function notify(message: string, tone: Tone = 'ok'): void {
  if (tone === 'error') toast.error(message)
  else if (tone === 'warn') toast.warning(message)
  else toast.success(message)
}
