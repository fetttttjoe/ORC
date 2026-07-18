CREATE TABLE "operations" (
	"project_id" text NOT NULL,
	"operation_id" text NOT NULL,
	"task_id" text NOT NULL,
	"step_id" text NOT NULL,
	"run_token" text NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"status" text NOT NULL,
	"attempts" integer NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"error" jsonb,
	"started_seq" bigint NOT NULL,
	"finished_seq" bigint,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "operations_project_id_operation_id_pk" PRIMARY KEY("project_id","operation_id")
);
--> statement-breakpoint
DROP INDEX "idx_events_task";--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "project_id" text;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
UPDATE "events" SET "project_id" = 'legacy';--> statement-breakpoint
ALTER TABLE "events" ALTER COLUMN "project_id" SET NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_operations_project_task_started" ON "operations" USING btree ("project_id","task_id","started_seq");--> statement-breakpoint
CREATE INDEX "idx_operations_project_run_started" ON "operations" USING btree ("project_id","run_token","started_seq");--> statement-breakpoint
CREATE INDEX "idx_events_project_seq" ON "events" USING btree ("project_id","seq");--> statement-breakpoint
CREATE INDEX "idx_events_project_task_seq" ON "events" USING btree ("project_id","task_id","seq");--> statement-breakpoint
CREATE INDEX "idx_events_project_kind_seq" ON "events" USING btree ("project_id","kind","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_events_project_idempotency" ON "events" USING btree ("project_id","idempotency_key") WHERE "events"."idempotency_key" IS NOT NULL;