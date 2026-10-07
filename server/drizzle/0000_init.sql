CREATE TABLE `client_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`client_id` integer NOT NULL,
	`event` text NOT NULL,
	`occurred_at` integer NOT NULL,
	`invoice_id` integer,
	`email_id` integer,
	`detail` text,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`invoice_id`) REFERENCES `invoices`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`email_id`) REFERENCES `inbound_emails`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "client_history_event" CHECK("client_history"."event" IN ('invoice_email_sent', 'email_received', 'email_processed', 'reminder_sent'))
);
--> statement-breakpoint
CREATE INDEX `client_history_client` ON `client_history` (`client_id`,`occurred_at`);--> statement-breakpoint
CREATE TABLE `client_systems` (
	`client_id` integer NOT NULL,
	`system_id` integer NOT NULL,
	`assigned_at` integer NOT NULL,
	PRIMARY KEY(`client_id`, `system_id`),
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`system_id`) REFERENCES `systems`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE TABLE `clients` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`business_name` text NOT NULL,
	`cuit` text NOT NULL,
	`email` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "clients_cuit_format" CHECK(length("clients"."cuit") = 11 AND "clients"."cuit" NOT GLOB '*[^0-9]*'),
	CONSTRAINT "clients_email_lowercase" CHECK("clients"."email" = lower("clients"."email")),
	CONSTRAINT "clients_status" CHECK("clients"."status" IN ('active', 'inactive'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `clients_email_unique` ON `clients` (`email`);--> statement-breakpoint
CREATE UNIQUE INDEX `clients_cuit_unique` ON `clients` (`cuit`);--> statement-breakpoint
CREATE TABLE `email_attachments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`email_id` integer NOT NULL,
	`filename` text NOT NULL,
	`content_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`content` blob NOT NULL,
	FOREIGN KEY (`email_id`) REFERENCES `inbound_emails`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `email_attachments_email` ON `email_attachments` (`email_id`);--> statement-breakpoint
CREATE TABLE `exchange_rates` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`rate_cents` integer NOT NULL,
	`source` text NOT NULL,
	`fetched_at` integer NOT NULL,
	CONSTRAINT "exchange_rates_positive" CHECK("exchange_rates"."rate_cents" > 0)
);
--> statement-breakpoint
CREATE INDEX `exchange_rates_fetched_at` ON `exchange_rates` (`fetched_at`);--> statement-breakpoint
CREATE TABLE `inbound_emails` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`message_id` text NOT NULL,
	`from_address` text NOT NULL,
	`subject` text DEFAULT '' NOT NULL,
	`received_at` integer NOT NULL,
	`client_id` integer,
	`has_attachments` integer NOT NULL,
	`processing_status` text DEFAULT 'pending' NOT NULL,
	`classification` text,
	`extracted_cuit` text,
	`extracted_amount_cents` integer,
	`processing_error` text,
	`processed_at` integer,
	`notice_status` text,
	`notice_reviewed_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "inbound_emails_processing" CHECK("inbound_emails"."processing_status" IN ('pending', 'processed', 'error')),
	CONSTRAINT "inbound_emails_classification" CHECK("inbound_emails"."classification" IS NULL OR "inbound_emails"."classification" IN ('si', 'no', 'dudoso')),
	CONSTRAINT "inbound_emails_notice" CHECK("inbound_emails"."notice_status" IS NULL OR "inbound_emails"."notice_status" IN ('pending', 'reviewed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `inbound_emails_message_id` ON `inbound_emails` (`message_id`);--> statement-breakpoint
CREATE INDEX `inbound_emails_client` ON `inbound_emails` (`client_id`);--> statement-breakpoint
CREATE INDEX `inbound_emails_notice` ON `inbound_emails` (`notice_status`);--> statement-breakpoint
CREATE TABLE `invoice_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`invoice_id` integer NOT NULL,
	`system_id` integer,
	`description` text NOT NULL,
	`currency` text NOT NULL,
	`unit_price_cents` integer NOT NULL,
	`amount_cents` integer NOT NULL,
	FOREIGN KEY (`invoice_id`) REFERENCES `invoices`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`system_id`) REFERENCES `systems`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "invoice_items_currency" CHECK("invoice_items"."currency" IN ('ARS', 'USD'))
);
--> statement-breakpoint
CREATE INDEX `invoice_items_invoice` ON `invoice_items` (`invoice_id`);--> statement-breakpoint
CREATE TABLE `invoice_payment_emails` (
	`invoice_id` integer NOT NULL,
	`email_id` integer NOT NULL,
	`linked_at` integer NOT NULL,
	`resolved_at` integer,
	PRIMARY KEY(`invoice_id`, `email_id`),
	FOREIGN KEY (`invoice_id`) REFERENCES `invoices`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`email_id`) REFERENCES `inbound_emails`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `invoices` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`client_id` integer NOT NULL,
	`period` text NOT NULL,
	`invoice_type` integer DEFAULT 11 NOT NULL,
	`point_of_sale` integer NOT NULL,
	`number` integer NOT NULL,
	`cae` text NOT NULL,
	`cae_expires_at` text NOT NULL,
	`issued_at` integer NOT NULL,
	`client_business_name` text NOT NULL,
	`client_cuit` text NOT NULL,
	`total_cents` integer NOT NULL,
	`exchange_rate_cents` integer,
	`exchange_rate_source` text,
	`exchange_rate_at` integer,
	`exchange_rate_fallback` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'pending_payment' NOT NULL,
	`review_reason` text,
	`status_changed_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "invoices_period_format" CHECK("invoices"."period" GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'),
	CONSTRAINT "invoices_total" CHECK("invoices"."total_cents" > 0),
	CONSTRAINT "invoices_status" CHECK("invoices"."status" IN ('pending_payment', 'payment_received', 'manual_review', 'paid')),
	CONSTRAINT "invoices_review_reason" CHECK(("invoices"."status" = 'manual_review') = ("invoices"."review_reason" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX `invoices_client_period` ON `invoices` (`client_id`,`period`);--> statement-breakpoint
CREATE INDEX `invoices_status` ON `invoices` (`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `invoices_number_unique` ON `invoices` (`invoice_type`,`point_of_sale`,`number`);--> statement-breakpoint
CREATE TABLE `process_errors` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`operation` text NOT NULL,
	`client_id` integer,
	`invoice_id` integer,
	`period` text,
	`attempts` integer NOT NULL,
	`last_error` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`resolved_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`invoice_id`) REFERENCES `invoices`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "process_errors_operation" CHECK("process_errors"."operation" IN ('invoice_generation', 'invoice_email', 'reminder_email', 'mailbox_check')),
	CONSTRAINT "process_errors_status" CHECK("process_errors"."status" IN ('pending', 'resolved')),
	CONSTRAINT "process_errors_attempts" CHECK("process_errors"."attempts" >= 1)
);
--> statement-breakpoint
CREATE INDEX `process_errors_status` ON `process_errors` (`status`);--> statement-breakpoint
CREATE TABLE `settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`mailbox_interval_minutes` integer DEFAULT 15 NOT NULL,
	`billing_time` text DEFAULT '11:00' NOT NULL,
	`reminder_time` text DEFAULT '11:00' NOT NULL,
	`retry_count` integer DEFAULT 3 NOT NULL,
	`retry_wait_minutes` integer DEFAULT 5 NOT NULL,
	`point_of_sale` integer DEFAULT 1 NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "settings_singleton" CHECK("settings"."id" = 1),
	CONSTRAINT "settings_mailbox_interval" CHECK("settings"."mailbox_interval_minutes" BETWEEN 5 AND 60),
	CONSTRAINT "settings_billing_time" CHECK("settings"."billing_time" GLOB '[0-2][0-9]:[0-5][0-9]' AND "settings"."billing_time" BETWEEN '00:00' AND '23:39'),
	CONSTRAINT "settings_reminder_time" CHECK("settings"."reminder_time" GLOB '[0-2][0-9]:[0-5][0-9]' AND "settings"."reminder_time" BETWEEN '00:00' AND '23:39'),
	CONSTRAINT "settings_retry_count" CHECK("settings"."retry_count" BETWEEN 0 AND 10),
	CONSTRAINT "settings_retry_wait" CHECK("settings"."retry_wait_minutes" BETWEEN 1 AND 60),
	CONSTRAINT "settings_point_of_sale" CHECK("settings"."point_of_sale" BETWEEN 1 AND 99999)
);
--> statement-breakpoint
CREATE TABLE `systems` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`price_cents` integer NOT NULL,
	`currency` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "systems_price" CHECK("systems"."price_cents" > 0),
	CONSTRAINT "systems_currency" CHECK("systems"."currency" IN ('ARS', 'USD')),
	CONSTRAINT "systems_status" CHECK("systems"."status" IN ('active', 'inactive'))
);
