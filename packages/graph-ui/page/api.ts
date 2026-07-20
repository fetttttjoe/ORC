// The action client: one session fetch at boot, one act() for every mutation. The token is the
// CSRF guard — a cross-origin page can neither read it (CORS) nor send the custom header.
export interface Session { actions: boolean; token: string; defaultCwd: string | null }

export let session: Session = { actions: false, token: '', defaultCwd: null }

export async function initSession(): Promise<void> {
  session = await (await fetch('/api/session')).json()
}

export async function act<T = unknown>(name: string, body: unknown): Promise<T> {
  const res = await fetch(`/api/actions/${name}`, {
    method: 'POST',
    headers: { 'x-orc-token': session.token, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data: unknown = await res.json().catch(() => ({}))
  if (!res.ok) {
    const message = data !== null && typeof data === 'object' && 'error' in data ? String(data.error) : `HTTP ${res.status}`
    throw new Error(message)
  }
  return data as T
}
