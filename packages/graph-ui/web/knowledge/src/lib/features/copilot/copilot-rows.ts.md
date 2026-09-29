# packages/graph-ui/web/src/lib/features/copilot/copilot-rows.ts

## Why
- web/src/lib/features/copilot/copilot-rows.ts's restoredRows builds copilot conversation-card ids as `${seq}:u`/`${seq}:a`/`${seq}:t{i}` per exchange, replacing an earlier numeric id scheme that collided across exchanges and tool calls. {pi9f1nke @packages/graph-ui/web/src/lib/features/copilot/copilot-rows.ts#restoredRows #architecture-current}
