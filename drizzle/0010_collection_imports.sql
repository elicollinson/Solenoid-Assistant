CREATE TABLE `collection_imports` (
	`page_id` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`page_url` text NOT NULL,
	`payload` text NOT NULL,
	`imported_at` integer NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `collection_items`(`id`) ON UPDATE no action ON DELETE cascade
) STRICT;
--> statement-breakpoint
CREATE INDEX `collection_imports_item` ON `collection_imports` (`item_id`);