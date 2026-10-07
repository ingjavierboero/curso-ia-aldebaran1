CREATE TABLE `job_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job` text NOT NULL,
	`period` text NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`status` text DEFAULT 'running' NOT NULL,
	`summary` text,
	CONSTRAINT "job_runs_job" CHECK("job_runs"."job" IN ('billing')),
	CONSTRAINT "job_runs_status" CHECK("job_runs"."status" IN ('running', 'ok', 'error'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `job_runs_job_period` ON `job_runs` (`job`,`period`);