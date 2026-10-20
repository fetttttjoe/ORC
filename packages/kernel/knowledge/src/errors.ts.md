# packages/kernel/src/errors.ts

## Facts
- errors.ts's isDatabaseUnreachable (renamed from isConnectionRefused) also recognises pg's three connect-timeout error messages by exact text match since those errors carry no .code: 'Connection terminated due to connection timeout' (Pool dialing a fresh client), 'timeout exceeded when trying to connect' (Pool, all clients busy), and 'timeout expired' (a bare Client's own connectionTimeoutMillis) — confirmed against pg@8.22's bundled source (pg-pool/index.js, pg/lib/client.js) and by a live test connecting to a silent TCP server. {nwf0v3p9 @packages/kernel/src/errors.ts#isDatabaseUnreachable #architecture-current #postgres-connect-timeout-and-unreachable}
