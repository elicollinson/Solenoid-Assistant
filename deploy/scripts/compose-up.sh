#!/bin/bash
# Bring the stack up at login, once the Docker daemon is actually answering.
#
# `restart: unless-stopped` already restarts containers that exist. This is for
# the case it cannot cover: the project was brought down with `compose down`,
# or the image/compose file changed while the machine was off. It is a no-op
# when everything is already running.
set -euo pipefail

REPO="${SOLENOID_REPO:-$HOME/Documents/Code/solenoid-assistant}"
DOCKER="${DOCKER_BIN:-/usr/local/bin/docker}"

# Docker Desktop takes a while after login. Wait, but not forever.
for _ in $(seq 1 60); do
  if "$DOCKER" info >/dev/null 2>&1; then
    exec "$DOCKER" compose -f "$REPO/deploy/compose.yaml" up -d
  fi
  sleep 5
done

echo "docker daemon did not come up within 5 minutes" >&2
exit 1
