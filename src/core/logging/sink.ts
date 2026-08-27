// Shipping log records to VictoriaLogs, out of the way of the request that
// produced them.
//
// The rule this file exists to keep: *logging must never be the reason
// something fails*. So the write path is a push onto a bounded in-memory
// queue and nothing else — no await, no promise handed back to the caller,
// no error that can propagate. A flush happens on a timer or when the queue
// fills, and if the collector is down the batch waits, then the oldest
// records are dropped. A logging backend that is gone costs you logs; it does
// not cost you the run.
import type { RuntimeConfig } from "../config";
import type { LogRecord } from "./record";

type VictoriaLogsConfig = RuntimeConfig["logging"]["victoriaLogs"];

/** How far the flush interval backs off while the collector is unreachable. */
const MAX_BACKOFF_MS = 30_000;
/** How often the console is told that shipping is failing. Once a minute is
 *  enough to notice; every batch would bury the logs you can still read. */
const COMPLAINT_INTERVAL_MS = 60_000;

export class VictoriaLogsSink {
  private readonly url: string;
  private queue: LogRecord[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private flushing: Promise<void> | undefined;
  private backoffMs: number;
  private dropped = 0;
  private lastComplaintAt = 0;
  private closed = false;

  constructor(private readonly config: VictoriaLogsConfig) {
    // Query parameters rather than per-record bookkeeping: VictoriaLogs reads
    // the timestamp out of `timestamp`, the message out of `message`, and
    // indexes the rest as fields. The stream fields are the low-cardinality
    // three — every other field, `trace_id` included, stays queryable without
    // multiplying the number of streams.
    const params = new URLSearchParams({
      _time_field: "timestamp",
      _msg_field: "message",
      _stream_fields: "service,component,level",
    });
    this.url = `${config.endpoint}/insert/jsonline?${params}`;
    this.backoffMs = config.flushMs;
  }

  /**
   * Hand over a record. Returns immediately, always, and throws nothing.
   *
   * When the queue is full the *oldest* records go, not the newest: whatever
   * just happened is more likely to be what you are looking for than what the
   * process was saying ten thousand lines ago.
   */
  push(record: LogRecord): void {
    if (this.closed) return;
    this.queue.push(record);
    const overflow = this.queue.length - this.config.queueLimit;
    if (overflow > 0) {
      this.queue.splice(0, overflow);
      this.dropped += overflow;
    }
    if (this.queue.length >= this.config.batchSize) void this.flush();
    else this.arm();
  }

  /** Send what is queued. Safe to call at any time; overlapping calls join the
   *  one already in flight rather than double-sending. */
  flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    if (this.queue.length === 0) return Promise.resolve();
    this.flushing = this.send().finally(() => {
      this.flushing = undefined;
      if (this.queue.length > 0 && !this.closed) this.arm();
    });
    return this.flushing;
  }

  /** Final flush, bounded. Called from the shutdown handler, where waiting
   *  forever on an unreachable collector would hang the exit. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.disarm();
    await Promise.race([
      this.flush(),
      new Promise<void>((resolve) => setTimeout(resolve, this.config.timeoutMs)),
    ]).catch(() => {});
    this.closed = true;
    this.queue = [];
  }

  /** For the tests and for a health line: what is waiting and what was lost. */
  stats(): { queued: number; dropped: number } {
    return { queued: this.queue.length, dropped: this.dropped };
  }

  private arm(): void {
    if (this.timer || this.closed) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, this.backoffMs);
    // Never a reason for the process to stay alive.
    this.timer.unref?.();
  }

  private disarm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private async send(): Promise<void> {
    const batch = this.queue.splice(0, this.config.batchSize);
    if (batch.length === 0) return;

    const body = batch.map((record) => JSON.stringify(record)).join("\n") + "\n";
    try {
      const response = await fetch(this.url, {
        method: "POST",
        headers: { "content-type": "application/stream+json" },
        body,
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
      if (!response.ok) {
        // Read and discard, so the connection can be reused rather than left
        // hanging on an unconsumed body.
        await response.text().catch(() => "");
        throw new Error(`VictoriaLogs answered ${response.status}`);
      }
      this.backoffMs = this.config.flushMs;
    } catch (error) {
      this.requeue(batch);
      this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
      this.complain(error);
    }
  }

  /** Put a failed batch back at the front, as far as there is room for it.
   *  Order is kept, and the overflow is counted rather than quietly lost. */
  private requeue(batch: LogRecord[]): void {
    const room = this.config.queueLimit - this.queue.length;
    if (room <= 0) {
      this.dropped += batch.length;
      return;
    }
    if (batch.length > room) {
      this.dropped += batch.length - room;
      batch = batch.slice(batch.length - room);
    }
    this.queue.unshift(...batch);
  }

  /**
   * Say it on the console, rarely, and never through `log` itself — a logger
   * that logs its own shipping failures through the sink that is failing is a
   * loop with a queue in it.
   */
  private complain(error: unknown): void {
    const now = Date.now();
    if (now - this.lastComplaintAt < COMPLAINT_INTERVAL_MS) return;
    this.lastComplaintAt = now;
    const why = error instanceof Error ? error.message : String(error);
    console.warn(
      `[logging] VictoriaLogs unreachable at ${this.config.endpoint} (${why}) — ` +
        `${this.queue.length} record(s) held, ${this.dropped} dropped so far. Console logging is unaffected.`,
    );
  }
}
