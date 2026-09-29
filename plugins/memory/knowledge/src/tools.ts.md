# plugins/memory/src/tools.ts

## Facts
- plugins/memory's tools.ts accepts a `zone` field on plan-tier memory notes and validates only its shape (via contracts' planFieldViolations); it does not itself enforce write containment — the write-time guard lives entirely in executor-api-loop. {g6qqg44m @plugins/memory/src/tools.ts #fact}
- The memory plugin's write-side advisory checks (noteLint, unresolvedLinks, duplicateSubjectWarning, planSiblings) in plugins/memory/src/tools.ts warn rather than refuse for judgment issues, while plan-field SHAPE violations from contracts' planFieldViolations refuse the write outright. {hc8ypp8s @plugins/memory/src/tools.ts#unresolvedLinks #architecture-current}
