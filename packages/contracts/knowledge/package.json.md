# packages/contracts/package.json

## Facts
- packages/contracts declares only the zod npm dependency in package.json and no @orc/* workspace dependency, making it the leaf/seam package every other orc package can safely import. {4j9mb312 @packages/contracts/package.json #architecture-current}
- packages/contracts is the only package with zero @orc/* workspace dependencies, making it the seam every other package (kernel, knowledge-core, knowledge-git, executor-api-loop, providers, cli, ui-core, graph-ui, vault-projector) imports its shared TaskNode/Plan/Event/Knowledge/Scope/Execution vocabulary from. {lhv2lnox @packages/contracts/package.json @packages/contracts/src/index.ts #architecture-current}
