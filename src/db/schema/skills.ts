// First-class reusable skills persisted in SQLite.
//
// `solenoid-engine` owns skill handling (`open_skill`, `/<slug>` slash
// invocation, and paired tool-group unlocking); this table owns the durable
// content and metadata so built-in and user-created skills share one record.
import { check, index, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { boolTrue, inList, json, tsReq } from "./_shared";

export const SKILL_SOURCE = ["builtin", "user"] as const;
export type SkillSource = (typeof SKILL_SOURCE)[number];

export const skills = sqliteTable(
  "skills",
  {
    id: text().primaryKey(),
    slug: text().notNull().unique(),
    title: text().notNull(),
    description: text().notNull(),
    instructions: text().notNull(),
    toolGroups: json<string[]>().notNull(),
    slashCommand: boolTrue(),
    enabled: boolTrue(),
    source: text({ enum: SKILL_SOURCE }).notNull().default("user"),
    createdAt: tsReq(),
    updatedAt: tsReq(),
  },
  (t) => [
    check("skills_source_check", inList(t.source, SKILL_SOURCE)),
    index("skills_enabled_slug").on(t.enabled, t.slug),
  ],
);
