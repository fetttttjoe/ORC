CREATE TABLE `events` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`task_id` text NOT NULL,
	`step_id` text,
	`run_token` text,
	`kind` text NOT NULL,
	`payload` text NOT NULL,
	`ts` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_events_task` ON `events` (`task_id`);