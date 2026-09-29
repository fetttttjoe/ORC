# plugins/memory/src/index.ts

## Facts
- createMemory in plugins/memory/src/index.ts is the composition root that opens SurrealMemory via openKnowledge and assembles the store, projector, bindStep and knowledge handle; business logic never opens a Surreal session itself. {5bc5ocey @plugins/memory/src/index.ts#createMemory @plugins/memory/src/knowledge.ts#openKnowledge #architecture-current}
