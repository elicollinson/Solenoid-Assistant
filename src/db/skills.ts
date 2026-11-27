// Durable SQLite-backed `SkillStore` and CRUD mutations for first-class skills.
import { SKILL_NAME_RE, type Skill, type SkillStore } from "@elicollinson/solenoid-engine";
import { asc, eq } from "drizzle-orm";
import { ulid, type Db } from "./index";
import * as s from "./schema";
import { BUILTIN_SKILLS } from "../skills/builtins";

export interface SkillRecord extends Skill {
  id: string;
  slug: string;
  title: string;
  toolGroups: string[];
  slashCommand: boolean;
  enabled: boolean;
  source: s.SkillSource;
  createdAt: Date;
  updatedAt: Date;
}

export class SkillAlreadyExistsError extends Error {
  constructor(slug: string) {
    super(`A skill named "${slug}" already exists.`);
    this.name = "SkillAlreadyExistsError";
  }
}

export class NoSuchSkillError extends Error {
  constructor(slug: string) {
    super(`No skill named "${slug}" exists.`);
    this.name = "NoSuchSkillError";
  }
}

export class InvalidSkillSlugError extends Error {
  constructor(slug: string) {
    super(
      `Invalid skill slug "${slug}": must start with a lowercase letter and contain only a-z, 0-9, _ or -.`,
    );
    this.name = "InvalidSkillSlugError";
  }
}

function normalizeSlug(raw: string): string {
  const slug = raw.trim().toLowerCase();
  if (!SKILL_NAME_RE.test(slug)) {
    throw new InvalidSkillSlugError(raw);
  }
  return slug;
}

function rowToRecord(row: typeof s.skills.$inferSelect): SkillRecord {
  return {
    id: row.id,
    slug: row.slug,
    name: row.slug,
    title: row.title,
    description: row.description,
    instructions: row.instructions,
    toolGroups: Array.isArray(row.toolGroups) ? row.toolGroups : [],
    slashCommand: Boolean(row.slashCommand),
    enabled: Boolean(row.enabled),
    source: row.source,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Seed any missing built-in skills (`intro`, `create-skill`) into SQLite.
 * Strictly additive (`onConflictDoNothing` by slug) — existing user edits are
 * never overwritten on restart or migration.
 */
export function ensureBuiltinSkills(db: Db, now: Date = new Date()): { added: number } {
  let added = 0;
  db.transaction((tx) => {
    for (const skill of BUILTIN_SKILLS) {
      const existing = tx
        .select({ id: s.skills.id })
        .from(s.skills)
        .where(eq(s.skills.slug, skill.name))
        .get();
      if (existing) continue;

      tx.insert(s.skills)
        .values({
          id: ulid(now.getTime()),
          slug: skill.name,
          title: skill.title ?? skill.name,
          description: skill.description,
          instructions: skill.instructions,
          toolGroups: [...(skill.toolGroups ?? [])],
          slashCommand: skill.slashCommand ?? true,
          enabled: skill.enabled ?? true,
          source: "builtin",
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing({ target: s.skills.slug })
        .run();
      added += 1;
    }
  });
  return { added };
}

/** List all skills (optionally including disabled rows), ordered alphabetically by slug. */
export function listSkills(
  db: Db,
  options: { includeDisabled?: boolean } = {},
): SkillRecord[] {
  const rows = options.includeDisabled
    ? db.select().from(s.skills).orderBy(asc(s.skills.slug)).all()
    : db
        .select()
        .from(s.skills)
        .where(eq(s.skills.enabled, true))
        .orderBy(asc(s.skills.slug))
        .all();
  return rows.map(rowToRecord);
}

/** Read one skill by slug (returns undefined if missing, or if disabled unless requested). */
export function getSkillBySlug(
  db: Db,
  rawSlug: string,
  options: { includeDisabled?: boolean } = {},
): SkillRecord | undefined {
  const slug = rawSlug.trim().toLowerCase();
  if (!slug) return undefined;
  const row = db.select().from(s.skills).where(eq(s.skills.slug, slug)).get();
  if (!row) return undefined;
  if (!options.includeDisabled && !row.enabled) return undefined;
  return rowToRecord(row);
}

export interface CreateSkillInput {
  slug: string;
  title: string;
  description: string;
  instructions: string;
  toolGroups?: readonly string[];
  slashCommand?: boolean;
  enabled?: boolean;
  source?: s.SkillSource;
}

export function createSkill(
  db: Db,
  input: CreateSkillInput,
  now: Date = new Date(),
): SkillRecord {
  const slug = normalizeSlug(input.slug);
  const title = input.title.trim();
  const description = input.description.trim();
  const instructions = input.instructions.trim();
  if (!title) throw new Error("Skill title cannot be empty.");
  if (!description) throw new Error("Skill description cannot be empty.");
  if (!instructions) throw new Error("Skill instructions cannot be empty.");

  const existing = db.select({ id: s.skills.id }).from(s.skills).where(eq(s.skills.slug, slug)).get();
  if (existing) throw new SkillAlreadyExistsError(slug);

  const id = ulid(now.getTime());
  const toolGroups = [...new Set((input.toolGroups ?? []).map((g) => g.trim()).filter(Boolean))];
  db.insert(s.skills)
    .values({
      id,
      slug,
      title,
      description,
      instructions,
      toolGroups,
      slashCommand: input.slashCommand ?? true,
      enabled: input.enabled ?? true,
      source: input.source ?? "user",
      createdAt: now,
      updatedAt: now,
    })
    .run();

  return getSkillBySlug(db, slug, { includeDisabled: true })!;
}

export interface UpdateSkillPatch {
  title?: string;
  description?: string;
  instructions?: string;
  toolGroups?: readonly string[];
  slashCommand?: boolean;
  enabled?: boolean;
}

export function updateSkill(
  db: Db,
  rawSlug: string,
  patch: UpdateSkillPatch,
  now: Date = new Date(),
): SkillRecord {
  const slug = normalizeSlug(rawSlug);
  const existing = db.select().from(s.skills).where(eq(s.skills.slug, slug)).get();
  if (!existing) throw new NoSuchSkillError(slug);

  const updates: Partial<typeof s.skills.$inferInsert> = { updatedAt: now };
  if (patch.title !== undefined) {
    const title = patch.title.trim();
    if (!title) throw new Error("Skill title cannot be empty.");
    updates.title = title;
  }
  if (patch.description !== undefined) {
    const description = patch.description.trim();
    if (!description) throw new Error("Skill description cannot be empty.");
    updates.description = description;
  }
  if (patch.instructions !== undefined) {
    const instructions = patch.instructions.trim();
    if (!instructions) throw new Error("Skill instructions cannot be empty.");
    updates.instructions = instructions;
  }
  if (patch.toolGroups !== undefined) {
    updates.toolGroups = [...new Set(patch.toolGroups.map((g) => g.trim()).filter(Boolean))];
  }
  if (patch.slashCommand !== undefined) {
    updates.slashCommand = patch.slashCommand;
  }
  if (patch.enabled !== undefined) {
    updates.enabled = patch.enabled;
  }

  db.update(s.skills).set(updates).where(eq(s.skills.id, existing.id)).run();
  return getSkillBySlug(db, slug, { includeDisabled: true })!;
}

export function deleteSkill(db: Db, rawSlug: string): { slug: string; deleted: true } {
  const slug = normalizeSlug(rawSlug);
  const existing = db.select().from(s.skills).where(eq(s.skills.slug, slug)).get();
  if (!existing) throw new NoSuchSkillError(slug);
  if (existing.source === "builtin") {
    throw new Error(
      `Built-in skill "${slug}" cannot be deleted; disable it with skills_update({ slug: "${slug}", enabled: false }) instead.`,
    );
  }
  db.delete(s.skills).where(eq(s.skills.id, existing.id)).run();
  return { slug, deleted: true };
}

/**
 * Synchronous Drizzle implementation of `@elicollinson/solenoid-engine`'s `SkillStore`.
 * Reads live from the SQLite `skills` table on every `list()` / `get()` call so
 * newly created or updated skills take effect immediately.
 */
export class DrizzleSkillStore implements SkillStore {
  constructor(private readonly db: Db) {}

  list(): readonly Skill[] {
    return listSkills(this.db, { includeDisabled: false });
  }

  get(name: string): Skill | undefined {
    return getSkillBySlug(this.db, name, { includeDisabled: false });
  }

  listSlashCommands(): Array<{
    name: string;
    title: string;
    description: string;
    source: s.SkillSource;
  }> {
    return listSkills(this.db, { includeDisabled: false })
      .filter((skill) => skill.slashCommand)
      .map((skill) => ({
        name: skill.slug,
        title: skill.title,
        description: skill.description,
        source: skill.source,
      }));
  }
}
