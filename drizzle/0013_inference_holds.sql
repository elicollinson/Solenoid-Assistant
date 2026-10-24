CREATE TABLE `inference_holds` (
	`id` text PRIMARY KEY NOT NULL,
	`holder` text NOT NULL,
	`reason` text,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`released_at` integer
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `inference_holds_live` ON `inference_holds` (`holder`) WHERE "inference_holds"."released_at" is null;--> statement-breakpoint
CREATE TABLE `run_queue` (
	`run_id` text PRIMARY KEY NOT NULL,
	`args` text DEFAULT '{}' NOT NULL,
	`queued_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `workflow_runs`(`id`) ON UPDATE no action ON DELETE cascade
) STRICT;
--> statement-breakpoint
CREATE INDEX `run_queue_order` ON `run_queue` (`queued_at`,`run_id`);