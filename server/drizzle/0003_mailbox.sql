CREATE TABLE `mailbox_checks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`status` text DEFAULT 'running' NOT NULL,
	`emails_detected` integer DEFAULT 0 NOT NULL,
	`error` text,
	CONSTRAINT "mailbox_checks_status" CHECK("mailbox_checks"."status" IN ('running', 'ok', 'error'))
);
--> statement-breakpoint
CREATE INDEX `mailbox_checks_started` ON `mailbox_checks` (`started_at`);--> statement-breakpoint
CREATE TABLE `mailbox_state` (
	`id` integer PRIMARY KEY NOT NULL,
	`uid_validity` text NOT NULL,
	`last_uid` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "mailbox_state_singleton" CHECK("mailbox_state"."id" = 1)
);
