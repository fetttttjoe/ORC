# packages/graph-ui/web/src/lib/api/touch-coalesce.ts

## Why
- The coalescer fires once, windowMs after the last schedule for a key rather than the first, because firing on the first touch of a burst leaves the rest to invalidate the refetch already in flight. {i11zqdty @packages/graph-ui/web/src/lib/api/touch-coalesce.ts#makeCoalescer}
