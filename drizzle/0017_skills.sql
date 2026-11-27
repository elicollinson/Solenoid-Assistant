CREATE TABLE `skills` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`title` text NOT NULL,
	`description` text NOT NULL,
	`instructions` text NOT NULL,
	`tool_groups` text NOT NULL,
	`slash_command` integer DEFAULT true NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`source` text DEFAULT 'user' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "skills_source_check" CHECK("skills"."source" in ('builtin','user'))
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `skills_slug_unique` ON `skills` (`slug`);--> statement-breakpoint
CREATE INDEX `skills_enabled_slug` ON `skills` (`enabled`,`slug`);
