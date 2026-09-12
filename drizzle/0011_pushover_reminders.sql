CREATE TABLE `push_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`reminder_id` text,
	`scheduled_for` integer NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`payload_hash` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer DEFAULT 0 NOT NULL,
	`updated_at` integer DEFAULT 0 NOT NULL,
	`provider_request_id` text,
	`error_code` text,
	FOREIGN KEY (`reminder_id`) REFERENCES `reminders`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "push_state_check" CHECK("push_deliveries"."state" in ('pending','submitting','accepted','rejected','unknown','cancelled'))
) STRICT;
--> statement-breakpoint
CREATE INDEX `push_pending` ON `push_deliveries` (`state`,`next_attempt_at`,`scheduled_for`);--> statement-breakpoint
CREATE INDEX `push_reminder` ON `push_deliveries` (`reminder_id`);--> statement-breakpoint
CREATE TABLE `push_provider_state` (
	`provider` text PRIMARY KEY NOT NULL,
	`blocked_until` integer DEFAULT 0 NOT NULL
) STRICT;
--> statement-breakpoint
-- Schedule changes commit atomically with reminder writes, regardless of caller.
CREATE TRIGGER reminder_push_created AFTER INSERT ON reminders
WHEN NEW.due_at IS NOT NULL AND NEW.completed_at IS NULL AND NEW.state NOT IN ('done','cancelled')
BEGIN
  INSERT INTO push_deliveries (id, reminder_id, scheduled_for)
  VALUES ('reminder:' || lower(hex(randomblob(16))), NEW.id, max(NEW.due_at, coalesce(NEW.snoozed_until, NEW.due_at)));
END;
--> statement-breakpoint
CREATE TRIGGER reminder_push_rescheduled AFTER UPDATE OF due_at, snoozed_until, state, completed_at ON reminders
WHEN OLD.due_at IS NOT NEW.due_at OR OLD.snoozed_until IS NOT NEW.snoozed_until
  OR ((OLD.completed_at IS NOT NULL OR OLD.state IN ('done','cancelled')) AND NEW.completed_at IS NULL AND NEW.state NOT IN ('done','cancelled'))
BEGIN
  UPDATE push_deliveries SET state = 'cancelled', error_code = 'rescheduled'
  WHERE reminder_id = NEW.id AND state = 'pending';
  INSERT INTO push_deliveries (id, reminder_id, scheduled_for)
  SELECT 'reminder:' || lower(hex(randomblob(16))), NEW.id, max(NEW.due_at, coalesce(NEW.snoozed_until, NEW.due_at))
  WHERE NEW.due_at IS NOT NULL AND NEW.completed_at IS NULL AND NEW.state NOT IN ('done','cancelled');
END;
--> statement-breakpoint
CREATE TRIGGER reminder_push_closed AFTER UPDATE OF state, completed_at ON reminders
WHEN NEW.completed_at IS NOT NULL OR NEW.state IN ('done','cancelled')
BEGIN
  UPDATE push_deliveries SET state = 'cancelled', error_code = 'reminder_closed'
  WHERE reminder_id = NEW.id AND state = 'pending';
END;
--> statement-breakpoint
INSERT INTO push_deliveries (id, reminder_id, scheduled_for)
SELECT 'reminder:' || lower(hex(randomblob(16))), id, max(due_at, coalesce(snoozed_until, due_at))
FROM reminders WHERE due_at IS NOT NULL AND completed_at IS NULL AND state NOT IN ('done','cancelled');
