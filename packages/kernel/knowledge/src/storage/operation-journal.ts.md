# packages/kernel/src/storage/operation-journal.ts

## Facts
- OperationJournal keeps the operations table as a derived, rebuildable index over the append-only operation_started/operation_completed/operation_failed events; rebuildOperations() truncates and refolds it per project via foldOperations, and beginOperation/completeOperation/failOperation each append their transition event and upsert the row inside the same withProjectLock transaction. {p70zltr7 @packages/kernel/src/storage/operation-journal.ts#OperationJournal.rebuildOperations @packages/kernel/src/storage/operation-journal.ts#OperationJournal.beginOperation #architecture-current}
