// oauth.ts and cache.ts share this seam so the preconnect shim is spelled once

export type MinimalFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

// the SDK only calls the call signature, so a noop preconnect satisfies the type
export function asFetch(wrapped: MinimalFetch): typeof fetch {
  return Object.assign(wrapped, { preconnect: () => {} })
}
