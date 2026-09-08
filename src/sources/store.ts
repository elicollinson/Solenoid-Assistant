import { createHash, randomUUID } from "node:crypto";
import { getDb, type Db } from "../db";
import {
  contactSchema,
  messageSchema,
  type SourceKind,
  type SourceRecord,
} from "./schema";

export const digest = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
export function sourceEpoch(db = getDb()): string {
  db.$client
    .query("INSERT OR IGNORE INTO source_meta(key,value) VALUES('epoch',?)")
    .run(randomUUID());
  return (
    db.$client
      .query("SELECT value FROM source_meta WHERE key='epoch'")
      .get() as { value: string }
  ).value;
}
export function records(kind: SourceKind, db = getDb()): SourceRecord[] {
  return (
    db.$client
      .query(
        "SELECT * FROM source_records WHERE kind=? AND deleted=0 ORDER BY occurred,id",
      )
      .all(kind) as Array<Omit<SourceRecord, "payload"> & { payload: string }>
  ).map((r) => ({ ...r, payload: JSON.parse(r.payload) }));
}
export function putRecord(
  kind: SourceKind,
  id: string,
  payload: Record<string, unknown> | null,
  occurred: string,
  db: Db,
): void {
  const serialized = payload ? JSON.stringify(payload) : null;
  const revision = digest(serialized ?? "deleted");
  const previous = db.$client
    .query("SELECT revision FROM source_records WHERE kind=? AND id=?")
    .get(kind, id) as { revision: string } | null;
  if (previous?.revision === revision) return;
  const result = db.$client
    .query(
      "INSERT INTO source_changes(kind,id,payload,occurred,revision,deleted) VALUES(?,?,?,?,?,?)",
    )
    .run(kind, id, null, occurred, revision, payload ? 0 : 1);
  db.$client
    .query(
      "INSERT INTO source_records(kind,id,payload,occurred,revision,deleted,seq) VALUES(?,?,?,?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET payload=excluded.payload,occurred=excluded.occurred,revision=excluded.revision,deleted=excluded.deleted,seq=excluded.seq",
    )
    .run(
      kind,
      id,
      serialized,
      occurred,
      revision,
      payload ? 0 : 1,
      Number(result.lastInsertRowid),
    );
}
export function importBatch(
  kind: "messages" | "contacts",
  input: unknown[],
  db = getDb(),
): number {
  const parsed = input.map((r) =>
    kind === "messages" ? messageSchema.parse(r) : contactSchema.parse(r),
  );
  db.$client.transaction(() => {
    for (const value of parsed) {
      const id = "sourceId" in value ? value.sourceId : value.handle;
      const occurred =
        "timestamp" in value ? value.timestamp : "1970-01-01T00:00:00.000Z";
      putRecord(kind, id, value, occurred, db);
    }
  })();
  return parsed.length;
}
export function completeInventory(
  kind: SourceKind,
  ids: string[],
  from: string,
  to: string,
  db = getDb(),
): void {
  const kept = new Set(ids);
  db.$client.transaction(() => {
    for (const r of records(kind, db)) {
      if (
        !kept.has(r.id) &&
        (kind === "contacts" || (r.occurred >= from && r.occurred <= to))
      )
        putRecord(kind, r.id, null, r.occurred, db);
    }
    if (kind === "photos") {
      const pending = db.$client
        .query("SELECT id,payload FROM source_photo_candidates")
        .all() as { id: string; payload: string }[];
      for (const r of pending) {
        const p = JSON.parse(r.payload);
        if (!kept.has(r.id) && p.date >= from && p.date <= to)
          db.$client
            .query("DELETE FROM source_photo_candidates WHERE id=?")
            .run(r.id);
      }
    }
    db.$client
      .query(
        "INSERT INTO source_status(kind,collected_at,coverage_from,coverage_to) VALUES(?,?,?,?) ON CONFLICT(kind) DO UPDATE SET collected_at=excluded.collected_at,coverage_from=min(source_status.coverage_from,excluded.coverage_from),coverage_to=max(source_status.coverage_to,excluded.coverage_to)",
      )
      .run(kind, new Date().toISOString(), from, to);
  })();
}
export function sourceStatus(db = getDb()) {
  return db.$client.query("SELECT * FROM source_status ORDER BY kind").all();
}
export function assertCollected(kind: SourceKind, db = getDb()): void {
  if (!db.$client.query("SELECT 1 FROM source_status WHERE kind=?").get(kind))
    throw new Error(
      `${kind} have not been collected. Run the mini collector or source:catch-up for this instance.`,
    );
}
export function changesSince(cursor: number, db = getDb()) {
  // Current records carry their latest sequence, avoiding historical copies of
  // sensitive data. A later update remains visible after an earlier page.
  const rows = db.$client
    .query("SELECT * FROM source_records WHERE seq>? ORDER BY seq LIMIT 500")
    .all(cursor) as Array<
    Omit<SourceRecord, "payload"> & { payload: string | null }
  >;
  return {
    epoch: sourceEpoch(db),
    cursor: rows.at(-1)?.seq ?? cursor,
    changes: rows.map((r) => ({
      ...r,
      payload: r.payload ? JSON.parse(r.payload) : null,
    })),
    status: sourceStatus(db),
  };
}
export function applyReplica(
  page: ReturnType<typeof changesSince>,
  db: Db,
): void {
  db.$client.transaction(() => {
    const previous = db.$client
      .query("SELECT value FROM source_meta WHERE key='remote_epoch'")
      .get() as { value: string } | null;
    if (previous && previous.value !== page.epoch)
      throw new Error(
        "Remote source identity changed; use source:catch-up --reset to rebuild source data only.",
      );
    for (const r of page.changes)
      db.$client
        .query(
          "INSERT INTO source_records(kind,id,payload,occurred,revision,deleted,seq) VALUES(?,?,?,?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET payload=excluded.payload,occurred=excluded.occurred,revision=excluded.revision,deleted=excluded.deleted,seq=excluded.seq",
        )
        .run(
          r.kind,
          r.id,
          r.payload ? JSON.stringify(r.payload) : null,
          r.occurred,
          r.revision,
          r.deleted,
          r.seq,
        );
    for (const raw of page.status) {
      const r = raw as {
        kind: string;
        collected_at: string;
        coverage_from: string;
        coverage_to: string;
      };
      db.$client
        .query("INSERT OR REPLACE INTO source_status VALUES(?,?,?,?)")
        .run(r.kind, r.collected_at, r.coverage_from, r.coverage_to);
    }
    for (const [key, value] of [
      ["remote_epoch", page.epoch],
      ["remote_cursor", String(page.cursor)],
      ["replica_synced_at", new Date().toISOString()],
    ])
      db.$client
        .query("INSERT OR REPLACE INTO source_meta(key,value) VALUES(?,?)")
        .run(key!, value!);
  })();
}
