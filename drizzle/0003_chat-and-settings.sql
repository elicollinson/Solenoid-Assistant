CREATE TABLE `surface_notes` (
	`id` text PRIMARY KEY NOT NULL,
	`screen` text NOT NULL,
	`surface` text NOT NULL,
	`slot` text NOT NULL,
	`on_date` text,
	`text` text NOT NULL,
	`generated_at` integer NOT NULL,
	`model` text,
	CONSTRAINT "surface_notes_screen_check" CHECK("surface_notes"."screen" in ('home','chat','activity','workflows','calendar','reminders','knowledge','recommendations','settings')),
	CONSTRAINT "surface_notes_surface_check" CHECK("surface_notes"."surface" in ('desktop','phone')),
	CONSTRAINT "surface_notes_slot_check" CHECK("surface_notes"."slot" in ('line','restraint','gate_title','gate_body'))
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `surface_notes_dated` ON `surface_notes` (`screen`,`surface`,`slot`,`on_date`) WHERE "surface_notes"."on_date" is not null;
--> statement-breakpoint
CREATE UNIQUE INDEX `surface_notes_standing` ON `surface_notes` (`screen`,`surface`,`slot`) WHERE "surface_notes"."on_date" is null;
--> statement-breakpoint
CREATE INDEX `surface_notes_by_date` ON `surface_notes` (`on_date`,`screen`);
--> statement-breakpoint
CREATE TABLE `agent_turns` (
	`message_id` text PRIMARY KEY NOT NULL,
	`decision_id` text,
	`run_id` text,
	`tool_summary` text,
	`note` text,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`decision_id`) REFERENCES `decisions`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`run_id`) REFERENCES `workflow_runs`(`id`) ON UPDATE no action ON DELETE set null
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_turns_decision` ON `agent_turns` (`decision_id`) WHERE "agent_turns"."decision_id" is not null;
--> statement-breakpoint
CREATE INDEX `agent_turns_run` ON `agent_turns` (`run_id`);
--> statement-breakpoint
PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE TABLE `__new_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text,
	`source` text DEFAULT 'default' NOT NULL,
	`hint` text,
	`updated_at` integer NOT NULL,
	`updated_by` text,
	CONSTRAINT "settings_source_check" CHECK("source" in ('default','env','user'))
) STRICT;
--> statement-breakpoint
INSERT INTO `__new_settings`("key", "value", "source", "updated_at", "updated_by")
-- Everything already in the store was put there by the seed, which is the
-- agent writing its own copy rather than you configuring anything. 'default'
-- is the honest provenance for all of it; the four screen ledes leave for
-- surface_notes in the next migration.
SELECT "key", "value", 'default', "updated_at", NULL FROM `settings`;
--> statement-breakpoint
DROP TABLE `settings`;
--> statement-breakpoint
ALTER TABLE `__new_settings` RENAME TO `settings`;
--> statement-breakpoint
PRAGMA foreign_keys=ON;
--> statement-breakpoint
CREATE INDEX `settings_user_saved` ON `settings` (`updated_at`) WHERE "settings"."source" = 'user';
--> statement-breakpoint
CREATE TABLE `connection_checks` (
	`id` text PRIMARY KEY NOT NULL,
	`setting_key` text NOT NULL,
	`at` integer NOT NULL,
	`kind` text DEFAULT 'probe' NOT NULL,
	`ok` integer DEFAULT false NOT NULL,
	`latency_ms` integer,
	`detail` text,
	FOREIGN KEY (`setting_key`) REFERENCES `settings`(`key`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "connection_checks_kind_check" CHECK("connection_checks"."kind" in ('probe','read','write'))
) STRICT;
--> statement-breakpoint
CREATE INDEX `connection_checks_recent` ON `connection_checks` (`setting_key`,`at`);
--> statement-breakpoint
CREATE TABLE `secrets` (
	`key` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`storage` text DEFAULT 'env' NOT NULL,
	`ref` text,
	`held` integer DEFAULT false NOT NULL,
	`hint` text,
	`need` text,
	`set_at` integer,
	`set_by` text,
	`last_used_at` integer,
	`last_used_ok` integer,
	`retired_at` integer,
	CONSTRAINT "secrets_storage_check" CHECK("secrets"."storage" in ('env','keychain','file')),
	CONSTRAINT "secrets_hint_length_check" CHECK("secrets"."hint" is null or length("secrets"."hint") <= 4)
) STRICT;
--> statement-breakpoint
CREATE TABLE `model_routes` (
	`id` text PRIMARY KEY NOT NULL,
	`ordinal` integer NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`strategy` text,
	`note` text,
	`enabled` integer DEFAULT true NOT NULL,
	`secret_key` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`secret_key`) REFERENCES `secrets`(`key`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "model_routes_provider_check" CHECK("model_routes"."provider" in ('ollama','openai','openrouter')),
	CONSTRAINT "model_routes_strategy_check" CHECK("model_routes"."strategy" is null or "model_routes"."strategy" in ('native','two-stage'))
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `model_routes_ordinal` ON `model_routes` (`ordinal`);
--> statement-breakpoint
CREATE TABLE `route_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`route_id` text,
	`at` integer NOT NULL,
	`outcome` text NOT NULL,
	`reason` text,
	`duration_ms` integer,
	`run_id` text,
	`next_route_id` text,
	FOREIGN KEY (`route_id`) REFERENCES `model_routes`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`run_id`) REFERENCES `workflow_runs`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`next_route_id`) REFERENCES `model_routes`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "route_attempts_outcome_check" CHECK("route_attempts"."outcome" in ('ok','failed','skipped'))
) STRICT;
--> statement-breakpoint
CREATE INDEX `route_attempts_recent` ON `route_attempts` (`at`);
--> statement-breakpoint
CREATE INDEX `route_attempts_by_route` ON `route_attempts` (`route_id`,`at`);
--> statement-breakpoint
PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE TABLE `__new_narratives` (
	`id` text PRIMARY KEY NOT NULL,
	`subject_id` text NOT NULL,
	`slot` text NOT NULL,
	`surface` text DEFAULT 'any' NOT NULL,
	`ordinal` integer DEFAULT 0 NOT NULL,
	`text` text NOT NULL,
	`authored_by` text DEFAULT 'agent' NOT NULL,
	`model` text,
	`generated_at` integer NOT NULL,
	FOREIGN KEY (`subject_id`) REFERENCES `entities`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "narratives_slot_check" CHECK("slot" in ('blurb','account','summary','restraint','lede','sheet','rule','conflict','why','outcome')),
	CONSTRAINT "narratives_surface_check" CHECK("surface" in ('any','desktop','phone')),
	CONSTRAINT "narratives_authored_by_check" CHECK("authored_by" in ('agent','user'))
) STRICT;
--> statement-breakpoint
INSERT INTO `__new_narratives`("id", "subject_id", "slot", "surface", "ordinal", "text", "authored_by", "model", "generated_at") SELECT "id", "subject_id", "slot", "surface", "ordinal", "text", "authored_by", "model", "generated_at" FROM `narratives`;
--> statement-breakpoint
DROP TABLE `narratives`;
--> statement-breakpoint
ALTER TABLE `__new_narratives` RENAME TO `narratives`;
--> statement-breakpoint
PRAGMA foreign_keys=ON;
--> statement-breakpoint
CREATE UNIQUE INDEX `narratives_slot_unique` ON `narratives` (`subject_id`,`slot`,`surface`,`ordinal`);
