-- `day_notes` becomes `surface_notes`, and the screen ledes leave `settings`.
--
-- Two lines the agent writes needed telling apart and could not be: the
-- calendar's "I have not touched anything after six this evening" and chat's
-- "Nothing has gone out since 09:39" are both today's restraint on the desktop,
-- and day_notes had one row for the pair of them. Every row it holds today is
-- the calendar's, so that is the screen they carry over as.
INSERT INTO `surface_notes` ("id", "screen", "surface", "slot", "on_date", "text", "generated_at", "model")
SELECT "id", 'calendar', "surface", "slot", "on_date", "text", "generated_at", "model" FROM `day_notes`;
--> statement-breakpoint
DROP TABLE `day_notes`;
--> statement-breakpoint
-- A lede is not something you configure. These sat in `settings` because it was
-- the only key/value store there was; now that the Settings screen has made that
-- table mean "what I run on", they move to the screens they are about. The
-- overnight line is about a day and has no date on it here, so it is dropped
-- rather than dated wrongly — the seed writes it back.
DELETE FROM `settings` WHERE "key" = 'home.lede.overnight';
--> statement-breakpoint
INSERT INTO `surface_notes` ("id", "screen", "surface", "slot", "on_date", "text", "generated_at", "model")
SELECT
  lower(hex(randomblob(16))),
  replace("key", '.lede', ''),
  'desktop',
  'line',
  NULL,
  json_extract("value", '$'),
  "updated_at",
  NULL
FROM `settings`
WHERE "key" IN ('workflows.lede', 'reminders.lede', 'recommendations.lede');
--> statement-breakpoint
DELETE FROM `settings` WHERE "key" IN ('workflows.lede', 'reminders.lede', 'recommendations.lede');
--> statement-breakpoint
-- The one row in there that really is a setting.
UPDATE `settings` SET "source" = 'user', "updated_by" = 'user' WHERE "key" = 'user.displayName';
