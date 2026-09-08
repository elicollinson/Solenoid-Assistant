import { getDb, type Db } from "../db";
import { records, assertCollected } from "./store";
import { contactSchema, messageSchema, photoSchema } from "./schema";
import type { TrustGate } from "../contacts/trustGate";
import {
  normalizePhone,
  normalizeEmail,
  lastTenDigits,
} from "../contacts/normalize";
import type { Message } from "../imessage/reader";
import type { PhotoRecord, QueryOptions } from "../utils/osxPhotos";
import { assetPath, resolveAsset } from "./assets";

export function storedContacts(db = getDb()): TrustGate {
  assertCollected("contacts", db);
  const contacts = records("contacts", db).map((r) =>
    contactSchema.parse(r.payload),
  );
  if (!contacts.length)
    throw new Error(
      "Collected address book is empty; refusing to treat this as a valid trust gate",
    );
  const phones = new Map<string, string | null>(),
    emails = new Map<string, string | null>(),
    short = new Map<string, string | null>();
  for (const c of contacts) {
    if (c.kind === "email") emails.set(normalizeEmail(c.handle), c.name);
    else {
      phones.set(normalizePhone(c.handle) ?? c.handle, c.name);
      const tail = lastTenDigits(c.handle);
      if (tail) short.set(tail, c.name);
    }
  }
  const lookup = (handle: string) => {
    if (handle.includes("@")) {
      const key = normalizeEmail(handle);
      return { found: emails.has(key), name: emails.get(key) ?? handle };
    }
    const key = normalizePhone(handle),
      tail = lastTenDigits(handle);
    if (key && phones.has(key))
      return { found: true, name: phones.get(key) ?? handle };
    return {
      found: !!tail && short.has(tail),
      name: tail ? (short.get(tail) ?? handle) : handle,
    };
  };
  return {
    isTrusted: (h) => h === "me" || lookup(h).found,
    resolveName: (h) => (lookup(h).found ? lookup(h).name : null),
    size: () => ({ phones: phones.size, emails: emails.size }),
    filter: (messages) =>
      messages
        .filter((m) => m.isFromMe || lookup(m.sender).found)
        .map((m) =>
          m.isFromMe ? m : { ...m, senderName: lookup(m.sender).name },
        ),
  };
}
export function storedMessages(
  start: Date,
  end: Date,
  db = getDb(),
): Message[] {
  assertCollected("messages", db);
  return records("messages", db)
    .filter(
      (r) =>
        r.occurred >= start.toISOString() && r.occurred <= end.toISOString(),
    )
    .map((r) => {
      const m = messageSchema.parse(r.payload);
      return { ...m, timestamp: new Date(m.timestamp) };
    });
}
export async function storedScreenshots(
  options: QueryOptions = {},
  db = getDb(),
): Promise<PhotoRecord[]> {
  assertCollected("photos", db);
  const from = options.fromDate ? new Date(options.fromDate).toISOString() : "",
    to = options.toDate ? new Date(options.toDate).toISOString() : "9999";
  return records("photos", db)
    .filter((r) => r.occurred >= from && r.occurred <= to)
    .slice(0, options.limit)
    .map((r) => {
      const photo = photoSchema.parse(r.payload);
      const p = r.payload!;
      return {
        uuid: photo.uuid,
        filename: photo.filename,
        original_filename: photo.filename,
        date: photo.date,
        date_added: photo.date,
        width: photo.width,
        height: photo.height,
        path: assetPath(photo.hash, String(p.extension)),
        path_edited: null,
        title: null,
        description: null,
        keywords: [],
        albums: [],
        persons: [],
        labels: [],
        original_filesize: 0,
        uti: "",
        ismovie: false,
        isphoto: true,
        ismissing: false,
        intrash: false,
        screenshot: true,
        shared: false,
        favorite: false,
        hidden: false,
      };
    });
}
export async function materializeStored(
  photos: PhotoRecord[],
  _dest: string,
  db: Db = getDb(),
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const indexed = new Map(records("photos", db).map((r) => [r.id, r.payload!]));
  for (const photo of photos) {
    const stored = indexed.get(photo.uuid);
    if (!stored)
      throw new Error("Screenshot is not in the collected source store");
    result.set(
      photo.uuid,
      await resolveAsset(String(stored.hash), String(stored.extension)),
    );
  }
  return result;
}
