# packages/ui-core/src/wire.ts

## Why
- NodeDetail is a discriminated union on the node's type, not a union with a permissive record tail, because such a tail accepts every object, so a read that stops matching the wire would no longer fail the build. {on6d3x3n @packages/ui-core/src/wire.ts#NodeDetail}
