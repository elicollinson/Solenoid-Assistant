#!/bin/bash
# Deploy a new version: pull, install, rebuild the UI, migrate, restart.
#
# kickstart -k rather than bootout/bootstrap: the jobs are already loaded and
# their plists have not changed, only the code they run. Re-run install.sh
# instead when a plist itself changes.
set -euo pipefail

REPO="/Users/eli/Documents/Code/solenoid-assistant"
BUN="/Users/eli/.bun/bin/bun"
DOMAIN="gui/$(id -u)"

cd "$REPO"
git pull --ff-only
"$BUN" install --frozen-lockfile
"$BUN" run build:web
"$BUN" run db:migrate

# Server first, worker second — worker-entry.ts waits on the server's health,
# so this order is the same one a cold boot takes.
launchctl kickstart -k "$DOMAIN/com.solenoid.server"
launchctl kickstart -k "$DOMAIN/com.solenoid.worker"

echo "restarted. tail -f ~/Library/Logs/solenoid/server.log"
