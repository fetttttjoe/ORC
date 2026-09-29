# plugins/mcp-client/src/net-guard.ts

## Facts
- plugins/mcp-client/src/net-guard.ts's fetchPublic re-runs assertPublicUrl (protocol, credentials, DNS-resolved private/reserved IP ranges) on every redirect hop up to MAX_REDIRECTS=5, so a public URL cannot redirect into a private/intranet address. {68snjqbx @plugins/mcp-client/src/net-guard.ts#fetchPublic #architecture-current}
