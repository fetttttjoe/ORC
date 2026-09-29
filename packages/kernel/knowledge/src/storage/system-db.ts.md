# packages/kernel/src/storage/system-db.ts

## Facts
- system-db.ts's resetSystemDatabase truncates every non-catalog table in a project's database (used by test/dev reset), while dropSystemDatabase connects to the server's /postgres admin database and DROPs the whole database WITH (force) to evict any attached connections, e.g. for deleted projects. {xyiubmqf @packages/kernel/src/storage/system-db.ts#resetSystemDatabase @packages/kernel/src/storage/system-db.ts#dropSystemDatabase #architecture-current}
