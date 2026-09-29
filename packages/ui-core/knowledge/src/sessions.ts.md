# packages/ui-core/src/sessions.ts

## Facts
- ProjectSessions.model()/snapshot() hand the caller a LIVE ReadModel/graph rather than a copy, so consumers must consume it within the callback tick and never hold it across an await. {gj7wkazf @packages/ui-core/src/sessions.ts#ProjectSessions #architecture-current}
