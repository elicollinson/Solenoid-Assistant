CREATE TABLE `dream_checkpoints` (
	`root` text PRIMARY KEY NOT NULL,
	`cursor` integer DEFAULT 0 NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE `okf_write_locks` (
	`resource` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`pid` integer NOT NULL,
	`acquired_at` integer NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE `okf_writes` (
	`id` text PRIMARY KEY NOT NULL,
	`tool` text NOT NULL,
	`actor` text NOT NULL,
	`execution` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`payload` text,
	`digest` text,
	`inverse_of` text,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`refresh_pending` integer DEFAULT 0 NOT NULL
) STRICT;
--> statement-breakpoint
CREATE INDEX `okf_writes_expiry` ON `okf_writes` (`expires_at`);--> statement-breakpoint
CREATE TABLE `okf_embedding_usage` (
	`day` text PRIMARY KEY NOT NULL,
	`reserved_tokens` integer NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE `okf_search_chunks` (
	`scope` text NOT NULL,
	`concept_id` text NOT NULL,
	`config_id` text NOT NULL,
	`input_hash` text NOT NULL,
	`input` text NOT NULL,
	`excerpt` text NOT NULL,
	`vector` blob,
	`state` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt` integer DEFAULT 0 NOT NULL,
	`owner` text,
	`lease_until` integer DEFAULT 0 NOT NULL,
	`error` text,
	PRIMARY KEY(`scope`, `concept_id`, `config_id`, `input_hash`)
) STRICT;
--> statement-breakpoint
CREATE TABLE `okf_search_documents` (
	`scope` text NOT NULL,
	`concept_id` text NOT NULL,
	`source_hash` text NOT NULL,
	`approved_config` text,
	`title` text NOT NULL,
	`header` text NOT NULL,
	`body` text NOT NULL,
	`frontmatter` text NOT NULL,
	PRIMARY KEY(`scope`, `concept_id`)
) STRICT;
--> statement-breakpoint
CREATE TABLE `okf_search_scopes` (
	`scope` text PRIMARY KEY NOT NULL,
	`initialized_at` integer NOT NULL
) STRICT;
