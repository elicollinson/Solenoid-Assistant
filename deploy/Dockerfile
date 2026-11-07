# syntax=docker/dockerfile:1.7
#
# Solenoid Assistant — one image, three entrypoints (migrate, server, worker).
#
# Build context is the repo root:
#   docker build -f deploy/Dockerfile -t solenoid-assistant:local .

# Base images are pinned by digest; Dependabot bumps them (see .github/dependabot.yml).
ARG VERSION=dev

# ── dependencies (dev included — vite and the React compiler live there) ─────
FROM oven/bun:1.3.6-slim@sha256:9d20d1b535596c4a021ba2087d2d303c4098e96be15f47775729cf7a259bb41e AS deps
WORKDIR /app
COPY package.json bun.lock ./
# Native postinstalls (protobufjs) run here, against Linux,
# which is the whole reason node_modules is never copied from the host.
RUN bun install --frozen-lockfile

# ── the web bundle ──────────────────────────────────────────────────────────
FROM deps AS web
WORKDIR /app
COPY tsconfig.json ./
COPY web ./web
COPY src/shared ./src/shared
RUN bun run build:web

# ── runtime dependencies only ───────────────────────────────────────────────
FROM oven/bun:1.3.6-slim@sha256:9d20d1b535596c4a021ba2087d2d303c4098e96be15f47775729cf7a259bb41e AS prod-deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# ── the image that ships ────────────────────────────────────────────────────
FROM oven/bun:1.3.6-slim@sha256:9d20d1b535596c4a021ba2087d2d303c4098e96be15f47775729cf7a259bb41e AS runtime
ARG VERSION
WORKDIR /app
ENV NODE_ENV=production

# The upgrade is deliberate: it picks up Debian security fixes newer than the
# base image, which Trivy otherwise fails the release on.
RUN apt-get update \
 && apt-get upgrade -y \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/*

LABEL org.opencontainers.image.source="https://github.com/elicollinson/Solenoid-Assistant" \
      org.opencontainers.image.title="Solenoid Assistant" \
      org.opencontainers.image.version="${VERSION}"

COPY --from=prod-deps /app/node_modules ./node_modules
COPY package.json bun.lock tsconfig.json ./
COPY drizzle ./drizzle
COPY src ./src
COPY scripts ./scripts
COPY --from=web /app/web/dist ./web/dist

# Mountpoints have to exist and be owned by `bun` *in the image*: Docker seeds
# an empty named volume from the image directory it covers, ownership included.
RUN mkdir -p /app/data /app/backups /app/okf /app/models /app/.screenshots \
 && chown -R bun:bun /app

USER bun
EXPOSE 3000

# The server is the default; compose overrides it for the worker and the
# one-shot migrate step.
CMD ["bun", "run", "src/server.ts"]
