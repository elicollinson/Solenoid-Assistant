---
name: deploy-mini-cloud-app
description: Deploy, update, or remove an application on the mini-cloud Mac mini appliance. Use when adding a hosted app (a container reachable at NAME.home.arpa), wiring it into Caddy/Homepage/observability, giving it secrets or storage, or promoting a custom image. Covers the Git-authoritative declare→validate→plan→apply→verify workflow and every manual step. The worked example is compose/apps/whoami.yaml.
---

# Deploying an app to mini-cloud

mini-cloud is **Git-authoritative**: an app is deployed by committing its desired
state to this repo and running the apply pipeline — never by `docker run` on the box.
The complete, working reference is the **whoami** demo: `compose/apps/whoami.yaml`, its
route in `caddy/Caddyfile`, and its entry in `homepage/services.yaml`. Read those three
first; this skill generalises them.

## The mental model

- **One app = one Compose module** under `compose/apps/<name>.yaml`, pulled into the root
  project by an `include:` line in `compose/compose.yaml`.
- **Only Caddy publishes host ports.** Your app uses `expose:` and joins the `cloud-edge`
  network; Caddy routes `NAME.home.arpa` to it. Backends are never reachable directly.
- **Networks scope blast radius.** Every app joins `apps`. Add `cloud-edge` if Caddy
  routes to it, `storage` if it uses Valkey/Garage, `observability` if it emits telemetry.
  Declare each with an explicit `name:` (so `include:` merging dedupes).
- **Images are pinned** to an exact tag (never `latest`), and must have a `linux/arm64`
  manifest (the VM is ARM). `restart: unless-stopped` and json-file log rotation on every
  service.
- **DNS and TLS are automatic.** dnsmasq answers `*.home.arpa` wildcard, so a new
  hostname resolves with no extra step, and Caddy mints its cert from the internal CA on
  first request. A client that already trusts the CA root (see `docs/client-access.md`)
  trusts every new `*.home.arpa` name automatically — **no per-app cert step**.

## Add an app — the workflow

Worked with whoami; substitute your app. Steps 1–4 are edits; 5 is the only pipeline run.

### 1. Write the Compose module — `compose/apps/<name>.yaml`

```yaml
services:
  myapp:
    image: ghcr.io/you/myapp:1.4.2      # exact tag, arm64
    container_name: myapp                # required for Homepage stats binding
    restart: unless-stopped
    expose: ["8080"]                     # container port; NOT published
    networks: [apps, cloud-edge]         # + storage / observability as needed
    healthcheck:                         # omit for scratch/distroless images
      test: ["CMD", "wget", "-qO-", "http://localhost:8080/health"]
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 20s
    logging:
      driver: json-file
      options: {max-size: "10m", max-file: "3"}

networks:
  apps: {name: apps}
  cloud-edge: {name: cloud-edge}
```

### 2. Route it — `caddy/Caddyfile`

```
myapp.home.arpa {
	import local_tls
	reverse_proxy myapp:8080 {
		health_uri /health          # active check; drop the block if none
		health_interval 5s
		health_timeout 5s
	}
}
```

### 3. Portal entry — `homepage/services.yaml` (under `- Applications:`)

```yaml
    - MyApp:
        icon: mdi-application            # or a dashboard-icons name
        href: https://myapp.home.arpa
        siteMonitor: http://myapp:8080/health
        server: mini-cloud
        container: myapp
```

### 4. Register in the root project — `compose/compose.yaml`

Add one line under `include:`:

```yaml
  - apps/myapp.yaml
```

### 5. Validate → commit → apply → verify (the manual steps)

```sh
# a. Static validation — safe anywhere, changes nothing. Same as CI.
make validate

# b. Commit. Git is the source of truth; apply refuses to deploy drift cleanly
#    and rollback reverts commits.
git add compose/apps/myapp.yaml compose/compose.yaml caddy/Caddyfile homepage/services.yaml
git commit -m "apps: add myapp"

# c. Apply. This is the deploy. It pulls images and converges the stack with
#    secrets decrypted ONLY into the compose process (never written to disk):
#    scripts/apply wraps compose in `sops exec-env secrets/prod.env ...`.
export SOPS_AGE_KEY_FILE="$HOME/.config/sops/age/keys.txt"   # macOS: not the default path
make apply            # or: ./scripts/apply  (runs Ansible too; --skip-ansible to skip)

# d. Verify functionally, not just "running".
make verify
curl -k https://myapp.home.arpa/        # or open it in a browser
```

`scripts/apply` reloads Caddy after converging, so a new or changed `NAME.home.arpa`
route goes live in the same step — `compose up` alone would not, because Caddy's config is
a bind-mounted file it doesn't watch and its container definition is unchanged.

There is **no automated deploy-on-merge** — `apply` is run on the appliance (Terraform
plan/apply style). `make plan` shows the delta first if you want a dry run.

## Variations

**Secrets** — never in the compose file. Reference `${VAR:?}` and add the real value to
`secrets/prod.env`, then re-encrypt:
```sh
sops secrets/prod.env          # opens $EDITOR, re-encrypts on save; add MYAPP_TOKEN=...
```
`.sops.yaml` already allowlists `secrets/prod.env`. `scripts/apply` injects it via
`sops exec-env`, so `${MYAPP_TOKEN:?}` resolves at apply time. Retrieve one to check with
`sops exec-env secrets/prod.env 'printenv MYAPP_TOKEN'`. See `docs/iac/sops-age.md`.

**Uses Valkey** — add `storage` to `networks:` and connect to `redis://valkey:6379`.
Every cache-like key MUST carry a TTL (Valkey runs `noeviction`; see `docs/platform/valkey.md`).

**Uses object storage** — add `storage`, declare a bucket in `garage/buckets.yaml`, then
`sops exec-env secrets/prod.env ./garage/reconcile-buckets.sh`. Talk to `http://garage:3900`,
region `garage`, path-style. See `docs/platform/garage.md`.

**Emits telemetry** — add `observability` and point the app's OTLP exporter at
`http://otel-collector:4317` (gRPC) or `:4318` (HTTP). Traces fan out to Phoenix, logs to
VictoriaLogs. Note: Phoenix drops OTLP silently until its API key is set — see
`docs/observability/phoenix.md`.

**Your own image (custom build)** — app code lives in its **own repo**; mini-cloud only
pins the digest that runs. The pipeline is built:
- The app repo's CI calls the reusable `.github/workflows/build-publish.yml` (via
  `uses: elicollinson/mini-cloud/.github/workflows/build-publish.yml@main`): native
  arm64 build → Trivy scan → push to GHCR by digest.
- After pushing, the app repo sends a `repository_dispatch` to mini-cloud
  (`event_type: promote-image`, payload `{app, image_ref}`); `.github/workflows/promote-image.yml`
  runs `scripts/promote` and opens a **promotion PR** that pins the digest in
  `compose/apps/<app>.yaml`. Pushing an image deploys nothing — merging that PR does.
- The dispatch needs a fine-grained PAT (or GitHub App) scoped to mini-cloud with
  `contents:write`, stored as a secret in the app repo. Set a `PROMOTE_TOKEN` secret in
  mini-cloud too, so the promotion PR triggers `validate.yml` (a PR opened with the default
  `GITHUB_TOKEN` won't run checks).
- Manual promotion any time: `scripts/promote <app> <ghcr-ref>` (a tag is resolved to its
  digest; a `@sha256:` ref is pinned as-is), then commit → `make apply`.
- Roll back: revert the promotion commit → `make apply`.

Worked example built from source in this repo: `examples/hello/` +
`.github/workflows/hello-image.yml` (same-repo variant) + `compose/apps/hello.yaml`. Full
detail and the token setup: `docs/iac/github-actions-ghcr.md`.

## Update, roll back, remove

- **Update**: change the pinned tag/digest in `compose/apps/<name>.yaml` → commit →
  `make apply` → `make verify`.
- **Roll back**: `make rollback` (git-reverts the last applied change, re-applies, re-verifies).
- **Remove**: delete `compose/apps/<name>.yaml`, its `include:` line, its Caddy block, and
  its Homepage entry → commit → `make apply` (`up -d --remove-orphans` stops the container;
  named volumes are preserved — remove those deliberately and separately).

## When it doesn't work

- **Loads on the mini but not your laptop/phone** → it's client DNS/CA, not the app. See
  the decision tree in `docs/client-access.md` ("server cannot be found" = DNS; "couldn't
  establish a secure connection" = trust the CA at `http://ca.home.arpa/root.crt`).
- **502 from Caddy** → the container isn't healthy yet or the route port is wrong; check
  `make status` and `docker logs <name>` (via the `lima-cloud` context).
- **`required variable ... is missing`** → you ran compose without secrets; deploy through
  `scripts/apply` / `sops exec-env secrets/prod.env`, not bare `docker compose`.
- **`no matching manifest for linux/arm64`** → the image has no ARM build; pick another
  tag or build your own (GHCR flow above).

## Guardrails

Work through `scripts/`; never `docker run` / `limactl` / `brew` / `sudo` directly (see
`docs/agent-policy.md`). Never commit a plaintext secret. Only Caddy publishes ports. Every
image pinned. The full new-service checklist also lives in the README's "Contributing changes".
