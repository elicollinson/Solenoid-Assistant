ALTER TABLE `conversations` ADD `model` text;--> statement-breakpoint
ALTER TABLE `conversations` ADD `voice_invoked` integer DEFAULT false NOT NULL;