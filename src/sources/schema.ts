import { z } from "zod";

export const kindSchema = z.enum(["messages", "contacts", "photos"]);
export type SourceKind = z.infer<typeof kindSchema>;
const id = z.string().min(1).max(512);
export const messageSchema = z.object({
  sourceId: id,
  body: z.string().max(1_000_000),
  sender: id,
  senderName: z.string().nullable(),
  conversationId: z.string(),
  isFromMe: z.boolean(),
  service: z.string(),
  timestamp: z.string().datetime(),
  hasAttachments: z.boolean(),
});
export const contactSchema = z.object({
  handle: id,
  name: z.string().max(1024).nullable(),
  kind: z.enum(["phone", "email"]),
});
export const photoSchema = z.object({
  uuid: id,
  filename: z.string().max(1024),
  date: z.string().datetime(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
});
export const batchSchema = z.object({
  kind: z.enum(["messages", "contacts"]),
  records: z.array(z.unknown()).max(500),
});
export const inventorySchema = z
  .object({
    kind: kindSchema,
    ids: z.array(id).max(200_000),
    from: z.string().datetime(),
    to: z.string().datetime(),
  })
  .refine((v) => v.from <= v.to, "Invalid coverage window");
export interface SourceRecord {
  kind: SourceKind;
  id: string;
  payload: Record<string, unknown> | null;
  occurred: string;
  revision: string;
  deleted: number;
  seq: number;
}
export const changeSchema = z.object({
  kind: kindSchema,
  id,
  payload: z.record(z.string(), z.unknown()).nullable(),
  occurred: z.string(),
  revision: z.string(),
  deleted: z.number().int().min(0).max(1),
  seq: z.number().int().nonnegative(),
});
export const changePageSchema = z.object({
  epoch: z.string(),
  cursor: z.number().int().nonnegative(),
  changes: z.array(changeSchema),
  status: z.array(
    z.object({
      kind: kindSchema,
      collected_at: z.string(),
      coverage_from: z.string(),
      coverage_to: z.string(),
    }),
  ),
});
