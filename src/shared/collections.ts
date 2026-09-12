export const COLLECTIONS = ["book", "movie", "tv", "game", "music"] as const;
export type Collection = (typeof COLLECTIONS)[number];
export const COLLECTION_LABELS: Record<Collection, string> = {
  book: "Books", movie: "Movies", tv: "TV", game: "Games", music: "Music",
};
export interface CollectionSource {
  id: string;
  screenshotUuid: string;
  filename: string;
  capturedAt: string;
  path: string;
  assetHash: string | null;
  classification: { classification: string; name: string };
  contentCard: { name: string; type: string; description: string; coverImageUrl: string; url: string };
  savedAt: string;
}
export interface CollectionItem {
  id: string;
  collection: Collection;
  name: string;
  type: string;
  description: string;
  url: string;
  coverImageUrl: string;
  notes: string;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  sources: CollectionSource[];
  imports: { pageId: string; pageUrl: string; importedAt: string; payload: unknown }[];
}
export interface CollectionsPayload { items: CollectionItem[]; total: number }
/** External data can retain its original URL, but only web links are navigable. */
export function webUrl(value: string): string | undefined {
  try { const url = new URL(value); return ["https:", "http:"].includes(url.protocol) ? url.href : undefined; }
  catch { return undefined; }
}
