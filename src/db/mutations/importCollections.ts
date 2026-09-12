// Offline adapter for the saved historical collection snapshot. No network access.
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { ulid, type Db } from "../index";
import * as s from "../schema";
import { COLLECTIONS, type Collection } from "../../shared/collections";
import { webUrl } from "../../shared/collections";

const record = z.record(z.string(), z.unknown());
const pageSchema = z.object({ id: z.string().min(1), url: z.string(), properties: z.record(z.string(), record), cover: record.nullable().optional(), created_time: z.string().optional() }).passthrough();
export const collectionSnapshotSchema = z.object({
  version: z.literal(1), fetchedAt: z.string(),
  records: z.array(z.object({ collection: z.enum(COLLECTIONS), page: pageSchema, blocks: z.array(record) })),
});
export type CollectionSnapshot = z.infer<typeof collectionSnapshotSchema>;
function richText(value: unknown): string {
  return Array.isArray(value) ? value.map((v) => typeof v?.plain_text === "string" ? v.plain_text : typeof v?.text?.content === "string" ? v.text.content : "").join("") : "";
}
function fileUrl(value: unknown): string {
  const obj = value as { external?: { url?: string }; file?: { url?: string } } | null;
  return obj?.external?.url ?? obj?.file?.url ?? "";
}
export function importCollectionSnapshot(db: Db, raw: unknown) {
  const snapshot = collectionSnapshotSchema.parse(raw);
  let created = 0, skipped = 0;
  db.transaction((tx) => {
    for (const entry of snapshot.records) {
      const page = entry.page;
      const receipt = tx.select().from(s.collectionImports).where(eq(s.collectionImports.pageId, page.id)).get();
      if (receipt) {
        if (JSON.stringify(receipt.payload) !== JSON.stringify(entry)) throw new Error(`Previously imported Notion page ${page.id} differs from this snapshot; import rolled back`);
        skipped++;
        continue;
      }
      const props = Object.values(page.properties);
      const name = richText(props.find((p) => p.type === "title" || Array.isArray(p.title))?.title).trim();
      if (!name) throw new Error(`Notion page ${page.id} has no title; import rolled back`);
      const property = (key: string) => Object.entries(page.properties).find(([k]) => k.toLowerCase() === key)?.[1];
      const description = richText(property("description")?.rich_text);
      const url = String(property("url")?.url ?? props.find((p) => p.type === "url")?.url ?? "");
      const coverImageUrl = fileUrl(page.cover) || fileUrl((property("image")?.files as unknown[])?.[0]);
      const now = new Date(snapshot.fetchedAt);
      if (!Number.isFinite(now.getTime())) throw new Error("Invalid snapshot date");
      const normalized = webUrl(url);
      const parsed = normalized ? new URL(normalized) : null;
      if (parsed) parsed.hash = "";
      // Without a source URL, do not conflate same-title historical records.
      const identity = parsed ? `url:${parsed.href}` : `notion:${page.id}`;
      const existing = tx.select().from(s.collectionItems).where(and(eq(s.collectionItems.collection, entry.collection), eq(s.collectionItems.identity, identity))).get();
      const itemId = existing?.id ?? ulid();
      if (!existing) tx.insert(s.collectionItems).values({
        id: itemId, identity, collection: entry.collection, name,
        type: ({ book: "Book", movie: "Movie", tv: "TV Show", game: "Game", music: "Music" } satisfies Record<Collection, string>)[entry.collection],
        description, url, coverImageUrl, createdAt: now, updatedAt: now,
      }).run();
      tx.insert(s.collectionImports).values({ pageId: page.id, itemId, pageUrl: page.url, payload: entry, importedAt: now }).run();
      created++;
    }
  });
  // Verify every source receipt, including rows skipped on repeat imports.
  const verified = snapshot.records.filter((entry) => {
    const stored = db.select().from(s.collectionImports).where(eq(s.collectionImports.pageId, entry.page.id)).get();
    return stored && JSON.stringify(stored.payload) === JSON.stringify(entry);
  }).length;
  if (verified !== snapshot.records.length) throw new Error("Import verification failed: a previously imported record differs from this snapshot; its original data and user edits were preserved");
  return { records: snapshot.records.length, imported: created, skipped, verified };
}

