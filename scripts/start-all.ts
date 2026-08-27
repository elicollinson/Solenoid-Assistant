// Runs the stack as separate processes under one `bun start`: the HTTP server,
// the cron worker, and the Vite dev server for web/.
//
// Signals are forwarded to every child so each can flush its trace spans.
// The two halves are not treated alike on exit: if the server or the worker
// dies the whole stack comes down, because nothing downstream of them is
// meaningful without them. If the dev server dies — a busy port, a config
// typo — the backend keeps running and says so, because losing the UI is not
// a reason to drop the cron worker mid-task.
//
// Skip the UI with `--no-web`, or `WEB=0`.
import { dirname, join } from "node:path";
import type { Subprocess } from "bun";

const root = dirname(import.meta.dir);
const wantsWeb = !process.argv.includes("--no-web") && process.env.WEB !== "0";

interface Child {
  name: string;
  /** Whether this process dying should take the rest of the stack with it. */
  essential: boolean;
  proc: Subprocess;
}

const spawn = (name: string, essential: boolean, cmd: string[]): Child => ({
  name,
  essential,
  proc: Bun.spawn(cmd, { cwd: root, stdout: "inherit", stderr: "inherit" }),
});

const children: Child[] = [
  spawn("server", true, ["bun", "run", "src/server.ts"]),
  spawn("worker", true, ["bun", "run", "src/worker.ts"]),
];

// Registered before the awaited lookup below: a Ctrl-C in that window would
// otherwise kill the supervisor and orphan the server and the worker.
let shuttingDown = false;
const stopAll = (signal: NodeJS.Signals) => {
  for (const child of children) child.proc.kill(signal);
};

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    shuttingDown = true;
    stopAll(signal);
  });
}

/**
 * Where Vite's CLI lives, or null if it is not installed.
 *
 * Read off the package's own `bin` field rather than guessed: Vite's exports
 * map does not expose `vite/bin/vite.js`, so resolving that path directly
 * fails even though the file is right there.
 */
async function findVite(): Promise<string | null> {
  let manifestPath: string;
  try {
    manifestPath = Bun.resolveSync("vite/package.json", root);
  } catch {
    return null;
  }
  const manifest = (await Bun.file(manifestPath).json()) as { bin?: string | Record<string, string> };
  const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.vite;
  if (!bin) return null;
  const cli = join(dirname(manifestPath), bin);
  return (await Bun.file(cli).exists()) ? cli : null;
}

if (wantsWeb) {
  // Vite is a devDependency, so a production install will not have it. Resolve
  // it rather than shelling out blind: `bun x` would try to fetch it.
  const vite = await findVite();
  if (vite) {
    children.push(spawn("web", false, ["bun", "run", vite, "--config", "web/vite.config.ts"]));
  } else {
    console.warn("web: vite is not installed — skipping the UI. Run `bun install` to include it.");
  }
}

// Wait on every child at once, and keep waiting when a non-essential one is
// the loser — only the server or the worker going down ends the stack.
const pending = new Set(children);
let exitCode = 0;

while (pending.size > 0 && !shuttingDown) {
  const { child, code } = await Promise.race(
    [...pending].map(async (c) => ({ child: c, code: await c.proc.exited })),
  );
  pending.delete(child);

  if (child.essential) {
    console.error(`${child.name} exited with code ${code} — shutting down.`);
    exitCode = code;
    break;
  }
  console.warn(`${child.name} exited with code ${code} — leaving the rest of the stack up.`);
}

if (!shuttingDown) stopAll("SIGTERM");
await Promise.all(children.map((c) => c.proc.exited));
process.exit(shuttingDown ? 0 : exitCode);
