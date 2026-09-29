# packages/graph-ui/web/src/lib/features/graph/colors.ts

## Why
- The browser's sigma graph island hardcodes node/edge colors in web/src/lib/features/graph/colors.ts (TYPE_COLORS, STATUS_COLORS) because a WebGL canvas cannot read CSS custom properties, with live status overrides (failed/blocked/running/cancelled) taking precedence over the resting type color. {24b21z79 @packages/graph-ui/web/src/lib/features/graph/colors.ts#STATUS_COLORS #architecture-current}
