# packages/knowledge-core/src/tools.test.ts

## Facts
- tools.test.ts has a test that scans every resolved tool's description for /\bknowledge_[a-z]+\b/ matches and asserts each is a value of KnowledgeToolName; this does not catch a hardcoded literal that happens to equal a valid tool name (e.g. a literal 'knowledge_card' string still passes), only a knowledge_* name in a description that is not a KnowledgeToolName value, such as a misspelled or renamed/removed tool. {jsuosbpz @packages/knowledge-core/src/tools.test.ts #knowledge #test}
