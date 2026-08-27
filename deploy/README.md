# Containerising Solenoid Assistant

> **Superseded — see [`deploy/host/README.md`](host/README.md).** Running under
> launchd on the host is the recommended deployment: it costs no workflows, no
> config deltas, and no SQLite/VM boundary. This plan is kept as the
> alternative, and §1 below is still the clearest statement of why.

A plan, plus draft files. Nothing here is wired into the repo yet: the root
`docker-compose.yml` is untouched, no source file has changed, and nothing has
been built or run.

---

## 1. The thing that decides the shape

Three of the five workflows are not portable, and no amount of Dockerfile gets
around it:

| Workflow | Needs | In a Linux container |
| --- | --- | --- |
| `weather-briefing` | HTTP | works |
| `safety-classification` | Prompt Guard ONNX, CPU | works — `onnxruntime-node` ships `bin/napi-v6/linux/arm64` |
| `message-extraction` | `~/Library/Messages/chat.db`, `~/Library/Application Support/AddressBook` | works **only** off a host-side snapshot (§5) |
| `screenshot-classification` | `osxphotos` + the Photos library | **impossible** — `osxphotos` is macOS-only and reaches PhotoKit |
| `screenshot-ingestion` | same, plus iCloud downloads | **impossible** |

`src/http/routes/screenshots.ts` calls `osxphotos` in-process, so the four
`/screenshots/*` endpoints fail inside a container regardless of how the rest
is arranged. That is not a bug to fix in the Dockerfile; it is a boundary. The
plan below containerises everything up to that boundary and phases the rest.

The second structural fact: **SQLite must have exactly one machine writing to
it.** Docker Desktop on macOS puts the containers in a Linux VM, and POSIX
advisory locks do not cross the virtiofs boundary reliably. A bind-mounted
`data/solenoid.db` written by both a host process and a container is a
corruption story waiting to happen. So the database moves to a named Docker
volume, and anything on the host that wants to write to it goes through the
HTTP API instead.

---

## 2. Target architecture

```
  macOS host                                     Docker (Linux VM)
  ─────────                                      ─────────────────
  launchd: compose-up.sh ──────────────────────► [ migrate ]  one-shot, exits
  launchd: mirror-host-data.sh                        │
        └─ ./hostmirror (chat.db, AddressBook)        ▼
                       │  ro bind          ┌──► [ app ]    :3000 → 127.0.0.1:3000
                       └───────────────────┤          │
  tailscale serve ─► 127.0.0.1:3000        └──► [ worker ]  cron, no port
                                                      │
  LM Studio / Ollama ◄── host.docker.internal ────────┤
                                                      ├──► [ phoenix ]      spans, :6006 → 127.0.0.1:6006
                                                      └──► [ victorialogs ] logs,  :9428 → 127.0.0.1:9428

  volume solenoid-data     ── /app/data/solenoid.db (single writer: app + worker only)
  volume victorialogs-data ── /victoria-logs-data   (30d retention)
  bind ../okf, ../models:ro, ../.env, ../tasks.yaml:ro
```

Four services, one image:

| Service | Command | Restart | Why separate |
| --- | --- | --- | --- |
| `migrate` | `scripts/db-migrate.ts` | `no` | `getDb()` migrates on first use, so `app` and `worker` would otherwise race the same migration on a cold start. One-shot, gated by `service_completed_successfully`. |
| `app` | `src/server.ts` | `unless-stopped` | Serves the API and `web/dist` on one origin, which is what the installed PWA needs. |
| `worker` | `src/worker.ts` | `unless-stopped` | A crash-looping cron worker should not take the UI down with it. `scripts/start-all.ts` stays the local-dev path and is not used in the image. |
| `phoenix` | upstream image | `unless-stopped` | Already exists at the repo root; folded in here so one `compose up` is the whole stack. |

---

## 3. The image (`deploy/Dockerfile`)

- **`oven/bun:1.3.6-slim`, not Alpine.** `onnxruntime-node` ships glibc `.so`
  files and has no musl build — Prompt Guard would not load at all on Alpine.
- **Four stages**: `deps` (dev deps, for Vite) → `web` (`bun run build:web`) →
  `prod-deps` (`--production`) → `runtime`. The runtime image gets prod
  `node_modules`, `src`, `scripts`, `drizzle`, `tasks.yaml` and `web/dist`.
- **`node_modules` is never copied from the host.** `onnxruntime-node` and
  `sharp` are platform-specific; the macOS binaries are useless in the image.
  `.dockerignore` enforces it.
- **Non-root (`bun`).** The mountpoints are created and chowned in the image so
  Docker seeds the named volume with the right ownership.
- Build for `linux/arm64` (the default on this Mac). Add `--platform` only if
  the stack later moves to an x86 host.

---

## 4. State, and where it lives

| Path in container | Backed by | Mode | Reasoning |
| --- | --- | --- | --- |
| `/app/data/solenoid.db` | named volume `solenoid-data` | rw | ext4 inside the VM: correct SQLite locking. Costs you direct Finder access — see backups below. |
| `/app/.env` | bind `../.env` | **rw** | `src/mcp/notionClient.ts` rotates the Notion refresh token straight back into `.env`. Mount it read-only or hand it in as a Docker secret and the token rotation silently breaks. |
| `/app/tasks.yaml` | bind `../tasks.yaml` | ro | Edit schedules and restart `worker`; no rebuild. |
| `/app/okf` | bind `../okf` | rw | Markdown meant to be read and edited by hand. Plain file writes, so the bind mount is safe here in a way it is not for SQLite. |
| `/app/models` | bind `../models` | ro | ~500MB, licence-gated, gitignored. Mount, don't bake. |
| `/hostmirror` | bind `../hostmirror` | ro | Phase 2 only. |
| `/mnt/data` (phoenix) | bind `../phoenix_data` | rw | Unchanged from today. |

**Backups.** A named volume is not on Time Machine's path. Add a nightly job
that writes a consistent copy onto a bind-mounted host directory — `VACUUM
INTO` is the right primitive here, since it takes a proper read lock rather
than copying a file out from under WAL:

```bash
# with ../backups mounted at /app/backups
docker compose -f deploy/compose.yaml exec app bun -e '
  import { Database } from "bun:sqlite";
  new Database("/app/data/solenoid.db", { readonly: true })
    .exec("VACUUM INTO \'/app/backups/solenoid.db\'");
'
```

Worth doing on day one: a named volume is easy to lose to a stray `docker
volume prune`, and nothing else in this stack holds that data.

---

## 5. Configuration deltas

`.env` stays the source of truth and is mounted in. Compose environment wins
over `.env` under Bun, so the container-only overrides live in
`deploy/compose.yaml`:

| Variable | Host value today | In the container | Why |
| --- | --- | --- | --- |
| `HOST` | `127.0.0.1` | `0.0.0.0` | Loopback inside a container means nothing can reach it, including the port publish. The posture is preserved by publishing to `127.0.0.1:3000:3000` — the API is still this-machine-only, and `bun run serve:tailscale` on the host still works unchanged. |
| `DATABASE_URL` | `./data/solenoid.db` | `/app/data/solenoid.db` | Named volume. |
| `PHOENIX_COLLECTOR_ENDPOINT` | `http://localhost:6006` | `http://phoenix:6006` | Service DNS. |
| `VICTORIALOGS_ENDPOINT` | `http://localhost:9428` | `http://victorialogs:9428` | Service DNS. Shipping is best-effort, so nothing waits on this being up. |
| `LOG_FORMAT` | `auto` | `json` | No TTY in a container, so `auto` would choose JSON anyway. Said out loud because `docker compose logs` reads these too. |
| `PROMPT_GUARD_MODEL_PATH` | `models/prompt-guard-2-86m` | `/app/models/prompt-guard-2-86m` | Absolute, since cwd is `/app`. |
| `OPENAI_BASE_URL` | LAN IP or `localhost` | `http://host.docker.internal:1234/v1` **if LM Studio runs on this Mac** | A LAN IP needs no change. `localhost` does. |
| `OLLAMA_API_URL` | `https://ollama.com` or `localhost:11434` | `http://host.docker.internal:11434` for a local Ollama | Same reason. |
| `NOTION_MCP_REDIRECT_URI` | `http://localhost:3001/callback` | unchanged | Run `bun run auth:notion` **on the host**, not in the container — it opens a browser and binds :3001. The tokens land in the mounted `.env`. |

### The one code change worth making (Phase 2)

`src/imessage/reader.ts:37` and `src/contacts/trustGate.ts:28` both derive
their defaults from `process.env.HOME`. Two options:

1. **Recommended, ~4 lines:** add `IMESSAGE_DB_PATH` and `ADDRESS_BOOK_DIR`
   overrides to those defaults (and ideally to `src/core/config.ts`, so they
   are validated like everything else). `deploy/compose.yaml` already sets
   them.
2. **Zero code change:** set `HOME=/hostmirror` in the container so both
   defaults resolve into the mirror. Works, but it also moves Bun's idea of
   home onto a read-only mount, which will bite something eventually.

Take option 1.

---

## 6. What stays on the host

- **`osxphotos` and the screenshot workflows.** Two ways forward, later:
  - *Phase 3a (simple, degraded):* leave them out. `/screenshots/*` returns a
    502 in the container; you run `bun run catchup:screenshots` by hand on the
    host when you want them. **But** that host process writes to the database —
    so it must point at a database the containers are not using, or you are
    back to two writers. In practice this means Phase 3a is a stopgap only.
  - *Phase 3b (the real answer):* a small host-side bridge — a Bun HTTP service
    under launchd that exposes `query` / `export` by shelling out to
    `osxphotos`, and serves the exported files. `src/utils/osxPhotos.ts` grows
    one branch: if `OSXPHOTOS_BRIDGE_URL` is set, call it instead of spawning.
    Everything else, including every database write, stays in the container.
    Roughly a day's work and it makes the boundary explicit.
- **`bun run serve:tailscale`** — needs the `tailscale` CLI and the daemon's
  state. It proxies to `127.0.0.1:3000`, which is exactly where compose
  publishes. No change.
- **`bun run auth:notion`**, `setup:prompt-guard`, `make:icons` — one-off
  developer commands; keep running them on the host against the same checkout.

---

## 7. Autostart after a restart (macOS)

`restart: unless-stopped` is only the last of five things that have to be true.
In order:

1. **The Mac must power back on.** After a power cut it does not, by default:
   ```bash
   sudo systemsetup -setrestartpowerfailure on
   ```
2. **It must not sleep.** A sleeping Mac serves nothing to the tailnet:
   ```bash
   sudo pmset -a sleep 0 disablesleep 1   # desktop; on a laptop, lid-closed needs care
   pmset -g                               # verify
   ```
3. **Someone must be logged in.** Docker Desktop is a GUI app: it starts at
   *login*, not at *boot*. After a reboot the Mac sits at the login window and
   nothing runs. Pick one:
   - **Automatic login** (System Settings → Users & Groups → Automatic login).
     Requires FileVault off — a real trade for a machine holding your messages.
     Fine for a Mac in your house; think about it first.
   - **Colima instead of Docker Desktop**, installed as a *daemon*:
     `brew install colima docker docker-compose`, then
     `sudo brew services start colima` — a LaunchDaemon runs before login.
     This is the only genuinely login-free option on macOS.
   - Accept that the stack starts when you next log in.
4. **Docker must start itself.** Docker Desktop → Settings → General →
   *Start Docker Desktop when you sign in* (and untick *Open Docker Dashboard
   at startup*).
5. **The project must come up.** `restart: unless-stopped` on every long-lived
   service covers reboots and daemon restarts for containers that already
   exist. It does **not** cover a project that was last left `compose down`, or
   an image that needs rebuilding. `deploy/launchd/com.solenoid.compose.plist`
   is the belt to that braces: at login it waits for the Docker socket, then
   runs `compose up -d`. It is a no-op when everything is already up.

> `unless-stopped`, not `always`: if you deliberately stop a container, a
> daemon restart should not resurrect it.

**Test it for real.** Reboot the machine, wait, and check from another device on
the tailnet. Autostart chains fail silently and only in the case you did not
try.

### If this ever moves to Linux

Simpler: `systemctl enable docker`, plus a unit that runs
`docker compose -f /srv/solenoid/deploy/compose.yaml up -d` with
`Restart=on-failure` and `After=docker.service`. No login problem, no GUI, no
virtiofs, and the SQLite bind-mount caveat in §1 disappears — which is a decent
argument for eventually putting this on a small Linux box.

---

## 8. Phased checklist

**Phase 0 — prep (no behaviour change)**
- [ ] Read the drafts here; adjust paths and `TZ`.
- [ ] Decide Docker Desktop vs Colima (§7.3) before building — it changes
      nothing about the image, but it decides step 3.
- [ ] `docker build -f deploy/Dockerfile -t solenoid-assistant:local .` and
      check `web/dist/index.html` exists in the image.

**Phase 1 — the portable half runs in containers**
- [ ] Stop and delete the root `docker-compose.yml` phoenix stack (name and
      port collision with the new one).
- [ ] `docker compose -f deploy/compose.yaml up -d --build`.
- [ ] Seed the database into the new volume: `db:migrate` runs automatically;
      run `db:seed` / `db:index-okf` via `compose run --rm app bun run ...`.
      If you want the *existing* `data/solenoid.db` carried over, copy it in
      with `docker compose cp` while the stack is down — do not bind-mount it.
- [ ] Verify: `/health`, the UI at `http://localhost:3000`, a weather task
      firing in `worker` logs, traces landing in Phoenix, Prompt Guard loading
      (`/safety` with something adversarial).
- [ ] Confirm `bun run serve:tailscale` still reaches it from a phone.

**Phase 2 — iMessage and Contacts**
- [ ] Add the `IMESSAGE_DB_PATH` / `ADDRESS_BOOK_DIR` overrides (§5).
- [ ] Install `com.solenoid.hostmirror.plist`; grant Full Disk Access to the
      binary launchd runs (`/bin/bash`) and re-kickstart the job.
- [ ] Add `hostmirror/` to `.gitignore` — it is a copy of your messages.
- [ ] Verify `message-extraction` end to end, and that the mirror refreshes.

**Phase 3 — screenshots** — build the bridge (§6, Phase 3b), or consciously
leave the two Photos workflows as host-only and say so in the UI.

**Phase 4 — always-on**
- [ ] Steps 1–5 of §7.
- [ ] Pin the Phoenix image tag.
- [ ] Nightly database backup out of the volume (§4).
- [ ] Reboot test.

---

## 9. Risks worth pricing in

| Risk | Severity | Handling |
| --- | --- | --- |
| SQLite across the VM boundary | **high** — silent corruption | Named volume; one writer; never bind-mount the `.db`. |
| Two containers migrating at once | medium | One-shot `migrate` service with `service_completed_successfully`. |
| `.env` mounted read-only | medium | Notion token rotation fails ~8h in, quietly. Mount rw. |
| `latest` Phoenix tag | medium | Pin it. |
| `onnxruntime-node` on the wrong libc/arch | medium | Debian slim; install inside the image; `node_modules` in `.dockerignore`. |
| Full Disk Access for the launchd mirror job | medium | macOS grants FDA per *binary*; granting it to Terminal is not enough. Expect one round of "zero contacts loaded" before it takes. |
| Autostart that only fails after a reboot | medium | Actually reboot. Twice. |
| `HOST=0.0.0.0` misread as exposure | low | It is container-internal; the publish is `127.0.0.1`. Keep it that way — there is still no authentication on this API. |
| Container image holds no personal data | low | `.dockerignore` excludes `data/`, `okf/`, `.env`, `.screenshots/`. Worth re-checking before any `docker push`. |

---

## 10. Files drafted here

```
.dockerignore                                 (repo root — new)
deploy/Dockerfile
deploy/compose.yaml
deploy/scripts/compose-up.sh
deploy/scripts/mirror-host-data.sh
deploy/launchd/com.solenoid.compose.plist
deploy/launchd/com.solenoid.hostmirror.plist
```

Both plists have `USERNAME` placeholders. `compose.yaml` mounts
`../hostmirror` — comment that line out until Phase 2.
