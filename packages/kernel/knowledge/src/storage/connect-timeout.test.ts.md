# packages/kernel/src/storage/connect-timeout.test.ts

## Facts
- connect-timeout.test.ts starts a silent node:net TCP server that accepts connections and never writes, calls openStorage against it, and asserts the rejection arrives within CONNECT_TIMEOUT_MS + 2_000 ms and satisfies isDatabaseUnreachable. {a1rqnuuf @packages/kernel/src/storage/connect-timeout.test.ts #postgres-connect-timeout-and-unreachable}
