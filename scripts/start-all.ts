// Runs the HTTP server and the cron worker as two separate processes under
// one `bun start`. Signals are forwarded to both children so each can flush
// its trace spans; if either process dies, the other is taken down and the
// supervisor exits with the dead child's code.
const children = [
  Bun.spawn(["bun", "run", "src/index.ts"], { stdout: "inherit", stderr: "inherit" }),
  Bun.spawn(["bun", "run", "src/worker.ts"], { stdout: "inherit", stderr: "inherit" }),
];

let shuttingDown = false;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    shuttingDown = true;
    for (const child of children) child.kill(sig);
  });
}

const code = await Promise.race(children.map((c) => c.exited));
if (!shuttingDown) {
  for (const child of children) child.kill("SIGTERM");
}
await Promise.all(children.map((c) => c.exited));
process.exit(shuttingDown ? 0 : code);
