// The `skills` tool group: read, create, update, and delete first-class
// reusable skills stored in the local SQLite `skills` table.
import { SKILL_NAME_RE } from "@elicollinson/solenoid-engine";
import { z } from "zod";
import { defineTool } from "../core/tools";
import { defineToolGroup } from "../core/toolGroups";
import { describeTable } from "../db/schemaDoc";
import * as s from "../db/schema";
import {
  createSkill,
  deleteSkill,
  getSkillBySlug,
  listSkills,
  updateSkill,
} from "../db/skills";
import type { ToolGroupContext } from "./groups";

const VALID_GROUPS = [
  "recommendations",
  "reminders",
  "calendar",
  "workflows",
  "logs",
  "github",
  "knowledge",
  "activity",
  "okf",
  "imessage",
  "photos",
  "contacts",
  "pushover",
  "skills",
] as const;

const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(
    SKILL_NAME_RE,
    "Must start with a lowercase letter and contain only a-z, 0-9, _ or - (e.g. 'morning-briefing')",
  );

const toolGroupsSchema = z
  .array(z.enum(VALID_GROUPS))
  .describe("Optional Solenoid tool groups unlocked when this skill runs (empty array for pure prose skills)");

export function skillsGroup(context: ToolGroupContext) {
  return defineToolGroup({
    name: "skills",
    title: "Reusable skills",
    summary:
      "Read, create, update, or remove reusable Solenoid skills and slash commands stored in the local skills table.",
    purpose:
      "Skills are reusable playbooks stored in SQLite that Solenoid can load on demand via open_skill or invoke directly via /<slug> in chat. Each skill holds a concise trigger description, full instructions, and optional paired tool groups.",
    guidance:
      "Always call skills_list before creating a new skill to avoid duplicates and match existing conventions. Creating, updating, or deleting a skill is a write and will pause for the user's explicit approval. Built-in skills may be updated or disabled but cannot be deleted.",
    shape: {
      singular: "skill",
      spine: describeTable(s.skills, {
        id: null,
        slug: "Unique lowercase identifier used by open_skill and /<slug> slash commands",
        title: "Short human-readable display name shown in the slash picker",
        description: "One-line trigger description visible before the skill is opened",
        instructions: "Full playbook loaded on demand when the skill is opened or invoked",
        toolGroups: "JSON list of Solenoid tool group names unlocked alongside this skill",
        slashCommand: "Whether /<slug> direct invocation is enabled in chat",
        enabled: "Whether the skill is active and discoverable",
        source: "'builtin' for seeded defaults or 'user' for custom skills",
        createdAt: null,
        updatedAt: null,
      }),
    },
    tools: [
      defineTool({
        name: "skills_list",
        kind: "read",
        description:
          "List reusable skills stored in SQLite (slug, title, description, toolGroups, slashCommand, enabled, source). Omit full instructions to keep results compact; call skills_get to inspect one skill in full.",
        schema: z.strictObject({
          includeDisabled: z
            .boolean()
            .optional()
            .describe("Include disabled skills too (defaults to false)"),
        }),
        execute: ({ includeDisabled }) => ({
          skills: listSkills(context.db, { includeDisabled: Boolean(includeDisabled) }).map(
            (skill) => ({
              slug: skill.slug,
              title: skill.title,
              description: skill.description,
              toolGroups: skill.toolGroups,
              slashCommand: skill.slashCommand,
              enabled: skill.enabled,
              source: skill.source,
            }),
          ),
        }),
      }),
      defineTool({
        name: "skills_get",
        kind: "read",
        description:
          "Read one reusable skill by slug, including its full instructions and paired toolGroups.",
        schema: z.strictObject({
          slug: slugSchema.describe("Slug of the skill to inspect"),
          includeDisabled: z.boolean().optional(),
        }),
        execute: ({ slug, includeDisabled }) => {
          const skill = getSkillBySlug(context.db, slug, {
            includeDisabled: Boolean(includeDisabled),
          });
          if (!skill) {
            return { found: false, error: `No skill named "${slug}" found.` };
          }
          return {
            found: true,
            skill: {
              slug: skill.slug,
              title: skill.title,
              description: skill.description,
              instructions: skill.instructions,
              toolGroups: skill.toolGroups,
              slashCommand: skill.slashCommand,
              enabled: skill.enabled,
              source: skill.source,
            },
          };
        },
      }),
      defineTool({
        name: "skills_create",
        kind: "write",
        description:
          "Save a new reusable skill into the local skills table so it becomes available via open_skill and /<slug> in chat. Always inspect existing skills first and describe the skill clearly before calling.",
        schema: z.strictObject({
          slug: slugSchema.describe("Unique lowercase slug, e.g. 'weekly-review'"),
          title: z.string().trim().min(1).max(120).describe("Short display title"),
          description: z
            .string()
            .trim()
            .min(1)
            .max(500)
            .describe("Clear one-line description of what this skill does and when to trigger it"),
          instructions: z
            .string()
            .trim()
            .min(1)
            .max(20_000)
            .describe("Full procedural playbook instructions"),
          toolGroups: toolGroupsSchema.optional().default([]),
          slashCommand: z
            .boolean()
            .optional()
            .default(true)
            .describe("Expose as /<slug> in the chat slash picker (defaults to true)"),
        }),
        execute: (args) => {
          const created = createSkill(context.db, {
            slug: args.slug,
            title: args.title,
            description: args.description,
            instructions: args.instructions,
            toolGroups: args.toolGroups,
            slashCommand: args.slashCommand,
          });
          return {
            created: true,
            slug: created.slug,
            title: created.title,
            slashCommand: created.slashCommand,
            toolGroups: created.toolGroups,
          };
        },
      }),
      defineTool({
        name: "skills_update",
        kind: "write",
        description:
          "Update an existing skill's title, description, instructions, paired toolGroups, slashCommand flag, or enabled state.",
        schema: z.strictObject({
          slug: slugSchema.describe("Slug of the existing skill to update"),
          title: z.string().trim().min(1).max(120).optional(),
          description: z.string().trim().min(1).max(500).optional(),
          instructions: z.string().trim().min(1).max(20_000).optional(),
          toolGroups: toolGroupsSchema.optional(),
          slashCommand: z.boolean().optional(),
          enabled: z.boolean().optional(),
        }),
        execute: ({ slug, ...patch }) => {
          const updated = updateSkill(context.db, slug, patch);
          return {
            updated: true,
            slug: updated.slug,
            title: updated.title,
            enabled: updated.enabled,
            slashCommand: updated.slashCommand,
            toolGroups: updated.toolGroups,
          };
        },
      }),
      defineTool({
        name: "skills_delete",
        kind: "write",
        description:
          "Permanently delete a user-created skill by slug. Built-in skills cannot be deleted (disable them via skills_update instead).",
        schema: z.strictObject({
          slug: slugSchema.describe("Slug of the user-created skill to delete"),
        }),
        execute: ({ slug }) => deleteSkill(context.db, slug),
      }),
    ],
  });
}
