CREATE TABLE `log_monitor_incidents` (
	`scope` text NOT NULL,
	`fingerprint` text NOT NULL,
	`status` text NOT NULL,
	`issue_number` integer,
	`issue_url` text,
	PRIMARY KEY(`scope`, `fingerprint`)
) STRICT;
--> statement-breakpoint
CREATE TABLE `log_monitor_scans` (
	`scope` text PRIMARY KEY NOT NULL,
	`completed_to` integer,
	`pending_from` integer,
	`pending_to` integer,
	`owner` text,
	`lease_until` integer DEFAULT 0 NOT NULL
) STRICT;
