import { and, eq } from "drizzle-orm";
import { ulid, type Db } from "../index";
import * as s from "../schema";
import type { ClassificationResult, ContentCard } from "../../prompts";
import { webUrl, type Collection } from "../../shared/collections";
import { auditDomain, rowMutationHandler } from "../../core/writeExecution";

export interface ExtractedCollectionInput {
  uuid: string; filename: string; date: string; path: string;
  classification: ClassificationResult; contentCard: ContentCard; collection: Collection;
}
export interface LocalIngestionResult { status: "created" | "updated"; itemId: string }
export function collectionSourceExists(db: Db, uuid: string): boolean {
  return !!db.select({ id: s.collectionSources.id }).from(s.collectionSources).where(eq(s.collectionSources.screenshotUuid, uuid)).get();
}
function identity(card: ContentCard): string {
  const url = webUrl(card.url);
  if (url) { const parsed = new URL(url); parsed.hash = ""; return `url:${parsed.href}`; }
  return `name:${card.name.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase()}`;
}
/** Item and its processing receipt commit together. Retrying never loses provenance. */
function saveExtractedCollectionItemImpl(db: Db, input: ExtractedCollectionInput, now = new Date()): LocalIngestionResult {
  if (!input.contentCard.name.trim()) throw new Error("An extracted item needs a name");
  return db.transaction((tx) => {
    const existingSource = tx.select().from(s.collectionSources).where(eq(s.collectionSources.screenshotUuid, input.uuid)).get();
    if (existingSource) return { status: "updated", itemId: existingSource.itemId };
    const key = identity(input.contentCard);
    const existing = tx.select().from(s.collectionItems).where(and(eq(s.collectionItems.collection, input.collection), eq(s.collectionItems.identity, key))).get();
    const itemId = existing?.id ?? ulid();
    if (!existing) tx.insert(s.collectionItems).values({
      id: itemId, collection: input.collection, identity: key, ...input.contentCard,
      createdAt: now, updatedAt: now,
    }).run();
    // Preserve user edits and archive decisions when another screenshot matches.
    const photo = tx.select().from(s.sourceRecords).where(and(eq(s.sourceRecords.kind, "photos"), eq(s.sourceRecords.id, input.uuid))).get();
    const payload = photo?.payload ? JSON.parse(photo.payload) : null;
    tx.insert(s.collectionSources).values({
      id: ulid(), itemId, screenshotUuid: input.uuid, filename: input.filename,
      capturedAt: input.date, path: input.path, assetHash: typeof payload?.hash === "string" ? payload.hash : null,
      classification: input.classification, contentCard: input.contentCard, savedAt: now,
    }).run();
    return { status: existing ? "updated" : "created", itemId };
  });
}
export function editCollectionItem(db: Db, id: string, patch: { name?: string; description?: string; notes?: string; archived?: boolean }): boolean {
  return auditDomain("collections_edit", () => {
    const edit = () => editCollectionItemImpl(db, id, patch);
    const capture = rowMutationHandler();
    const fields = Object.keys(patch).filter(k => patch[k as keyof typeof patch] !== undefined);
    return capture && fields.length ? capture("collection_items", id, fields, edit) : edit();
  }, id);
}
function editCollectionItemImpl(db: Db, id: string, patch: { name?: string; description?: string; notes?: string; archived?: boolean }): boolean {
  if (patch.name !== undefined && !patch.name.trim()) throw new Error("An item needs a name");
  return db.update(s.collectionItems).set({ ...patch, ...(patch.name !== undefined ? { name: patch.name.trim() } : {}), updatedAt: new Date() }).where(eq(s.collectionItems.id, id)).returning({ id: s.collectionItems.id }).all().length > 0;
}
export function saveExtractedCollectionItem(...args: Parameters<typeof saveExtractedCollectionItemImpl>): LocalIngestionResult {
  return auditDomain("collections_save", () => saveExtractedCollectionItemImpl(...args), args[1].uuid);
}
