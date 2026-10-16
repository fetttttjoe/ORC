# packages/contracts/src/knowledge.ts

## Facts
- knowledge_check's contract (packages/contracts/src/knowledge.ts: CheckVerdict, KnowledgeCheckFields, KnowledgeCheckInput) only enforces that verdict 'false' carries a patch that retires or changes the claim (correctsClaim) and that 'holds'/'unknown' carry none; it has no numeric-specific rule, so any requirement that a numeric claim be re-counted before it is held must live in the sweep step's natural-language instructions (sweepSpec), not in the tool schema. {tsmi2wfj @packages/contracts/src/knowledge.ts#KnowledgeCheckInput @packages/cli/src/auto-heal.ts#sweepSpec #auto-heal #knowledge-check}
- Consumers reach knowledge only through the knowledge port. {j7ry1ja0 @packages/contracts/src/knowledge.ts#KnowledgePort #knowledge}
