# packages/ui-core/src/sessions.ts

## Facts
- ProjectSessions.model()/snapshot() hand the caller a LIVE ReadModel/graph rather than a copy, so consumers must consume it within the callback tick and never hold it across an await. {gj7wkazf @packages/ui-core/src/sessions.ts#ProjectSessions #architecture-current}

## Why
- A session model is live and coherent only within the tick it was taken in, because holding one across an await pairs a seq read before with rows read after, so a client told it is current at 41 holding rows to 43 never refetches 42 and 43. {055qzgp6 @packages/ui-core/src/sessions.ts#ProjectSessions}
- SessionUpdate hands subscribers the model as of its seq instead of letting them fetch one, since a self-fetched model matches the frame only while the event pump happens to be serial. {sfhp6s9w @packages/ui-core/src/sessions.ts#SessionUpdate}
- The session checks the oldest cached row against the log on each event because the log can be truncated out of band (purge, chat deletion) with no event announcing it, and the server would otherwise keep folding deleted history. {yjanelhk @packages/ui-core/src/sessions.ts#createProjectSessions}
