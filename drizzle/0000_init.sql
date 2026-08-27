CREATE TABLE `entities` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	CONSTRAINT "entities_kind_check" CHECK("entities"."kind" in ('workflow','workflow_run','run_step','activity_item','decision','reminder','calendar_item','okf_object','okf_field','recommendation','conversation','message','screenshot','web_document','participant','attachment'))
) STRICT;
--> statement-breakpoint
CREATE INDEX `entities_kind_created` ON `entities` (`kind`,`created_at`) WHERE "entities"."deleted_at" is null;--> statement-breakpoint
CREATE TABLE `attributes` (
	`id` text PRIMARY KEY NOT NULL,
	`subject_id` text NOT NULL,
	`group_slot` text DEFAULT 'meta' NOT NULL,
	`ordinal` integer NOT NULL,
	`label` text NOT NULL,
	`value` text NOT NULL,
	`value_kind` text DEFAULT 'text' NOT NULL,
	`ref_id` text,
	FOREIGN KEY (`subject_id`) REFERENCES `entities`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`ref_id`) REFERENCES `entities`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "attributes_group_check" CHECK("attributes"."group_slot" in ('meta','effect','stats','counts')),
	CONSTRAINT "attributes_value_kind_check" CHECK("attributes"."value_kind" in ('text','count','duration','money','timestamp','ref'))
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `attributes_ordinal_unique` ON `attributes` (`subject_id`,`group_slot`,`ordinal`);--> statement-breakpoint
CREATE TABLE `evidence_links` (
	`id` text PRIMARY KEY NOT NULL,
	`subject_id` text NOT NULL,
	`source_id` text NOT NULL,
	`ordinal` integer DEFAULT 0 NOT NULL,
	`why` text,
	`pin_kind` text DEFAULT 'whole' NOT NULL,
	`pin_start` integer,
	`pin_end` integer,
	`pin_quote` text,
	`pin_ref_id` text,
	`analysis_id` text,
	`relevance` real,
	`added_by` text DEFAULT 'agent' NOT NULL,
	`added_at` integer NOT NULL,
	FOREIGN KEY (`subject_id`) REFERENCES `entities`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_id`) REFERENCES `entities`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "evidence_links_pin_kind_check" CHECK("evidence_links"."pin_kind" in ('whole','range','region','field')),
	CONSTRAINT "evidence_links_added_by_check" CHECK("evidence_links"."added_by" in ('agent','user'))
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `evidence_links_unique` ON `evidence_links` (`subject_id`,`source_id`,`pin_start`,`pin_end`,`pin_ref_id`);--> statement-breakpoint
CREATE INDEX `evidence_by_subject` ON `evidence_links` (`subject_id`,`ordinal`);--> statement-breakpoint
CREATE INDEX `evidence_by_source` ON `evidence_links` (`source_id`);--> statement-breakpoint
CREATE TABLE `links` (
	`id` text PRIMARY KEY NOT NULL,
	`from_id` text NOT NULL,
	`to_id` text NOT NULL,
	`rel` text NOT NULL,
	`label` text,
	`created_at` integer NOT NULL,
	`created_by` text DEFAULT 'agent' NOT NULL,
	FOREIGN KEY (`from_id`) REFERENCES `entities`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`to_id`) REFERENCES `entities`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "links_rel_check" CHECK("links"."rel" in ('blocks','derived_from','references','supersedes','about','scoped_to','triggered_by','duplicate_of','answers')),
	CONSTRAINT "links_created_by_check" CHECK("links"."created_by" in ('agent','user','system'))
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `links_edge_unique` ON `links` (`from_id`,`to_id`,`rel`);--> statement-breakpoint
CREATE INDEX `links_to` ON `links` (`to_id`,`rel`);--> statement-breakpoint
CREATE TABLE `narratives` (
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
	CONSTRAINT "narratives_slot_check" CHECK("narratives"."slot" in ('blurb','account','summary','restraint','lede','sheet','rule','conflict','why')),
	CONSTRAINT "narratives_surface_check" CHECK("narratives"."surface" in ('any','desktop','phone')),
	CONSTRAINT "narratives_authored_by_check" CHECK("narratives"."authored_by" in ('agent','user'))
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `narratives_slot_unique` ON `narratives` (`subject_id`,`slot`,`surface`,`ordinal`);--> statement-breakpoint
CREATE TABLE `safety_screenings` (
	`id` text PRIMARY KEY NOT NULL,
	`subject_id` text NOT NULL,
	`screened_at` integer NOT NULL,
	`screener` text NOT NULL,
	`model` text,
	`score` real,
	`threshold` real,
	`flagged` integer DEFAULT false NOT NULL,
	`concern` text,
	`chunk_count` integer,
	`disposition` text NOT NULL,
	`overridden_by` text,
	`overridden_at` integer,
	FOREIGN KEY (`subject_id`) REFERENCES `entities`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "safety_screener_check" CHECK("safety_screenings"."screener" in ('prompt_guard','llm_classifier','heuristic')),
	CONSTRAINT "safety_disposition_check" CHECK("safety_screenings"."disposition" in ('clean','quarantined','rejected','overridden'))
) STRICT;
--> statement-breakpoint
CREATE INDEX `safety_by_subject` ON `safety_screenings` (`subject_id`,`screened_at`);--> statement-breakpoint
CREATE TABLE `subject_events` (
	`id` text PRIMARY KEY NOT NULL,
	`subject_id` text NOT NULL,
	`at` integer NOT NULL,
	`actor` text DEFAULT 'agent' NOT NULL,
	`event_kind` text DEFAULT 'note' NOT NULL,
	`text` text NOT NULL,
	`data` text,
	`run_id` text,
	FOREIGN KEY (`subject_id`) REFERENCES `entities`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "subject_events_actor_check" CHECK("subject_events"."actor" in ('agent','user','system'))
) STRICT;
--> statement-breakpoint
CREATE INDEX `subject_events_subject_at` ON `subject_events` (`subject_id`,`at`);--> statement-breakpoint
CREATE TABLE `actions` (
	`id` text PRIMARY KEY NOT NULL,
	`subject_id` text NOT NULL,
	`decision_id` text,
	`ordinal` integer NOT NULL,
	`label` text NOT NULL,
	`stance` text DEFAULT 'neutral' NOT NULL,
	`effect_kind` text NOT NULL,
	`effect` text DEFAULT '{}' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`destructive` integer DEFAULT false NOT NULL,
	`requires_confirmation` integer DEFAULT false NOT NULL,
	`idempotency_key` text,
	`authored_by` text DEFAULT 'agent' NOT NULL,
	`created_at` integer NOT NULL,
	`invoked_at` integer,
	`invoked_by` text,
	`invoke_state` text,
	`invoke_result` text,
	`invoke_error` text,
	FOREIGN KEY (`subject_id`) REFERENCES `entities`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`decision_id`) REFERENCES `decisions`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "actions_stance_check" CHECK("actions"."stance" in ('affirm','neutral','quiet','danger','bare')),
	CONSTRAINT "actions_effect_kind_check" CHECK("actions"."effect_kind" in ('tool_call','navigate','resolve','set_policy','run_workflow','snooze','custom'))
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `actions_subject_ordinal` ON `actions` (`subject_id`,`ordinal`);--> statement-breakpoint
CREATE UNIQUE INDEX `actions_idempotency` ON `actions` (`idempotency_key`) WHERE "actions"."idempotency_key" is not null;--> statement-breakpoint
CREATE INDEX `actions_decision` ON `actions` (`decision_id`,`ordinal`);--> statement-breakpoint
CREATE TABLE `decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`subject_id` text,
	`title` text NOT NULL,
	`body` text,
	`state` text DEFAULT 'open' NOT NULL,
	`blocking` integer DEFAULT false NOT NULL,
	`opened_at` integer NOT NULL,
	`due_at` integer,
	`resolved_at` integer,
	`resolved_by` text,
	`chosen_action_id` text,
	`superseded_by_id` text,
	FOREIGN KEY (`id`) REFERENCES `entities`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`subject_id`) REFERENCES `entities`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`superseded_by_id`) REFERENCES `decisions`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "decisions_state_check" CHECK("decisions"."state" in ('open','resolved','dismissed','expired','superseded'))
) STRICT;
--> statement-breakpoint
CREATE INDEX `decisions_open` ON `decisions` (`blocking`,`opened_at`) WHERE "decisions"."state" = 'open';--> statement-breakpoint
CREATE INDEX `decisions_subject` ON `decisions` (`subject_id`);--> statement-breakpoint
CREATE INDEX `decisions_chosen` ON `decisions` (`chosen_action_id`);--> statement-breakpoint
CREATE TABLE `participant_handles` (
	`id` text PRIMARY KEY NOT NULL,
	`participant_id` text NOT NULL,
	`kind` text NOT NULL,
	`value` text NOT NULL,
	`is_primary` integer DEFAULT false NOT NULL,
	`verified_at` integer,
	FOREIGN KEY (`participant_id`) REFERENCES `participants`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "participant_handles_kind_check" CHECK("participant_handles"."kind" in ('phone','email','imessage','handle','other'))
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `participant_handles_value` ON `participant_handles` (`kind`,`value`);--> statement-breakpoint
CREATE TABLE `participants` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`display_name` text NOT NULL,
	`okf_uri` text,
	`org_label` text,
	`trust_state` text DEFAULT 'unknown' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`id`) REFERENCES `entities`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "participants_kind_check" CHECK("participants"."kind" in ('person','org','agent','system','self')),
	CONSTRAINT "participants_trust_check" CHECK("participants"."trust_state" in ('trusted','known','unknown','blocked'))
) STRICT;
--> statement-breakpoint
CREATE INDEX `participants_okf` ON `participants` (`okf_uri`) WHERE "participants"."okf_uri" is not null;--> statement-breakpoint
CREATE TABLE `attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`filename` text NOT NULL,
	`mime_type` text,
	`size_bytes` integer,
	`path` text,
	`sha256` text,
	`screenshot_id` text,
	`extracted_text` text,
	FOREIGN KEY (`id`) REFERENCES `entities`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade
) STRICT;
--> statement-breakpoint
CREATE INDEX `attachments_message` ON `attachments` (`message_id`);--> statement-breakpoint
CREATE TABLE `conversation_participants` (
	`conversation_id` text NOT NULL,
	`participant_id` text NOT NULL,
	`role` text DEFAULT 'them' NOT NULL,
	PRIMARY KEY(`conversation_id`, `participant_id`, `role`),
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`participant_id`) REFERENCES `participants`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "conversation_participants_role_check" CHECK("conversation_participants"."role" in ('me','them','agent','cc','bcc','organizer'))
) STRICT;
--> statement-breakpoint
CREATE TABLE `conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`channel` text NOT NULL,
	`external_id` text,
	`title` text,
	`subject` text,
	`counterparty_label` text,
	`is_group` integer DEFAULT false NOT NULL,
	`started_at` integer,
	`last_message_at` integer,
	`message_count` integer DEFAULT 0 NOT NULL,
	`unread_count` integer DEFAULT 0 NOT NULL,
	`trust_state` text DEFAULT 'unknown' NOT NULL,
	`safety_state` text DEFAULT 'unscreened' NOT NULL,
	`archived_at` integer,
	FOREIGN KEY (`id`) REFERENCES `entities`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "conversations_channel_check" CHECK("conversations"."channel" in ('imessage','sms','email','agent_chat','call','other')),
	CONSTRAINT "conversations_trust_check" CHECK("conversations"."trust_state" in ('trusted','known','unknown','blocked')),
	CONSTRAINT "conversations_safety_check" CHECK("conversations"."safety_state" in ('unscreened','clean','flagged','quarantined'))
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `conversations_external` ON `conversations` (`channel`,`external_id`);--> statement-breakpoint
CREATE INDEX `conversations_recent` ON `conversations` (`last_message_at`);--> statement-breakpoint
CREATE TABLE `email_messages` (
	`message_id` text PRIMARY KEY NOT NULL,
	`rfc_message_id` text,
	`in_reply_to` text,
	`references_hdr` text,
	`from_addr` text NOT NULL,
	`to_addrs` text DEFAULT '[]' NOT NULL,
	`cc_addrs` text DEFAULT '[]' NOT NULL,
	`bcc_addrs` text DEFAULT '[]' NOT NULL,
	`subject` text,
	`snippet` text,
	`quoted_text` text,
	`provider` text,
	`provider_id` text,
	`labels` text DEFAULT '[]' NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade
) STRICT;
--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`external_id` text,
	`seq` integer NOT NULL,
	`sender_id` text,
	`direction` text NOT NULL,
	`sent_at` integer NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`body_format` text DEFAULT 'text' NOT NULL,
	`service` text,
	`has_attachments` integer DEFAULT false NOT NULL,
	`reply_to_id` text,
	`is_draft` integer DEFAULT false NOT NULL,
	`drafted_by_run_id` text,
	`sent_by` text,
	`safety_state` text DEFAULT 'unscreened' NOT NULL,
	`redacted_at` integer,
	FOREIGN KEY (`id`) REFERENCES `entities`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`sender_id`) REFERENCES `participants`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`reply_to_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "messages_direction_check" CHECK("messages"."direction" in ('inbound','outbound','system')),
	CONSTRAINT "messages_body_format_check" CHECK("messages"."body_format" in ('text','html','markdown')),
	CONSTRAINT "messages_safety_check" CHECK("messages"."safety_state" in ('unscreened','clean','flagged','quarantined'))
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `messages_external` ON `messages` (`conversation_id`,`external_id`);--> statement-breakpoint
CREATE INDEX `messages_conversation_seq` ON `messages` (`conversation_id`,`seq`);--> statement-breakpoint
CREATE INDEX `messages_sent_at` ON `messages` (`sent_at`);--> statement-breakpoint
CREATE INDEX `messages_draft` ON `messages` (`conversation_id`) WHERE "messages"."is_draft" = 1;--> statement-breakpoint
CREATE TABLE `screenshot_analyses` (
	`id` text PRIMARY KEY NOT NULL,
	`screenshot_id` text NOT NULL,
	`version` integer NOT NULL,
	`is_current` integer DEFAULT true NOT NULL,
	`summary` text,
	`ocr_text` text,
	`app_guess` text,
	`doc_kind` text,
	`entities_json` text DEFAULT '[]' NOT NULL,
	`model` text,
	`prompt_version` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`screenshot_id`) REFERENCES `screenshots`(`id`) ON UPDATE no action ON DELETE cascade
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `screenshot_analyses_version` ON `screenshot_analyses` (`screenshot_id`,`version`);--> statement-breakpoint
CREATE UNIQUE INDEX `screenshot_analyses_current` ON `screenshot_analyses` (`screenshot_id`) WHERE "screenshot_analyses"."is_current" = 1;--> statement-breakpoint
CREATE TABLE `screenshot_regions` (
	`id` text PRIMARY KEY NOT NULL,
	`analysis_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`label` text NOT NULL,
	`note` text NOT NULL,
	`bbox` text,
	FOREIGN KEY (`analysis_id`) REFERENCES `screenshot_analyses`(`id`) ON UPDATE no action ON DELETE cascade
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `screenshot_regions_ordinal` ON `screenshot_regions` (`analysis_id`,`ordinal`);--> statement-breakpoint
CREATE TABLE `screenshots` (
	`id` text PRIMARY KEY NOT NULL,
	`photos_uuid` text,
	`path` text,
	`path_edited` text,
	`original_filename` text NOT NULL,
	`file_sha256` text,
	`captured_at` integer NOT NULL,
	`added_at` integer,
	`width` integer,
	`height` integer,
	`uti` text,
	`size_bytes` integer,
	`origin` text DEFAULT 'photos_library' NOT NULL,
	`capture_context` text,
	`captured_by` text DEFAULT 'user' NOT NULL,
	`captured_in_run_id` text,
	`is_missing` integer DEFAULT false NOT NULL,
	`in_trash` integer DEFAULT false NOT NULL,
	`apple_labels` text DEFAULT '[]' NOT NULL,
	`persons` text DEFAULT '[]' NOT NULL,
	`albums` text DEFAULT '[]' NOT NULL,
	`safety_state` text DEFAULT 'unscreened' NOT NULL,
	`ingest_state` text DEFAULT 'pending' NOT NULL,
	`ingest_error` text,
	FOREIGN KEY (`id`) REFERENCES `entities`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "screenshots_origin_check" CHECK("screenshots"."origin" in ('photos_library','agent_capture','attachment','manual')),
	CONSTRAINT "screenshots_ingest_check" CHECK("screenshots"."ingest_state" in ('pending','ingested','quarantined','rejected','failed','skipped')),
	CONSTRAINT "screenshots_safety_check" CHECK("screenshots"."safety_state" in ('unscreened','clean','flagged','quarantined'))
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `screenshots_photos_uuid` ON `screenshots` (`photos_uuid`);--> statement-breakpoint
CREATE INDEX `screenshots_captured` ON `screenshots` (`captured_at`);--> statement-breakpoint
CREATE INDEX `screenshots_pending` ON `screenshots` (`captured_at`) WHERE "screenshots"."ingest_state" = 'pending';--> statement-breakpoint
CREATE TABLE `web_documents` (
	`id` text PRIMARY KEY NOT NULL,
	`url` text NOT NULL,
	`canonical_url` text,
	`site_label` text,
	`headline` text,
	`byline` text,
	`retrieved_at` integer NOT NULL,
	`word_count` integer,
	`body_text` text DEFAULT '' NOT NULL,
	`raw_path` text,
	`http_status` integer,
	`content_sha256` text,
	`safety_state` text DEFAULT 'unscreened' NOT NULL,
	FOREIGN KEY (`id`) REFERENCES `entities`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "web_documents_safety_check" CHECK("web_documents"."safety_state" in ('unscreened','clean','flagged','quarantined'))
) STRICT;
--> statement-breakpoint
CREATE INDEX `web_documents_url` ON `web_documents` (`url`,`retrieved_at`);--> statement-breakpoint
CREATE TABLE `run_effects` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`text` text NOT NULL,
	`effect_kind` text DEFAULT 'note' NOT NULL,
	`target_id` text,
	`reversible` integer DEFAULT false NOT NULL,
	`reverted_at` integer,
	FOREIGN KEY (`run_id`) REFERENCES `workflow_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`target_id`) REFERENCES `entities`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "run_effects_kind_check" CHECK("run_effects"."effect_kind" in ('created','updated','sent','filed','held','moved','skipped','note'))
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `run_effects_ordinal` ON `run_effects` (`run_id`,`ordinal`);--> statement-breakpoint
CREATE TABLE `run_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` text NOT NULL,
	`at` integer NOT NULL,
	`frac_us` integer DEFAULT 0 NOT NULL,
	`seq` integer NOT NULL,
	`level` text NOT NULL,
	`text` text NOT NULL,
	`data` text,
	`step_id` text,
	FOREIGN KEY (`run_id`) REFERENCES `workflow_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`step_id`) REFERENCES `run_steps`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "run_logs_level_check" CHECK("run_logs"."level" in ('debug','info','ok','warn','error'))
) STRICT;
--> statement-breakpoint
CREATE INDEX `run_logs_run` ON `run_logs` (`run_id`,`seq`);--> statement-breakpoint
CREATE INDEX `run_logs_level` ON `run_logs` (`run_id`,`level`);--> statement-breakpoint
CREATE TABLE `run_steps` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`parent_id` text,
	`ordinal` integer NOT NULL,
	`depth` integer DEFAULT 0 NOT NULL,
	`name` text NOT NULL,
	`detail` text,
	`note` text,
	`state` text DEFAULT 'ok' NOT NULL,
	`is_tool` integer DEFAULT false NOT NULL,
	`tool_name` text,
	`tool_args` text,
	`tool_result_ref` text,
	`tool_result` text,
	`started_at` integer,
	`ended_at` integer,
	`duration_ms` integer,
	`span_id` text,
	`retry_of_id` text,
	FOREIGN KEY (`id`) REFERENCES `entities`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `workflow_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`parent_id`) REFERENCES `run_steps`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`retry_of_id`) REFERENCES `run_steps`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "run_steps_state_check" CHECK("run_steps"."state" in ('ok','running','failed','waiting','skipped'))
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `run_steps_ordinal` ON `run_steps` (`run_id`,`parent_id`,`ordinal`);--> statement-breakpoint
CREATE INDEX `run_steps_tree` ON `run_steps` (`run_id`,`parent_id`,`ordinal`);--> statement-breakpoint
CREATE INDEX `run_steps_tools` ON `run_steps` (`run_id`) WHERE "run_steps"."is_tool" = 1;--> statement-breakpoint
CREATE TABLE `workflow_instructions` (
	`id` text PRIMARY KEY NOT NULL,
	`workflow_id` text,
	`text` text NOT NULL,
	`okf_uri` text,
	`source_message_id` text,
	`authored_by` text DEFAULT 'user' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`effective_from` integer NOT NULL,
	`retired_at` integer,
	`supersedes_id` text,
	FOREIGN KEY (`workflow_id`) REFERENCES `workflows`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`supersedes_id`) REFERENCES `workflow_instructions`(`id`) ON UPDATE no action ON DELETE set null
) STRICT;
--> statement-breakpoint
CREATE INDEX `workflow_instructions_active` ON `workflow_instructions` (`workflow_id`) WHERE "workflow_instructions"."retired_at" is null;--> statement-breakpoint
CREATE TABLE `workflow_permissions` (
	`id` text PRIMARY KEY NOT NULL,
	`workflow_id` text,
	`capability` text NOT NULL,
	`mode` text NOT NULL,
	`limit_amount_cents` integer,
	`limit_json` text DEFAULT '{}' NOT NULL,
	`okf_policy_uri` text,
	`created_at` integer NOT NULL,
	`created_by` text DEFAULT 'user' NOT NULL,
	`retired_at` integer,
	FOREIGN KEY (`workflow_id`) REFERENCES `workflows`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "workflow_permissions_mode_check" CHECK("workflow_permissions"."mode" in ('allow','ask','deny'))
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `workflow_permissions_active` ON `workflow_permissions` (`workflow_id`,`capability`) WHERE "workflow_permissions"."retired_at" is null;--> statement-breakpoint
CREATE TABLE `workflow_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`workflow_id` text NOT NULL,
	`version_id` text,
	`ordinal` integer NOT NULL,
	`trigger` text NOT NULL,
	`triggered_by` text,
	`parent_run_id` text,
	`state` text NOT NULL,
	`step_index` integer,
	`step_total` integer,
	`started_at` integer,
	`ended_at` integer,
	`duration_ms` integer,
	`error` text,
	`halted_step_id` text,
	`trace_id` text,
	`span_id` text,
	`transcript_conversation_id` text,
	`tokens_in` integer,
	`tokens_out` integer,
	`model_route` text,
	FOREIGN KEY (`id`) REFERENCES `entities`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workflow_id`) REFERENCES `workflows`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`version_id`) REFERENCES `workflow_versions`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`parent_run_id`) REFERENCES `workflow_runs`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`transcript_conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "workflow_runs_state_check" CHECK("workflow_runs"."state" in ('queued','running','attention','done','failed','cancelled')),
	CONSTRAINT "workflow_runs_trigger_check" CHECK("workflow_runs"."trigger" in ('schedule','manual','event','retry'))
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `workflow_runs_ordinal` ON `workflow_runs` (`workflow_id`,`ordinal`);--> statement-breakpoint
CREATE INDEX `runs_by_workflow` ON `workflow_runs` (`workflow_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `runs_active` ON `workflow_runs` (`started_at`) WHERE "workflow_runs"."state" in ('queued','running','attention');--> statement-breakpoint
CREATE INDEX `runs_trace` ON `workflow_runs` (`trace_id`) WHERE "workflow_runs"."trace_id" is not null;--> statement-breakpoint
CREATE TABLE `workflow_schedules` (
	`id` text PRIMARY KEY NOT NULL,
	`workflow_id` text NOT NULL,
	`rrule` text NOT NULL,
	`tz` text DEFAULT 'America/New_York' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`jitter_secs` integer DEFAULT 0 NOT NULL,
	`next_run_at` integer,
	`last_run_at` integer,
	`label` text,
	FOREIGN KEY (`workflow_id`) REFERENCES `workflows`(`id`) ON UPDATE no action ON DELETE cascade
) STRICT;
--> statement-breakpoint
CREATE INDEX `workflow_schedules_due` ON `workflow_schedules` (`next_run_at`) WHERE "workflow_schedules"."enabled" = 1;--> statement-breakpoint
CREATE TABLE `workflow_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`workflow_id` text NOT NULL,
	`version` integer NOT NULL,
	`config` text DEFAULT '{}' NOT NULL,
	`step_total` integer,
	`note` text,
	`created_at` integer NOT NULL,
	`created_by` text DEFAULT 'user' NOT NULL,
	FOREIGN KEY (`workflow_id`) REFERENCES `workflows`(`id`) ON UPDATE no action ON DELETE cascade
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `workflow_versions_number` ON `workflow_versions` (`workflow_id`,`version`);--> statement-breakpoint
CREATE TABLE `workflows` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`trigger_kind` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`paused_at` integer,
	`paused_by` text,
	`pause_reason` text,
	`current_version_id` text,
	`last_run_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`id`) REFERENCES `entities`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "workflows_trigger_check" CHECK("workflows"."trigger_kind" in ('schedule','on_demand','event'))
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `workflows_slug` ON `workflows` (`slug`);--> statement-breakpoint
CREATE TABLE `activity_items` (
	`id` text PRIMARY KEY NOT NULL,
	`occurred_at` integer NOT NULL,
	`state` text NOT NULL,
	`title` text NOT NULL,
	`badge` text,
	`prominence` text DEFAULT 'quiet' NOT NULL,
	`framed` integer DEFAULT false NOT NULL,
	`source_id` text,
	`workflow_id` text,
	`run_id` text,
	`decision_id` text,
	`tool_summary` text,
	`progress_value` integer,
	`progress_total` integer,
	`read_at` integer,
	`dismissed_at` integer,
	FOREIGN KEY (`id`) REFERENCES `entities`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_id`) REFERENCES `entities`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`workflow_id`) REFERENCES `workflows`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`run_id`) REFERENCES `workflow_runs`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`decision_id`) REFERENCES `decisions`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "activity_items_state_check" CHECK("activity_items"."state" in ('attention','running','done','failed','idle')),
	CONSTRAINT "activity_items_prominence_check" CHECK("activity_items"."prominence" in ('prominent','quiet'))
) STRICT;
--> statement-breakpoint
CREATE INDEX `activity_feed` ON `activity_items` (`occurred_at`) WHERE "activity_items"."dismissed_at" is null;--> statement-breakpoint
CREATE INDEX `activity_by_state` ON `activity_items` (`state`,`occurred_at`);--> statement-breakpoint
CREATE TABLE `reminders` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`state` text DEFAULT 'idle' NOT NULL,
	`due_at` integer,
	`due_tz` text DEFAULT 'America/New_York' NOT NULL,
	`all_day` integer DEFAULT false NOT NULL,
	`set_by` text DEFAULT 'agent' NOT NULL,
	`set_at` integer NOT NULL,
	`origin_kind` text DEFAULT 'manual' NOT NULL,
	`origin_id` text,
	`origin_label` text,
	`completed_at` integer,
	`completed_by` text,
	`completed_reason` text,
	`snoozed_until` integer,
	`decision_id` text,
	`instruction_id` text,
	`recurrence_rrule` text,
	FOREIGN KEY (`id`) REFERENCES `entities`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`origin_id`) REFERENCES `entities`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`decision_id`) REFERENCES `decisions`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`instruction_id`) REFERENCES `workflow_instructions`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "reminders_state_check" CHECK("reminders"."state" in ('attention','running','done','idle','cancelled')),
	CONSTRAINT "reminders_origin_check" CHECK("reminders"."origin_kind" in ('okf','conversation','message','workflow','screenshot','manual'))
) STRICT;
--> statement-breakpoint
CREATE INDEX `reminders_due` ON `reminders` (`due_at`) WHERE "reminders"."completed_at" is null and "reminders"."state" <> 'cancelled';--> statement-breakpoint
CREATE INDEX `reminders_open` ON `reminders` (`state`,`due_at`) WHERE "reminders"."completed_at" is null;--> statement-breakpoint
CREATE TABLE `calendar_attendees` (
	`calendar_item_id` text NOT NULL,
	`participant_id` text NOT NULL,
	`response` text DEFAULT 'none' NOT NULL,
	`optional` integer DEFAULT false NOT NULL,
	`is_external` integer DEFAULT false NOT NULL,
	PRIMARY KEY(`calendar_item_id`, `participant_id`),
	FOREIGN KEY (`calendar_item_id`) REFERENCES `calendar_items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`participant_id`) REFERENCES `participants`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "calendar_attendees_response_check" CHECK("calendar_attendees"."response" in ('accepted','declined','tentative','none'))
) STRICT;
--> statement-breakpoint
CREATE TABLE `calendar_holds` (
	`id` text PRIMARY KEY NOT NULL,
	`hold_group_id` text NOT NULL,
	`offered_by_id` text,
	`offered_at` integer NOT NULL,
	`expires_at` integer,
	`accepted_at` integer,
	`released_at` integer,
	`clash_note` text,
	FOREIGN KEY (`id`) REFERENCES `calendar_items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`offered_by_id`) REFERENCES `participants`(`id`) ON UPDATE no action ON DELETE set null
) STRICT;
--> statement-breakpoint
CREATE INDEX `calendar_holds_by_group` ON `calendar_holds` (`hold_group_id`);--> statement-breakpoint
CREATE TABLE `calendar_items` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`state` text,
	`title` text NOT NULL,
	`meta_label` text,
	`location` text,
	`starts_at` integer NOT NULL,
	`ends_at` integer,
	`tz` text DEFAULT 'America/New_York' NOT NULL,
	`all_day` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'confirmed' NOT NULL,
	`source_id` text,
	`workflow_id` text,
	`provider` text DEFAULT 'local' NOT NULL,
	`external_id` text,
	`external_calendar_id` text,
	`etag` text,
	`synced_at` integer,
	`organizer_id` text,
	`set_by` text DEFAULT 'user' NOT NULL,
	`moved_from_at` integer,
	`moved_by` text,
	`moved_reason` text,
	`hold_group_id` text,
	`decision_id` text,
	`series_id` text,
	FOREIGN KEY (`id`) REFERENCES `entities`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_id`) REFERENCES `entities`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workflow_id`) REFERENCES `workflows`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`organizer_id`) REFERENCES `participants`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`decision_id`) REFERENCES `decisions`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`series_id`) REFERENCES `calendar_items`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "calendar_items_kind_check" CHECK("calendar_items"."kind" in ('event','run','reminder','hold')),
	CONSTRAINT "calendar_items_state_check" CHECK("calendar_items"."state" is null or "calendar_items"."state" in ('attention','running','done','failed')),
	CONSTRAINT "calendar_items_status_check" CHECK("calendar_items"."status" in ('confirmed','tentative','cancelled'))
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `calendar_items_external` ON `calendar_items` (`provider`,`external_id`);--> statement-breakpoint
CREATE INDEX `calendar_window` ON `calendar_items` (`starts_at`,`ends_at`) WHERE "calendar_items"."status" <> 'cancelled';--> statement-breakpoint
CREATE INDEX `calendar_holds_group` ON `calendar_items` (`hold_group_id`) WHERE "calendar_items"."hold_group_id" is not null;--> statement-breakpoint
CREATE TABLE `calendar_recurrences` (
	`item_id` text PRIMARY KEY NOT NULL,
	`rrule` text NOT NULL,
	`tz` text DEFAULT 'America/New_York' NOT NULL,
	`until_at` integer,
	`exdates` text DEFAULT '[]' NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `calendar_items`(`id`) ON UPDATE no action ON DELETE cascade
) STRICT;
--> statement-breakpoint
CREATE TABLE `day_notes` (
	`id` text PRIMARY KEY NOT NULL,
	`on_date` text NOT NULL,
	`surface` text NOT NULL,
	`slot` text NOT NULL,
	`text` text NOT NULL,
	`generated_at` integer NOT NULL,
	`model` text,
	CONSTRAINT "day_notes_surface_check" CHECK("day_notes"."surface" in ('desktop','phone')),
	CONSTRAINT "day_notes_slot_check" CHECK("day_notes"."slot" in ('line','restraint'))
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `day_notes_unique` ON `day_notes` (`on_date`,`surface`,`slot`);--> statement-breakpoint
CREATE TABLE `okf_access_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`object_id` text,
	`okf_uri` text NOT NULL,
	`at` integer NOT NULL,
	`mode` text NOT NULL,
	`actor` text DEFAULT 'agent' NOT NULL,
	`run_id` text,
	`step_id` text,
	CONSTRAINT "okf_access_mode_check" CHECK("okf_access_log"."mode" in ('read','write','create','retire'))
) STRICT;
--> statement-breakpoint
CREATE INDEX `okf_access_by_uri` ON `okf_access_log` (`okf_uri`,`at`);--> statement-breakpoint
CREATE TABLE `okf_conflicts` (
	`id` text PRIMARY KEY NOT NULL,
	`object_id` text NOT NULL,
	`group_id` text NOT NULL,
	`label` text NOT NULL,
	`decision_id` text,
	`opened_at` integer NOT NULL,
	`resolved_at` integer,
	`resolution` text,
	FOREIGN KEY (`object_id`) REFERENCES `okf_objects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`decision_id`) REFERENCES `decisions`(`id`) ON UPDATE no action ON DELETE set null
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `okf_conflicts_group` ON `okf_conflicts` (`object_id`,`group_id`);--> statement-breakpoint
CREATE TABLE `okf_fields` (
	`id` text PRIMARY KEY NOT NULL,
	`object_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`label` text NOT NULL,
	`value` text NOT NULL,
	`asserted_at` integer,
	`source_label` text,
	`provenance` text DEFAULT 'agent_inferred' NOT NULL,
	`confirmed_at` integer,
	`conflict_group_id` text,
	`superseded_by_id` text,
	`retired_at` integer,
	`section` text,
	`body_start` integer,
	`body_end` integer,
	FOREIGN KEY (`id`) REFERENCES `entities`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`object_id`) REFERENCES `okf_objects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`superseded_by_id`) REFERENCES `okf_fields`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "okf_fields_provenance_check" CHECK("okf_fields"."provenance" in ('user','agent_inferred','agent_confirmed','document','tool'))
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `okf_fields_ordinal` ON `okf_fields` (`object_id`,`ordinal`);--> statement-breakpoint
CREATE INDEX `okf_fields_conflict` ON `okf_fields` (`conflict_group_id`) WHERE "okf_fields"."conflict_group_id" is not null;--> statement-breakpoint
CREATE TABLE `okf_objects` (
	`id` text PRIMARY KEY NOT NULL,
	`uri` text NOT NULL,
	`path` text NOT NULL,
	`okf_type` text,
	`kind` text,
	`group_label` text,
	`title` text NOT NULL,
	`description` text,
	`tags` text DEFAULT '[]' NOT NULL,
	`status` text,
	`rev` integer DEFAULT 1 NOT NULL,
	`state` text DEFAULT 'idle' NOT NULL,
	`frontmatter` text DEFAULT '{}' NOT NULL,
	`body_text` text DEFAULT '' NOT NULL,
	`file_mtime` integer,
	`file_size` integer,
	`content_sha256` text,
	`generated_by` text,
	`generated_at` integer,
	`verified_at` integer,
	`stale_after` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`indexed_at` integer NOT NULL,
	`index_version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`id`) REFERENCES `entities`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "okf_objects_state_check" CHECK("okf_objects"."state" in ('attention','running','done','idle'))
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `okf_objects_uri` ON `okf_objects` (`uri`);--> statement-breakpoint
CREATE UNIQUE INDEX `okf_objects_path` ON `okf_objects` (`path`);--> statement-breakpoint
CREATE INDEX `okf_by_kind` ON `okf_objects` (`kind`,`updated_at`);--> statement-breakpoint
CREATE INDEX `okf_stale` ON `okf_objects` (`stale_after`) WHERE "okf_objects"."stale_after" is not null;--> statement-breakpoint
CREATE TABLE `okf_sync_state` (
	`path` text PRIMARY KEY NOT NULL,
	`content_sha256` text,
	`file_mtime` integer,
	`last_indexed_at` integer,
	`status` text DEFAULT 'ok' NOT NULL,
	`error` text,
	CONSTRAINT "okf_sync_status_check" CHECK("okf_sync_state"."status" in ('ok','parse_error','missing','conflict'))
) STRICT;
--> statement-breakpoint
CREATE TABLE `recommendations` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`status` text DEFAULT 'proposed' NOT NULL,
	`confidence` text DEFAULT 'worth_a_look' NOT NULL,
	`formed_at` integer NOT NULL,
	`decided_at` integer,
	`decided_by` text,
	`basis_label` text,
	`basis_count` integer,
	`basis_run_count` integer,
	`scope_label` text,
	`scope_okf_uri` text,
	`scope_workflow_id` text,
	`decision_id` text,
	`re_raise_condition` text,
	`re_raise_after` integer,
	`applied_permission_id` text,
	`applied_instruction_id` text,
	FOREIGN KEY (`id`) REFERENCES `entities`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`scope_workflow_id`) REFERENCES `workflows`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`decision_id`) REFERENCES `decisions`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`applied_permission_id`) REFERENCES `workflow_permissions`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`applied_instruction_id`) REFERENCES `workflow_instructions`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "recommendations_status_check" CHECK("recommendations"."status" in ('proposed','adopted','declined','withdrawn','superseded')),
	CONSTRAINT "recommendations_confidence_check" CHECK("recommendations"."confidence" in ('strong','worth_a_look','weak'))
) STRICT;
--> statement-breakpoint
CREATE INDEX `recommendations_status` ON `recommendations` (`status`,`formed_at`);--> statement-breakpoint
CREATE TABLE `embeddings` (
	`id` text PRIMARY KEY NOT NULL,
	`subject_id` text NOT NULL,
	`chunk_ordinal` integer DEFAULT 0 NOT NULL,
	`chunk_text` text,
	`text_sha256` text NOT NULL,
	`model` text NOT NULL,
	`dim` integer NOT NULL,
	`vector` blob NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`subject_id`) REFERENCES `entities`(`id`) ON UPDATE no action ON DELETE cascade
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `embeddings_chunk` ON `embeddings` (`subject_id`,`chunk_ordinal`,`model`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
) STRICT;
