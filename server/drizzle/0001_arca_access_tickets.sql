CREATE TABLE `arca_access_tickets` (
	`service` text PRIMARY KEY NOT NULL,
	`token` text NOT NULL,
	`sign` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL
);
