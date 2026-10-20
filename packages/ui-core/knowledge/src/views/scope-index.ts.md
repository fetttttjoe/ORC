# packages/ui-core/src/views/scope-index.ts

## Why
- scopePatternsOf names only the event's own project, workspace, task and chat, since naming another chat puts every chat pane on that chat's cadence; a subtree query over an ancestor is not matched because no consumer issues one yet. {dgbjwwa2 @packages/ui-core/src/views/scope-index.ts#scopePatternsOf}
