CREATE TABLE `source_candidates` (
	`hash` text PRIMARY KEY NOT NULL,
	`extension` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`retry_at` integer DEFAULT 0 NOT NULL,
	`lease_until` integer DEFAULT 0 NOT NULL,
	`classification` text
) STRICT;
--> statement-breakpoint
CREATE TABLE `source_changes` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`id` text NOT NULL,
	`payload` text,
	`occurred` text NOT NULL,
	`revision` text NOT NULL,
	`deleted` integer NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE `source_meta` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE `source_photo_candidates` (
	`id` text PRIMARY KEY NOT NULL,
	`hash` text NOT NULL,
	`payload` text NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE `source_processed` (
	`id` text PRIMARY KEY NOT NULL,
	`payload` text NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE `source_records` (
	`kind` text NOT NULL,
	`id` text NOT NULL,
	`payload` text,
	`occurred` text NOT NULL,
	`revision` text NOT NULL,
	`deleted` integer DEFAULT 0 NOT NULL,
	`seq` integer NOT NULL,
	PRIMARY KEY(`kind`, `id`)
) STRICT;
--> statement-breakpoint
CREATE INDEX `source_records_seq` ON `source_records` (`seq`);--> statement-breakpoint
CREATE TABLE `source_status` (
	`kind` text PRIMARY KEY NOT NULL,
	`collected_at` text NOT NULL,
	`coverage_from` text NOT NULL,
	`coverage_to` text NOT NULL
) STRICT;
