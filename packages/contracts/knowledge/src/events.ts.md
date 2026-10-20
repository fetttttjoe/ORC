# packages/contracts/src/events.ts

## Facts
- packages/contracts/src/events.ts's PAYLOAD_SCHEMAS constant is the single authoritative map from each EventKind to its zod payload schema, used to validate every event appended to the log. {oarv6bay @packages/contracts/src/events.ts#PAYLOAD_SCHEMAS #architecture-current}

## Why
- A supervisor reaction that throws is recorded as a reaction_failed event rather than only logged, so 'nobody could start this' shows in the event feed and the projection instead of reading as a hang. {5uypfulz @packages/contracts/src/events.ts#Reaction}
