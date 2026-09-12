import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CollectionCard } from "./CollectionsView";
import type { CollectionItem } from "../../../src/shared/collections";
const item: CollectionItem = {
  id: "one", name: "A Song", collection: "music", type: "Song", description: "A description", url: "javascript:alert(1)", coverImageUrl: "data:text/html,bad",
  notes: "My notes", archived: false, createdAt: "2026-09-12", updatedAt: "2026-09-12", imports: [],
  sources: [{ id: "source", screenshotUuid: "uuid1", filename: "song.png", path: "/tmp/song.png", assetHash: null, capturedAt: "2026-09-10", savedAt: "2026-09-12", classification: { classification: "Music", name: "A Song" }, contentCard: { name: "A Song", type: "Song", url: "https://example.com/song", description: "Original summary", coverImageUrl: "" } }],
};
test("collection details retain extraction, notes, provenance and safe links", () => {
  const html = renderToStaticMarkup(<CollectionCard item={item} open onOpen={() => {}} onSaved={() => {}} />);
  expect(html).toContain("Original summary"); expect(html).toContain("My notes"); expect(html).toContain("song.png");
  expect(html).toContain('type="submit"'); expect(html).toContain('aria-expanded="true"');
  expect(html).not.toContain("javascript:"); expect(html).not.toContain("data:text/html");
  expect(html).toContain('href="https://example.com/song"');
});
