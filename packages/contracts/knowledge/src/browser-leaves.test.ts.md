# packages/contracts/src/browser-leaves.test.ts

## Facts
- packages/contracts/src/browser-leaves.test.ts statically parses import/export edges (regex-based, following export * as a runtime edge) to assert that browser-consumed leaf modules never transitively reach a node-only dependency. {7bog2td8 @packages/contracts/src/browser-leaves.test.ts #architecture-current}
