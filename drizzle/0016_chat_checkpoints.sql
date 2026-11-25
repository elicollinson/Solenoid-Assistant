CREATE TABLE `chat_checkpoints` (
	`session_id` text NOT NULL,
	`seq` integer NOT NULL,
	`kind` text NOT NULL,
	`device_id` text NOT NULL,
	`device_name` text NOT NULL,
	`committed` integer DEFAULT false NOT NULL,
	`turn_start_seq` integer NOT NULL,
	`transcript` text NOT NULL,
	`thread` text NOT NULL,
	`pending` text,
	`created_at` text NOT NULL,
	PRIMARY KEY(`session_id`, `seq`),
	FOREIGN KEY (`session_id`) REFERENCES `chat_sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "chat_checkpoints_kind_check" CHECK("chat_checkpoints"."kind" in ('turn_start','step_assistant','step_tools','interrupt','turn_end'))
) STRICT;
--> statement-breakpoint
CREATE INDEX `chat_checkpoints_device` ON `chat_checkpoints` (`device_id`);--> statement-breakpoint
CREATE TABLE `chat_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`parent_id` text,
	`title` text NOT NULL,
	`status` text NOT NULL,
	`origin_device_id` text NOT NULL,
	`origin_device_name` text NOT NULL,
	`last_device_id` text NOT NULL,
	`last_device_name` text NOT NULL,
	`last_seq` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "chat_sessions_status_check" CHECK("chat_sessions"."status" in ('idle','running','waiting_approval','failed','closed'))
) STRICT;
--> statement-breakpoint
CREATE INDEX `chat_sessions_parent_updated` ON `chat_sessions` (`parent_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `chat_sessions_origin_device` ON `chat_sessions` (`origin_device_id`);--> statement-breakpoint
CREATE INDEX `chat_sessions_last_device` ON `chat_sessions` (`last_device_id`);--> statement-breakpoint
CREATE INDEX `chat_sessions_status` ON `chat_sessions` (`status`);