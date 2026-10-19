# packages/contracts/src/scope.ts

## Why
- packages/contracts/src/scope.ts is deliberately kept as a minimal-import leaf module because a runtime edge to ./events would pull ./knowledge (and transitively node:crypto) into the browser bundle. {3ezndexo @packages/contracts/src/scope.ts #architecture-current}
