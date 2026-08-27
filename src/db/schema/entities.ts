// The supertype. Every citable, linkable, narratable thing gets a row here
// first, and each domain table's primary key is also a foreign key into it.
import { index, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { check } from "drizzle-orm/sqlite-core";
import { ENTITY_KIND, inList, ts, tsReq } from "./_shared";

export const entities = sqliteTable("entities", {
  id: text().primaryKey(),
  kind: text({ enum: ENTITY_KIND }).notNull(),
  createdAt: tsReq(),
  updatedAt: tsReq(),
  /** Soft delete. Read views filter on this so there is one place to forget. */
  deletedAt: ts(),
}, (t) => [
  check("entities_kind_check", inList(t.kind, ENTITY_KIND)),
  index("entities_kind_created").on(t.kind, t.createdAt).where(sql`${t.deletedAt} is null`),
]);

/** `id TEXT PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE` */
export const entityId = () =>
  text().primaryKey().references(() => entities.id, { onDelete: "cascade" });

/** A required reference to any entity. */
export const entityRef = () =>
  text().notNull().references(() => entities.id, { onDelete: "cascade" });

/** An optional reference to any entity, nulled rather than cascaded. Use this
 *  when the row stands on its own once the thing it points at is gone. */
export const entityRefNull = () =>
  text().references(() => entities.id, { onDelete: "set null" });

/** An optional reference whose row is meaningless without its target - a
 *  decision with no subject, a calendar row projecting a deleted run. */
export const entityRefOwned = () =>
  text().references(() => entities.id, { onDelete: "cascade" });
