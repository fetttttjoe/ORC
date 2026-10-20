# packages/kernel/src/redact.ts

## Facts
- redact.ts's buildRedactor is the single storage-boundary normalizer applied to every event payload: it strips embedded NUL bytes (Postgres jsonb rejects \u0000, error 22P05) and replaces values of keys matching SENSITIVE_KEY_SUFFIXES (e.g. apiKey, password, secret, cookie, refreshToken) with '[REDACTED]', plus string-replaces any matching env-var value (name ending _KEY/_TOKEN/_SECRET/_PASSWORD, length>=8) with '[REDACTED:name]'. {41jhmw8c @packages/kernel/src/redact.ts#buildRedactor #architecture-current}

## Why
- A secret minted during a run (a tool returning a fresh credential) is caught only by key, never by value, because value matching sees only process.env. {nnndzkmu @packages/kernel/src/redact.ts#SENSITIVE_KEY_SUFFIXES}
