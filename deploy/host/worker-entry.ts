// launchd entry point for the cron worker.
//
// Two things this adds over running src/worker.ts directly, both of them about
// boot order — which launchd has no opinion about, because launchd jobs have
// no dependencies on each other.
//
//   1. It waits for the server's /health. The server opens the database first
//      and getDb() runs the migrations, so waiting is what stops two processes
//      from migrating the same file at the same moment on a cold start.
//   2. It fails loudly rather than silently doing nothing if the server never
//      comes up, so KeepAlive restarts it and the log says why.
//
// Started by com.solenoid.worker.plist.
const port = process.env.PORT ?? "3000";
const health = `http://127.0.0.1:${port}/health`;
const deadline = Date.now() + 180_000;

while (Date.now() < deadline) {
  try {
    const response = await fetch(health, { signal: AbortSignal.timeout(2_000) });
    if (response.ok) {
      console.log(`worker: server is up at ${health}, starting`);
      await import("../../src/worker.ts");
      break;
    }
  } catch {
    // Not up yet. The loop is the retry.
  }
  await Bun.sleep(2_000);
}

if (Date.now() >= deadline) {
  console.error(`worker: ${health} never answered in 3 minutes — exiting for launchd to retry`);
  process.exit(1);
}
