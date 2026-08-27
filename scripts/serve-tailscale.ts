// Put the app on the tailnet, over real HTTPS.
//
// The command underneath is one line. What makes this worth a script is
// everything that has to be true first: the daemon running, MagicDNS and HTTPS
// certificates enabled for the tailnet, and the app actually answering on
// loopback. Each of those fails in its own way and none of the messages say
// what to do about it, so they are checked here in the order they matter.
//
// What this gives you is `https://<machine>.<tailnet>.ts.net` — a name with a
// real Let's Encrypt certificate, reachable by the devices on your tailnet and
// by nothing else. That certificate is the point: service workers only run in a
// secure context, so this is the difference between an iPhone taking the icon
// and an iPhone installing the app.
//
// It deliberately cannot turn on Funnel. Funnel is the same proxy pointed at
// the public internet, and this server answers questions about your messages,
// your contacts and your calendar with no authentication in front of it. If you
// ever want that, it should be a decision you type out yourself.
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    port: { type: "string", default: "3000" },
    off: { type: "boolean", default: false },
    status: { type: "boolean", default: false },
  },
  strict: true,
});

const PORT = Number(values.port);

/** Run `tailscale`, and hand back what it said either way. */
async function ts(...args: string[]): Promise<{ ok: boolean; out: string }> {
  const proc = Bun.spawn(["tailscale", ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  return { ok: code === 0, out: `${out}${err}`.trim() };
}

function stop(message: string, fix?: string): never {
  console.error(`\n  ${message}`);
  if (fix) console.error(`  ${fix}`);
  console.error("");
  process.exit(1);
}

// ── is the CLI even here ────────────────────────────────────────────────
if (!Bun.which("tailscale")) {
  stop("tailscale is not on PATH.", "Install it: brew install tailscale, or the Tailscale app from tailscale.com.");
}

// ── is the daemon up and logged in ──────────────────────────────────────
const status = await ts("status", "--json");
if (!status.ok) {
  stop(
    `tailscale is not running — ${status.out.split("\n")[0]}`,
    "Start it: `tailscale up` (or open the Tailscale menu-bar app and sign in).",
  );
}

const state = JSON.parse(status.out) as {
  BackendState: string;
  Self?: { DNSName?: string };
  CertDomains?: string[];
};

if (state.BackendState !== "Running") {
  stop(`tailscale is ${state.BackendState.toLowerCase()}, not running.`, "Bring it up with `tailscale up`.");
}

const dnsName = state.Self?.DNSName?.replace(/\.$/, "");
if (!dnsName) stop("This machine has no MagicDNS name.", "Enable MagicDNS for the tailnet in the admin console.");

// ── turning it off, or just looking ─────────────────────────────────────
if (values.off) {
  const cleared = await ts("serve", "--https=443", "off");
  console.log(cleared.ok ? `\n  Off. ${dnsName} no longer serves the app.\n` : `\n  ${cleared.out}\n`);
  process.exit(cleared.ok ? 0 : 1);
}

if (values.status) {
  const shown = await ts("serve", "status");
  console.log(`\n${shown.out || "  Nothing is being served."}\n`);
  process.exit(0);
}

// ── are HTTPS certificates enabled for this tailnet ──────────────────────
//
// Without them `tailscale serve --https` fails with a message about the
// feature being disabled, which reads like a bug in the command rather than a
// switch in the admin console.
if (!state.CertDomains?.length) {
  stop(
    "HTTPS certificates are not enabled for this tailnet.",
    "Turn them on at https://login.tailscale.com/admin/dns — 'HTTPS Certificates'. Without one there is no secure context, and no service worker.",
  );
}

// ── is the app actually up on loopback ──────────────────────────────────
//
// Checked before serving rather than after, because `tailscale serve` will
// happily proxy to a port with nothing behind it and the failure then looks
// like a Tailscale problem from the phone.
const health = await fetch(`http://127.0.0.1:${PORT}/health`).catch(() => null);
if (!health?.ok) {
  stop(
    `Nothing is answering on http://127.0.0.1:${PORT}.`,
    "Start it first: `bun run build:web && bun start --no-web`. The build is what makes :3000 serve the app as well as the API.",
  );
}

const served = await fetch(`http://127.0.0.1:${PORT}/manifest.webmanifest`).catch(() => null);
if (!served?.ok) {
  console.warn(
    `\n  Note: :${PORT} answers, but has no web build behind it — the API is there and the app is not.` +
      "\n  Run `bun run build:web` and restart, or this will serve a working API and a 404 for every page.",
  );
}

// ── serve it ────────────────────────────────────────────────────────────
const result = await ts("serve", "--bg", "--https=443", `http://127.0.0.1:${PORT}`);
if (!result.ok) stop(`tailscale serve refused: ${result.out}`);

console.log(`
  Serving on https://${dnsName}

  That name has a real certificate, so it is a secure context: the service
  worker runs and the app installs properly. Only devices on your tailnet can
  reach it — this is Serve, not Funnel, and nothing here is public.

  On the iPhone   Safari → https://${dnsName} → Share → Add to Home Screen
  On the Mac      Safari → File → Add to Dock, or Chrome's install control

  Stop it with \`bun run serve:tailscale --off\`.

  One thing to be clear about: there is no authentication in front of any of
  this. Anything on your tailnet can read your messages, contacts and calendar
  through it, and can POST to the agent endpoints. That is fine for a tailnet of
  your own devices and not fine for one you have shared with anyone.
`);
