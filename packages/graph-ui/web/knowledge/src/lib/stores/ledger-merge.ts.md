# packages/graph-ui/web/src/lib/stores/ledger-merge.ts

## Facts
- web/src/lib/stores/ledger-merge.ts's mergeOlder drops any backward-paged row at or past the currently held head seq before prepending, preventing duplicate keyed rows when a history fetch races live SSE appends. {0eg9srkg @packages/graph-ui/web/src/lib/stores/ledger-merge.ts#mergeOlder #architecture-current}
