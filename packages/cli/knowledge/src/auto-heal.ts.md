# packages/cli/src/auto-heal.ts

## Facts
- sweepSpec in packages/cli/src/auto-heal.ts builds the auditor step's instructions string for an auto-drafted knowledge sweep: it lists up to SWEEP_LISTED_IDS (50) suspect claims with their id/anchors/location, names the folder-anchor rule once, tells the auditor that a claim stating a number (a count, a size, a limit) holds only after the auditor recounts that exact number in the code and otherwise must be corrected, and tells the auditor to call KnowledgeToolName.check with {id, verdict, why} using CheckVerdict.holds/false(+patch)/unknown. {rywfdjkp @packages/cli/src/auto-heal.ts#sweepSpec #auto-heal #knowledge-check #pin-a-numeric-claim-recount-rule-into-sw}

## Why
- The numeric-claim recount rule exists in sweepSpec because an auto-heal sweep once held a claim whose stated count had gone stale — it said the contracts index re-exports 41 submodules when the file had 42 — because the auditor accepted the stated number without recounting it; a count goes stale whenever an item is added, so the auditor must recount the exact number in the code before holding such a claim. {3syocygp @packages/cli/src/auto-heal.ts#sweepSpec #auto-heal #knowledge-check #pin-a-numeric-claim-recount-rule-into-sw}
