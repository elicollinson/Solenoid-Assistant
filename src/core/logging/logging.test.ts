import { afterEach, describe, expect, test } from "bun:test";
import { loadRuntimeConfig, type RuntimeConfig } from "../config";
import { log, withLogContext, configureLogging } from "../logger";
import { logContext } from "./context";
import { passes } from "./record";
import { LogQueryError, queryRunLogs, runQuery } from "./query";
import { VictoriaLogsSink } from "./sink";

/** A stand-in collector. Answers like VictoriaLogs and remembers what it got. */
function collector(handler?: (request: Request, url: URL) => Response | Promise<Response>) {
  const ingested: Record<string, unknown>[] = [];
  const queries: string[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (handler) {
        const answer = await handler(request, url);
        if (url.pathname === "/insert/jsonline") {
          for (const line of (await request.text()).split("\n").filter(Boolean)) ingested.push(JSON.parse(line));
        }
        return answer;
      }
      if (url.pathname === "/insert/jsonline") {
        for (const line of (await request.text()).split("\n").filter(Boolean)) ingested.push(JSON.parse(line));
        return new Response("", { status: 200 });
      }
      if (url.pathname === "/select/logsql/query") {
        const body = new URLSearchParams(await request.text());
        queries.push(body.get("query") ?? "");
        // ndjson, and deliberately out of order: the reader has to sort.
        return new Response(
          [
            JSON.stringify({ _time: "2026-08-26T10:00:02.000Z", _msg: "second", level: "ok", service: "solenoid-server", component: "workflow" }),
            JSON.stringify({ _time: "2026-08-26T10:00:01.000Z", _msg: "first", level: "info", service: "solenoid-server", component: "http", trace_id: "abc" }),
            "",
          ].join("\n"),
        );
      }
      return new Response("not found", { status: 404 });
    },
  });
  return {
    ingested,
    queries,
    url: `http://127.0.0.1:${server.port}`,
    stop: () => server.stop(true),
  };
}

function configFor(endpoint: string, overrides: Partial<RuntimeConfig["logging"]["victoriaLogs"]> = {}): RuntimeConfig {
  const base = loadRuntimeConfig({});
  return {
    ...base,
    logging: { ...base.logging, victoriaLogs: { ...base.logging.victoriaLogs, endpoint, ...overrides } },
  };
}

const cleanup: Array<() => void> = [];
afterEach(() => {
  while (cleanup.length > 0) cleanup.pop()?.();
});

describe("the sink", () => {
  test("posts ndjson to the JSON-line API with the standard fields named", async () => {
    const fake = collector();
    cleanup.push(fake.stop);
    const sink = new VictoriaLogsSink(configFor(fake.url).logging.victoriaLogs);

    sink.push({ timestamp: "2026-08-26T10:00:00.000Z", level: "info", service: "s", component: "c", message: "hello" });
    await sink.flush();

    expect(fake.ingested).toEqual([
      { timestamp: "2026-08-26T10:00:00.000Z", level: "info", service: "s", component: "c", message: "hello" },
    ]);
    await sink.close();
  });

  // The whole point of the queue. A collector that is down is a normal
  // condition on a laptop, and it must cost logs rather than availability.
  test("swallows a collector that is not there, and holds what it could not send", async () => {
    const sink = new VictoriaLogsSink(
      configFor("http://127.0.0.1:1", { timeoutMs: 200 }).logging.victoriaLogs,
    );
    sink.push({ timestamp: "2026-08-26T10:00:00.000Z", level: "error", service: "s", component: "c", message: "boom" });

    // Never rejects, whatever the network did.
    await sink.flush();
    expect(sink.stats().queued).toBe(1);
    expect(sink.stats().dropped).toBe(0);
    await sink.close();
  });

  test("drops the oldest rather than growing without bound", async () => {
    const sink = new VictoriaLogsSink(
      configFor("http://127.0.0.1:1", { queueLimit: 100, batchSize: 10_000, timeoutMs: 200 }).logging.victoriaLogs,
    );
    for (let i = 0; i < 150; i++) {
      sink.push({ timestamp: "2026-08-26T10:00:00.000Z", level: "info", service: "s", component: "c", message: `line ${i}` });
    }
    expect(sink.stats().queued).toBe(100);
    expect(sink.stats().dropped).toBe(50);
    await sink.close();
  });

  test("a rejected batch is not lost, and a 500 is not treated as delivery", async () => {
    let answer = 500;
    const fake = collector(() => new Response("nope", { status: answer }));
    cleanup.push(fake.stop);
    const sink = new VictoriaLogsSink(configFor(fake.url).logging.victoriaLogs);

    sink.push({ timestamp: "2026-08-26T10:00:00.000Z", level: "warn", service: "s", component: "c", message: "held" });
    await sink.flush();
    expect(sink.stats().queued).toBe(1);

    answer = 200;
    await sink.flush();
    expect(sink.stats().queued).toBe(0);
    await sink.close();
  });
});

describe("reading a run back", () => {
  test("asks for the run id and answers oldest first", async () => {
    const fake = collector();
    cleanup.push(fake.stop);

    const lines = await queryRunLogs("01M10APT3J486B07RVYXBFC45D", { config: configFor(fake.url) });

    expect(fake.queries[0]).toContain('run_id:="01M10APT3J486B07RVYXBFC45D"');
    expect(fake.queries[0]).toContain("_time:");
    expect(lines.map((l) => l.message)).toEqual(["first", "second"]);
    expect(lines[0]).toMatchObject({ level: "info", component: "http", trace_id: "abc" });
  });

  // The Logs tab falls back to the run record on this, which it can only do if
  // the failure arrives as an error rather than as an empty list.
  test("says so when the store cannot be reached", async () => {
    await expect(
      runQuery("level:=error", { config: configFor("http://127.0.0.1:1", { timeoutMs: 200 }) }),
    ).rejects.toBeInstanceOf(LogQueryError);
  });
});

describe("the fields a line inherits", () => {
  test("nest, and an inner scope cannot blank an outer one", () => {
    withLogContext({ run_id: "run-1", component: "workflow" }, () => {
      withLogContext({ component: "tool" }, () => {
        expect(logContext()).toEqual({ run_id: "run-1", component: "tool" });
      });
      expect(logContext().component).toBe("workflow");
    });
    expect(logContext()).toEqual({});
  });

  test("survive an await, which is the only reason this is not a parameter", async () => {
    await withLogContext({ run_id: "run-2" }, async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 1));
      expect(logContext().run_id).toBe("run-2");
    });
  });
});

describe("the level floor", () => {
  test("lets `ok` through wherever `info` gets through", () => {
    expect(passes("ok", "info")).toBe(true);
    expect(passes("debug", "info")).toBe(false);
    expect(passes("error", "error")).toBe(true);
    expect(passes("warn", "error")).toBe(false);
  });
});

describe("the logger itself", () => {
  test("says nothing below the floor and never throws without a collector", () => {
    configureLogging({ service: "test-service", config: loadRuntimeConfig({ LOG_LEVEL: "warn", LOG_FORMAT: "json" }) });
    const said: string[] = [];
    const original = console.log;
    console.log = (line: string) => said.push(line);
    try {
      log.debug("quiet");
      log.info("also quiet");
    } finally {
      console.log = original;
    }
    expect(said).toEqual([]);

    const errors: string[] = [];
    const originalError = console.error;
    console.error = (line: string) => errors.push(line);
    try {
      withLogContext({ run_id: "run-3", request_id: "req-3" }, () => log.error("loud"));
    } finally {
      console.error = originalError;
    }
    const record = JSON.parse(errors[0]!) as Record<string, unknown>;
    expect(record).toMatchObject({
      level: "error",
      service: "test-service",
      message: "loud",
      run_id: "run-3",
      request_id: "req-3",
    });
    expect(typeof record.timestamp).toBe("string");

    // Put the default back for whatever runs next in this process.
    configureLogging({ service: "test-service" });
  });
});
