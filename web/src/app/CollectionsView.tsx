import { useState, type CSSProperties } from "react";
import { Button, MonoLabel } from "../kit";
import { useCollections, saveCollectionItem } from "./api";
import { COLLECTIONS, COLLECTION_LABELS, webUrl, type CollectionItem } from "../../../src/shared/collections";

const field: CSSProperties = { boxSizing: "border-box", width: "100%", padding: "var(--sp-3)", background: "var(--surface-panel)", color: "var(--text-1)", border: "var(--border-strong)", font: "var(--text-body-sm)" };
export function CollectionsView({ phone = false }: { phone?: boolean }) {
  const [collection, setCollection] = useState("");
  const [q, setQ] = useState("");
  const [archived, setArchived] = useState("false");
  const [offset, setOffset] = useState(0);
  const [nonce, setNonce] = useState(0);
  const [open, setOpen] = useState<string | null>(null);
  const query = new URLSearchParams({ q, archived, offset: String(offset), limit: "30", ...(collection ? { collection } : {}) });
  const result = useCollections(query.toString(), nonce);
  const changed = () => { setOffset(0); setOpen(null); };
  return <main style={{ gridColumn: "2 / -1", overflow: "auto", minHeight: 0, padding: phone ? "var(--sp-5)" : "var(--sp-8)", display: "flex", flexDirection: "column", gap: "var(--sp-5)" }}>
    <MonoLabel>Your collections</MonoLabel>
    <h1 style={{ margin: 0, color: "var(--text-1)", font: "var(--text-title)" }}>Saved from screenshots</h1>
    <p style={{ margin: 0 }}>Books, shows, music and other discoveries, with the sources they came from.</p>
    <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--sp-3)" }}>
      <a href="/api/collections/export" download>Export all data</a>
      <Button size="sm" variant="bare" onClick={() => setNonce((n) => n + 1)}>Refresh</Button>
    </div>
    <label>Search<input style={field} type="search" value={q} placeholder="Title, description or notes" onChange={(e) => { setQ(e.target.value); changed(); }} /></label>
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--sp-3)" }}>
      <label>Collection<select style={field} value={collection} onChange={(e) => { setCollection(e.target.value); changed(); }}><option value="">All collections</option>{COLLECTIONS.map((key) => <option key={key} value={key}>{COLLECTION_LABELS[key]}</option>)}</select></label>
      <label>Show<select style={field} value={archived} onChange={(e) => { setArchived(e.target.value); changed(); }}><option value="false">Saved</option><option value="true">Archived</option></select></label>
    </div>
    {result.status === "loading" ? <p>Reading collections…</p> : null}
    {result.status === "error" ? <p role="alert">Could not read collections: {result.message}</p> : null}
    {result.status === "ready" ? <>
      <MonoLabel>{result.data.total} {result.data.total === 1 ? "item" : "items"}</MonoLabel>
      {!result.data.items.length ? <p>{q || collection || archived === "true" ? "No items match these filters." : "Your next screenshot ingestion will save discoveries here. Historical Notion collections can be imported separately."}</p> : null}
      {result.data.items.map((item) => <CollectionCard key={`${item.id}:${item.updatedAt}`} item={item} open={open === item.id} onOpen={() => setOpen(open === item.id ? null : item.id)} onSaved={() => setNonce((n) => n + 1)} />)}
      <div style={{ display: "flex", gap: "var(--sp-3)" }}>
        <Button size="sm" disabled={offset === 0} onClick={() => { setOffset(Math.max(0, offset - 30)); setOpen(null); }}>Previous</Button>
        <Button size="sm" disabled={offset + 30 >= result.data.total} onClick={() => { setOffset(offset + 30); setOpen(null); }}>Next</Button>
      </div>
    </> : null}
  </main>;
}
export function CollectionCard({ item, open, onOpen, onSaved }: { item: CollectionItem; open: boolean; onOpen: () => void; onSaved: () => void }) {
  const [name, setName] = useState(item.name);
  const [description, setDescription] = useState(item.description);
  const [notes, setNotes] = useState(item.notes);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function save(patch: Parameters<typeof saveCollectionItem>[1]) {
    setBusy(true); setError("");
    try { await saveCollectionItem(item.id, patch); onSaved(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  const url = webUrl(item.url), cover = webUrl(item.coverImageUrl);
  return <article style={{ borderTop: "var(--border)", paddingTop: "var(--sp-5)", display: "flex", flexDirection: "column", gap: "var(--sp-3)", overflowWrap: "anywhere" }}>
    <div style={{ display: "flex", gap: "var(--sp-5)" }}>
      {cover ? <img src={cover} referrerPolicy="no-referrer" loading="lazy" alt="" style={{ width: 64, height: 88, objectFit: "cover" }} /> : null}
      <div><MonoLabel>{COLLECTION_LABELS[item.collection]} · {item.type}</MonoLabel><h2 style={{ margin: "var(--sp-3) 0", font: "var(--text-body)", color: "var(--text-1)" }}>{item.name}</h2><p style={{ margin: 0 }}>{item.description}</p></div>
    </div>
    <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--sp-3)", alignItems: "center" }}>
      {url ? <a href={url} target="_blank" rel="noreferrer">Open source page</a> : null}
      <button style={{ ...field, width: "auto", cursor: "pointer" }} type="button" aria-expanded={open} onClick={onOpen}>{open ? "Close details" : `Details · ${item.sources.length + item.imports.length} ${item.sources.length + item.imports.length === 1 ? "source" : "sources"}`}</button>
      <Button size="sm" variant="bare" disabled={busy} onClick={() => save({ archived: !item.archived })}>{item.archived ? "Restore" : "Archive"}</Button>
    </div>
    {error ? <p role="alert">{error}</p> : null}
    {open ? <>
      <form onSubmit={(e) => { e.preventDefault(); void save({ name, description, notes }); }} style={{ display: "grid", gap: "var(--sp-3)" }}>
        <label>Title<input required maxLength={1000} style={field} value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label>Description<textarea maxLength={20000} style={field} rows={3} value={description} onChange={(e) => setDescription(e.target.value)} /></label>
        <label>Your notes<textarea maxLength={20000} style={field} rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} /></label>
        <button style={{ ...field, width: "auto", cursor: "pointer" }} type="submit" disabled={busy}>{busy ? "Saving…" : "Save changes"}</button>
      </form>
      <MonoLabel>Original sources</MonoLabel>
      {item.imports.map((entry) => <div key={entry.pageId}>
        <p>Imported from Notion · {entry.importedAt}</p>
        {webUrl(entry.pageUrl) ? <a href={webUrl(entry.pageUrl)} target="_blank" rel="noreferrer">Original Notion record</a> : null}
        <p>The full original record, including additional properties and page content, is included in your export.</p>
      </div>)}
      {item.sources.map((source) => <div key={source.id} style={{ padding: "var(--sp-3)", background: "var(--surface-panel)" }}>
        <div>{source.filename} · {source.capturedAt}</div>
        <p>{source.classification.classification}: {source.classification.name}</p>
        <p>{source.contentCard.description}</p>
        {webUrl(source.contentCard.url) ? <a href={webUrl(source.contentCard.url)} target="_blank" rel="noreferrer">Extracted source page</a> : null}
        {source.assetHash ? <p><a href={`/api/collections/sources/${encodeURIComponent(source.id)}/image`} target="_blank" rel="noreferrer">View screenshot</a></p> : <p>Screenshot image unavailable. Original reference: {source.screenshotUuid}</p>}
      </div>)}
    </> : null}
  </article>;
}
