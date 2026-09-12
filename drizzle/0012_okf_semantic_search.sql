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
