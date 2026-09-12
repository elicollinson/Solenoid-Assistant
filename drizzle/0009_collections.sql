CREATE TABLE `collection_items` (
	`id` text PRIMARY KEY NOT NULL,
	`collection` text NOT NULL,
	`identity` text NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`description` text NOT NULL,
	`url` text NOT NULL,
	`cover_image_url` text NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`archived` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "collection_items_collection_check" CHECK("collection_items"."collection" in ('book','movie','tv','game','music')),
	CONSTRAINT "collection_items_archived_check" CHECK("collection_items"."archived" in ('0','1'))
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `collection_items_identity` ON `collection_items` (`collection`,`identity`);--> statement-breakpoint
CREATE INDEX `collection_items_created` ON `collection_items` (`created_at`);--> statement-breakpoint
CREATE TABLE `collection_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`screenshot_uuid` text NOT NULL,
	`filename` text NOT NULL,
	`captured_at` text NOT NULL,
	`path` text NOT NULL,
	`asset_hash` text,
	`classification` text NOT NULL,
	`content_card` text NOT NULL,
	`saved_at` integer NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `collection_items`(`id`) ON UPDATE no action ON DELETE cascade
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `collection_sources_screenshot` ON `collection_sources` (`screenshot_uuid`);--> statement-breakpoint
CREATE INDEX `collection_sources_item` ON `collection_sources` (`item_id`);