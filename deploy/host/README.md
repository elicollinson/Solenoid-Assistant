# Running Solenoid on the host, under launchd

The recommended deployment. `../README.md` is the container plan, kept as the
alternative — read §6 there for why containers cost you three of five
workflows.

Nothing here has been run or installed. `install.sh` is the thing you run when
you have read it.

---

## 1. Why this is the better fit, not the fallback

Containers were fighting the application:

| | Docker | launchd on the host |
| --- | --- | --- |
| `osxphotos` / Photos workflows | impossible in Linux; needs a host-side bridge to ever work | works — same machine, same user, same TCC grant |
| iMessage + Contacts | needs a snapshot job, a mirrored path, and a config change | works — the defaults already point at `$HOME/Library/...` |
| SQLite | named volume, because locks do not cross the VM boundary reliably | one process family, one filesystem, no boundary |
| Config deltas | seven overrides (`HOST`, `DATABASE_URL`, collector endpoint, model path, `host.docker.internal`, …) | **none** — `.env` is already correct as written |
| Model endpoint | `host.docker.internal` rewriting | LM Studio on the LAN or on this Mac, either way unchanged |
| `tailscale serve` | works, via the loopback publish | already running and pointed at `127.0.0.1:3000` |
| Startup after reboot | Docker Desktop must start (needs login) **and then** compose must come up | launchd starts the jobs (needs login) |
| Dependency isolation | strong | none — this is the real trade |
| Rollback | `docker run` the previous image | `git checkout` + `update.sh` |

The login requirement does not go away, and it is worth being clear about why:
it was never Docker's. Everything this app reads is TCC-gated per-user, so it
has to run as you, in your GUI session. A `LaunchDaemon` would start before
login as root, but Photos is unreachable from there and the Messages grant is
per-user. §5 is about making login automatic.

What you give up is real: no pinned base image, no clean-room rebuild, and
`bun upgrade` can change the runtime under a running service. §6 prices that.

---

## 2. Shape

```
  launchd (gui/501)
    ├── com.solenoid.server     bun run src/server.ts        :3000  KeepAlive
    ├── com.solenoid.worker     bun run worker-entry.ts      cron   KeepAlive
    ├── com.solenoid.phoenix    phoenix serve                :6006  KeepAlive   (optional)
    └── com.solenoid.watchdog   watchdog.sh                  every 120s          (optional)

  tailscale serve ──► 127.0.0.1:3000        (already configured, survives reboot)
  ./data/solenoid.db   ./okf   ./.env   ./models   — all in place, unchanged
```

Two long-lived jobs rather than one `bun start`: `scripts/start-all.ts` takes
the whole stack down when either half dies, which is right for a terminal you
are watching and wrong for a service. Under launchd, a worker wedged on a
vision call should be restarted by itself while the UI keeps answering.

**Boot order.** launchd has no dependency graph — every job with `RunAtLoad`
starts at once. The server opens the database first and `getDb()` runs the
migrations, so `worker-entry.ts` waits on `/health` before importing the
worker. That single wait is what keeps two processes from migrating the same
SQLite file in the same second.

---

## 3. The five things that actually break launchd jobs

In the order you will hit them:

1. **`PATH`.** A launchd job gets almost no environment. `src/utils/osxPhotos.ts`
   spawns `osxphotos` by name, and it lives in `/opt/homebrew/bin` — not on
   launchd's default path. Every screenshot workflow dies at the first call
   with `ENOENT` and nothing else looks wrong. Both plists set `PATH`
   explicitly; that is what that key is for.
2. **Full Disk Access is granted to a binary, not to you.** TCC attributes the
   grant to the executable launchd spawns — here, `/Users/eli/.bun/bin/bun`.
   Granting it to Terminal or to iTerm does nothing for a launchd job. This is
   why the plists name bun by absolute path instead of finding it on `PATH`:
   the grant has to follow one specific file. Symptom when it is missing:
   `contacts: loaded 0 phones` and an `unable to open database file` on
   `chat.db`, both of which read as a code bug and are not.
   *Expect to re-grant after `bun upgrade`* — the grant is keyed to the binary,
   and upgrading replaces it.
3. **Two bun installs on this machine.** `/Users/eli/.bun/bin/bun` is 1.3.6;
   `/opt/homebrew/bin/bun` is 1.3.3. A `PATH`-resolved `bun` under launchd may
   not be the one you develop against. Absolute path, everywhere.
4. **`WorkingDirectory`.** `.env`, `./data/solenoid.db`, `./drizzle`,
   `models/prompt-guard-2-86m` and `okf/` are all relative. One key sets them
   all; without it the job starts in `/` and fails in five different ways.
5. **`HOME`.** `src/imessage/reader.ts:37` and `src/contacts/trustGate.ts:28`
   build their defaults from `process.env.HOME`. launchd normally sets it for
   agents; set it anyway, because the failure is silent.

---

## 4. Reliability, beyond "it started"

- **`KeepAlive`** restarts a process that exits — a crash, an OOM, an uncaught
  rejection. It says nothing about a process that is still running and no
  longer answering. That is the failure mode this app actually has: a blocked
  event loop during ONNX inference, or a model call that never returns.
  `com.solenoid.watchdog` polls `/health` every two minutes and kickstarts the
  server after three consecutive misses. Three, not one, so a slow vision call
  is not mistaken for a hang.
- **`ThrottleInterval`** (15s server, 30s worker) keeps a misconfigured job
  from respawning in a tight loop and filling the disk with its own error.
- **Log rotation.** launchd appends to `StandardOutPath` forever and rotates
  nothing. `newsyslog-solenoid.conf` caps it at 10MB × 7. Install it; an
  always-on box with a chatty worker will find the ceiling.
- **`ProcessType: Interactive`** on the server opts out of the I/O and CPU
  throttling launchd applies to background work.
- **Backups.** `data/solenoid.db` is now a plain file in the repo directory and
  gitignored — which means it is in Time Machine's path if the repo is, and in
  nothing otherwise. Worth a `VACUUM INTO` on a `StartCalendarInterval` job.

---

## 5. Surviving a restart

1. **Power back on after a cut** — off by default:
   ```bash
   sudo systemsetup -setrestartpowerfailure on
   ```
2. **Do not sleep.** This is a laptop, which is the weak part of the plan; on
   AC only, so a battery run does not cook itself:
   ```bash
   sudo pmset -c sleep 0 disablesleep 1
   pmset -g                      # verify
   ```
   `disablesleep 1` covers a closed lid too.
3. **Get to a logged-in session without you.** LaunchAgents load at login, so
   this is the whole ballgame. Options, honestly ranked:
   - **Automatic login** (System Settings → Users & Groups → Automatic login).
     Requires FileVault off. On a machine holding your messages and contacts
     that is a real trade — worth a minute's thought, not a shrug. Pair it with
     a login item that immediately locks the screen if you take it.
   - **FileVault on, planned reboots only:** `sudo fdesetup authrestart`
     unlocks the disk once on the next boot. Covers `softwareupdate` reboots
     and nothing else — an unplanned power cut still stops at the login window.
   - **Accept it:** the stack comes up next time you log in. Fine if the Mac is
     one you use daily.
4. **Verify by rebooting.** Twice. Autostart chains fail silently and only in
   the case you did not try. After the reboot, from your phone on the tailnet:
   `https://mac.tailde1d78.ts.net` should answer with no intervention.

`tailscale serve` needs nothing: it is already configured on both machine
names, tailscaled restores that config at boot, and it proxies to
`127.0.0.1:3000` which is exactly where the server binds.

---

## 6. What you are giving up, and how to blunt it

| Lost with containers | Mitigation on the host |
| --- | --- |
| Pinned runtime | `bun install --frozen-lockfile` in `install.sh`; absolute path to one bun. Pin the bun version itself with `bun upgrade --to <version>` if a surprise ever bites. |
| Clean rebuild from scratch | `git clean -xfd && ./deploy/host/install.sh` is close, and does not need a working `docker`. |
| Resource limits | `Nice`, `ProcessType`, and `ThrottleInterval`. No memory ceiling — launchd has no equivalent of `mem_limit`. |
| Atomic rollback | `git checkout <sha> && ./deploy/host/update.sh`. Migrations do not roll back; that was already true. |
| Process isolation | None. This process has Full Disk Access, by design. Keep the API on loopback and behind tailnet auth — which it is. |

---

## 7. Install

```bash
cd /Users/eli/Documents/Code/solenoid-assistant
less deploy/host/install.sh          # read it first
./deploy/host/install.sh             # add --with-phoenix if you want it native
```

Then the two manual steps it prints:

- **Full Disk Access** for `/Users/eli/.bun/bin/bun`, then
  `launchctl kickstart -k gui/501/com.solenoid.server`
- `sudo cp deploy/host/newsyslog-solenoid.conf /etc/newsyslog.d/solenoid.conf`

For native Phoenix: `uv tool install arize-phoenix` first, then re-run with
`--with-phoenix`. It reuses the existing `phoenix_data/`, so the traces the
container wrote carry over. Or set `PHOENIX_TRACING_ENABLED=false` in `.env`
and skip it — that is the last thing Docker was doing on this machine.

### Verify, in order

```bash
launchctl print gui/501/com.solenoid.server | head -20   # state = running
curl -s localhost:3000/health                            # {"status":"ok"}
open http://localhost:3000                               # the UI, one origin
tail -f ~/Library/Logs/solenoid/worker.log               # "next run ..."
curl -s "localhost:3000/screenshots?hoursBack=1"         # proves PATH + FDA
curl -s localhost:3000/message-extraction | head         # proves the TCC grant
```

The last two are the ones worth running deliberately: they are the workflows
that a container could not have run at all, and they are also the two that fail
silently when `PATH` or Full Disk Access is wrong.

### Day-to-day

```bash
./deploy/host/update.sh                              # pull, build, migrate, restart
launchctl kickstart -k gui/501/com.solenoid.worker   # restart one job
launchctl bootout gui/501/com.solenoid.worker        # stop it until re-bootstrapped
./deploy/host/install.sh                             # after editing any plist
```

---

## 8. Files here

```
install.sh                     idempotent installer + the manual steps it cannot do
update.sh                      pull, build, migrate, kickstart
worker-entry.ts                waits for /health, then starts the worker
watchdog.sh                    /health poll -> kickstart after 3 misses
com.solenoid.server.plist
com.solenoid.worker.plist
com.solenoid.phoenix.plist     optional
com.solenoid.watchdog.plist    optional
newsyslog-solenoid.conf        log rotation (needs sudo to install)
```

All paths are hardcoded to `/Users/eli/Documents/Code/solenoid-assistant`,
`/Users/eli/.bun/bin/bun` and `gui/501`. Change them in one pass if the repo
moves.
