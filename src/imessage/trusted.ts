// Trusted message retrieval: fetchMessages (spec imessageRead) composed with
// the contacts trust gate (spec contactsRead §3). This is the function LLM-facing
// code should call — untrusted senders are dropped here, before any model sees
// the messages.
import { log } from "../core/logger";
import { getTrustGate, type TrustGate } from "../contacts/trustGate";
import { fetchMessages, unixSecondsToAppleNs, type Message } from "./reader";

export interface TrustedFetchOptions {
  /** Window start, inclusive. Default: 24 hours before `end`. */
  start?: Date;
  /** Window end, inclusive. Default: now. */
  end?: Date;
  /** Keep own outgoing messages (inherently trusted). Default true. */
  includeOwn?: boolean;
  /** Trust gate override; defaults to the per-process cached gate. */
  gate?: TrustGate;
  dbPath?: string;
}

export interface TrustedFetchResult {
  messages: Message[]; // chronological; senderName enriched on incoming
  totalInWindow: number; // before trust filtering
  droppedUntrusted: number; // incoming messages from unknown senders
}

export function fetchTrustedMessages(options: TrustedFetchOptions = {}): TrustedFetchResult {
  const end = options.end ?? new Date();
  const start = options.start ?? new Date(end.getTime() - 24 * 3600_000);
  const { includeOwn = true, gate = getTrustGate(), dbPath } = options;
  if (start > end) {
    throw new Error(`fetchTrustedMessages: start (${start.toISOString()}) is after end (${end.toISOString()})`);
  }

  // fetchMessages treats the cursor as strictly-greater-than (§10); back off
  // 1ns so `start` itself is inclusive. Overlap is a cursor concern, not a
  // window concern — disable it so the range is exactly what was asked for.
  const since = unixSecondsToAppleNs(start.getTime() / 1000) - 1n;
  const until = unixSecondsToAppleNs(Math.ceil(end.getTime() / 1000));
  const { messages: all } = fetchMessages(since, { dbPath, overlapSeconds: 0, untilAppleNs: until });

  const trusted = gate.filter(all);
  const droppedUntrusted = all.length - trusted.length;
  if (droppedUntrusted > 0) {
    log.info(`trusted fetch: dropped ${droppedUntrusted}/${all.length} messages from unknown senders`);
  }
  const messages = includeOwn ? trusted : trusted.filter((m) => !m.isFromMe);
  return { messages, totalInWindow: all.length, droppedUntrusted };
}
