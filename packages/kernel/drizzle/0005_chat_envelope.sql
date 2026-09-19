ALTER TABLE "events" ADD COLUMN "chat_id" text;--> statement-breakpoint
-- NOT NULL with no DEFAULT on purpose: a door invented for rows that never named one would be a
-- fact nobody wrote, and every chatless event would read as a CLI call.
ALTER TABLE "events" ADD COLUMN "door" text NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_events_project_chat_seq" ON "events" USING btree ("project_id","chat_id","seq");
