# packages/ui-core/src/copilot.ts

## Facts
- The copilot agent built by ui-core/src/copilot.ts is given the same OrcActions and view-registry reads the rest of the UI uses, so it can never perform an action the UI itself could not. {ynruk4vf @packages/ui-core/src/copilot.ts#buildCopilotTools #architecture-current}

## Why
- asResolvedTools parses input itself because the MCP door calls execute with raw client JSON while the web door's SDK has already safeParsed, and every mutating tool destructures assuming parsed arguments. {ycmo0hl7 @packages/ui-core/src/copilot.ts#asResolvedTools}
