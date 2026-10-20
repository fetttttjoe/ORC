# packages/graph-ui/web/src/lib/api/types.ts

## Why
- The wire guards use SameKeys beside Exact, because Exact holds when one side gains an optional property, so a new field is silently stripped by the parser while the build passes. {a05k76qc @packages/graph-ui/web/src/lib/api/types.ts#SameKeys}
