// The one place a wrapped fetch becomes the SDK's fetch type — oauth.ts and cache.ts both
// inject at this seam and must not each re-spell the preconnect shim.

export type MinimalFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

// createAnthropic's fetch type is the full global signature (incl. preconnect); the SDK only
// ever invokes the call signature, so a noop preconnect satisfies the type honestly.
export function asFetch(wrapped: MinimalFetch): typeof fetch {
  return Object.assign(wrapped, { preconnect: () => {} })
}
