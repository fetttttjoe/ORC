# packages/contracts/src/scope.ts

## Why
- packages/contracts/src/scope.ts is deliberately kept as a minimal-import leaf module because a runtime edge to ./events would pull ./memory and ./claim (and transitively node:crypto) into the browser bundle. {3ezndexo @packages/contracts/src/scope.ts #architecture-current}
