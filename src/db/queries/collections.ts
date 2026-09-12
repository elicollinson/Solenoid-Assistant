import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import type { Db } from "../index";
import * as s from "../schema";
import type { Collection, CollectionItem, CollectionsPayload } from "../../shared/collections";
export interface CollectionFilters { collection?: Collection; q?: string; archived?: boolean; offset?: number; limit?: number }
export function loadCollections(db: Db, filters: CollectionFilters = {}): CollectionsPayload {
  const q = filters.q?.trim();
  const condition = and(
    filters.collection ? eq(s.collectionItems.collection, filters.collection) : undefined,
    filters.archived === undefined ? undefined : eq(s.collectionItems.archived, filters.archived),
    q ? or(...[s.collectionItems.name, s.collectionItems.description, s.collectionItems.notes].map((col) => sql`${col} LIKE ${`%${q.replace(/[!%_]/g, "!$&")}%`} ESCAPE '!'`)) : undefined,
  );
  const total = db.select({ count: sql<number>`count(*)` }).from(s.collectionItems).where(condition).get()!.count;
  const rows = db.select().from(s.collectionItems).where(condition).orderBy(desc(s.collectionItems.createdAt), desc(s.collectionItems.id)).limit(filters.limit ?? 100).offset(filters.offset ?? 0).all();
  const sources = rows.length ? db.select().from(s.collectionSources).where(inArray(s.collectionSources.itemId, rows.map((r) => r.id))).orderBy(desc(s.collectionSources.savedAt)).all() : [];
  const imports = rows.length ? db.select().from(s.collectionImports).where(inArray(s.collectionImports.itemId, rows.map((r) => r.id))).all() : [];
  return { total, items: rows.map(({ identity, ...row }): CollectionItem => ({
    ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
    imports: imports.filter((entry) => entry.itemId === row.id).map(({ itemId, ...entry }) => ({ ...entry, importedAt: entry.importedAt.toISOString() })),
    sources: sources.filter((source) => source.itemId === row.id).map(({ itemId, ...source }) => ({ ...source, savedAt: source.savedAt.toISOString() })),
  })) };
}
