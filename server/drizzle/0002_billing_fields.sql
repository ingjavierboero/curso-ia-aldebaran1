-- Escrita a mano (no con drizzle-kit): la generada recreaba `clients` borrando la tabla, lo que
-- dentro de la transacción de la migración arrastra en cascada asignaciones e historial.

-- Condición frente al IVA del cliente (RF-114). Admite null por los clientes ya cargados.
ALTER TABLE `clients` ADD `vat_condition_id` integer CONSTRAINT "clients_vat_condition" CHECK("vat_condition_id" IS NULL OR "vat_condition_id" IN (1, 4, 5, 6, 7, 8, 9, 10, 13, 15, 16));
--> statement-breakpoint
-- Condición de IVA y fechas fiscales de la factura (RF-115 a RF-117). Se recrea la tabla para
-- poder agregar columnas NOT NULL; ninguna versión anterior generaba facturas, así que está vacía.
-- Si tuviera filas, el INSERT falla por NOT NULL y la migración se revierte sin tocar nada.
CREATE TABLE `__new_invoices` (
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
	`client_vat_condition_id` integer NOT NULL,
	`issue_date` text NOT NULL,
	`service_from` text NOT NULL,
	`service_to` text NOT NULL,
	`payment_due_date` text NOT NULL,
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
	CONSTRAINT "invoices_period_format" CHECK("period" GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'),
	CONSTRAINT "invoices_total" CHECK("total_cents" > 0),
	CONSTRAINT "invoices_status" CHECK("status" IN ('pending_payment', 'payment_received', 'manual_review', 'paid')),
	CONSTRAINT "invoices_review_reason" CHECK(("status" = 'manual_review') = ("review_reason" IS NOT NULL))
);
--> statement-breakpoint
INSERT INTO `__new_invoices`("id", "client_id", "period", "invoice_type", "point_of_sale", "number", "cae", "cae_expires_at", "issued_at", "client_business_name", "client_cuit", "total_cents", "exchange_rate_cents", "exchange_rate_source", "exchange_rate_at", "exchange_rate_fallback", "status", "review_reason", "status_changed_at", "created_at", "updated_at") SELECT "id", "client_id", "period", "invoice_type", "point_of_sale", "number", "cae", "cae_expires_at", "issued_at", "client_business_name", "client_cuit", "total_cents", "exchange_rate_cents", "exchange_rate_source", "exchange_rate_at", "exchange_rate_fallback", "status", "review_reason", "status_changed_at", "created_at", "updated_at" FROM `invoices`;
--> statement-breakpoint
DROP TABLE `invoices`;
--> statement-breakpoint
ALTER TABLE `__new_invoices` RENAME TO `invoices`;
--> statement-breakpoint
CREATE INDEX `invoices_client_period` ON `invoices` (`client_id`,`period`);
--> statement-breakpoint
CREATE INDEX `invoices_status` ON `invoices` (`status`);
--> statement-breakpoint
CREATE UNIQUE INDEX `invoices_number_unique` ON `invoices` (`invoice_type`,`point_of_sale`,`number`);
