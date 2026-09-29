# packages/vault-projector/src/plan-md.ts

## Facts
- parsePlanFile in packages/vault-projector/src/plan-md.ts is the inverse of renderPlanFile: it extracts the frontmatter fence, parses it as YAML, and validates it against PlanDraft from @orc/contracts, supporting `orc edit --from-vault` round-tripping of hand-edited plan frontmatter. {jr5wix20 @packages/vault-projector/src/plan-md.ts#parsePlanFile @packages/vault-projector/src/plan-md.ts#renderPlanFile #architecture-current}
