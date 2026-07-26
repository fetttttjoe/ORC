-- store.write needs the latest event for ONE note as its merge base. Without this it folded the
-- project's whole memory history to find it, inside the project advisory lock.
--
-- The two kinds carry the note address at different paths (memory_written nests it under `note`,
-- memory_deleted has it flat), so both the index and the query COALESCE across them — the
-- expressions must match exactly or the planner ignores the index.
CREATE INDEX IF NOT EXISTS "idx_events_note_seq" ON "events" (
  "project_id",
  (COALESCE("payload"->'note'->>'scope', "payload"->>'scope')),
  (COALESCE("payload"->'note'->>'id', "payload"->>'id')),
  "seq" DESC
) WHERE "kind" IN ('memory_written', 'memory_deleted');
