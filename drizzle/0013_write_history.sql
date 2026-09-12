CREATE TABLE `dream_checkpoints` (
  `root` text PRIMARY KEY NOT NULL,
  `cursor` integer DEFAULT 0 NOT NULL,
  `hashes` text NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE `write_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`operation_id` text NOT NULL,
	`kind` text NOT NULL,
	`code` text,
	`at` integer NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE `write_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`parent_id` text,
	`tool` text NOT NULL,
	`origin` text NOT NULL,
	`actor` text NOT NULL,
	`run_id` text,
	`workflow_id` text,
	`idempotency_key` text NOT NULL,
	`execution` text NOT NULL,
	`response` text NOT NULL,
	`capability` text DEFAULT 'unknown' NOT NULL,
	`inverse_of` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`expires_at` integer
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `write_execution_key` ON `write_operations` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `write_history_time` ON `write_operations` (`created_at`);--> statement-breakpoint
CREATE TABLE `write_payloads` (
	`operation_id` text PRIMARY KEY NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`cipher` text NOT NULL,
	`expires_at` integer NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE `write_plans` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`operation_id` text,
	`digest` text NOT NULL,
	`cipher` text NOT NULL,
	`state` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`applied_operation_id` text
) STRICT;
--> statement-breakpoint
CREATE TABLE `write_reconciliations` (
	`operation_id` text PRIMARY KEY NOT NULL,
	`root` text NOT NULL,
	`concepts` text NOT NULL,
	`state` text NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE `write_resource_locks` (
	`resource` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`pid` integer NOT NULL,
	`acquired_at` integer NOT NULL
) STRICT;
