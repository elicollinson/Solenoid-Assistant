# syntax=docker/dockerfile:1.7
#
# Solenoid Assistant — one image, three entrypoints (migrate, server, worker).
#
# Debian-based rather than Alpine on purpose: onnxruntime-node ships prebuilt
# glibc .so files (bin/napi-v6/linux/{arm64,x64}) and there is no musl build,
# so Prompt Guard would not load at all on Alpine.
#
# Build context is the repo root:
#   docker build -f deploy/Dockerfile -t solenoid-assistant:local .

ARG BUN_VERSION=1.3.6

# ── dependencies (dev included — vite and the React compiler live there) ─────
FROM oven/bun:${BUN_VERSION}-slim AS deps
WORKDIR /app
COPY package.json bun.lock ./
# Native postinstalls (onnxruntime-node, protobufjs) run here, against Linux,
# which is the whole reason node_modules is never copied from the host.
RUN bun install --frozen-lockfile

# ── the web bundle ──────────────────────────────────────────────────────────
FROM deps AS web
WORKDIR /app
COPY tsconfig.json ./
COPY web ./web
RUN bun run build:web

# ── runtime dependencies only ───────────────────────────────────────────────
FROM oven/bun:${BUN_VERSION}-slim AS prod-deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# ── the image that ships ────────────────────────────────────────────────────
FROM oven/bun:${BUN_VERSION}-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=prod-deps /app/node_modules ./node_modules
COPY package.json bun.lock tsconfig.json tasks.yaml ./
COPY drizzle ./drizzle
COPY src ./src
COPY scripts ./scripts
COPY --from=web /app/web/dist ./web/dist

# Mountpoints have to exist and be owned by `bun` *in the image*: Docker seeds
# an empty named volume from the image directory it covers, ownership included.
RUN mkdir -p /app/data /app/okf /app/models /app/.screenshots \
 && chown -R bun:bun /app

USER bun
EXPOSE 3000

# The server is the default; compose overrides it for the worker and the
# one-shot migrate step.
CMD ["bun", "run", "src/server.ts"]
