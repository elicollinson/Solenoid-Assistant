#!/bin/bash
# Install (or re-install) the launchd jobs. Idempotent: safe to re-run after
# every change to a plist or to the app.
#
# Does not ask for sudo. The one step that needs it — log rotation — is printed
# at the end for you to run yourself.
set -euo pipefail

REPO="/Users/eli/Documents/Code/solenoid-assistant"
BUN="/Users/eli/.bun/bin/bun"
AGENTS="$HOME/Library/LaunchAgents"
LOGS="$HOME/Library/Logs/solenoid"
DOMAIN="gui/$(id -u)"

# Phoenix is optional; pass --with-phoenix to install that job too.
JOBS=(com.solenoid.server com.solenoid.worker com.solenoid.watchdog)
[[ "${1:-}" == "--with-phoenix" ]] && JOBS+=(com.solenoid.phoenix)

cd "$REPO"

echo "==> dependencies"
"$BUN" install --frozen-lockfile

echo "==> web bundle (so :3000 serves the UI on one origin)"
"$BUN" run build:web

echo "==> migrations"
"$BUN" run db:migrate

mkdir -p "$LOGS" "$AGENTS"

for job in "${JOBS[@]}"; do
  echo "==> $job"
  # bootout first: bootstrap on an already-loaded label is an error, and this
  # is the supported way to pick up an edited plist.
  launchctl bootout "$DOMAIN/$job" 2>/dev/null || true
  cp "$REPO/deploy/host/$job.plist" "$AGENTS/$job.plist"
  launchctl bootstrap "$DOMAIN" "$AGENTS/$job.plist"
  launchctl enable "$DOMAIN/$job"
done

cat <<NOTES

Installed: ${JOBS[*]}

Two things left, both by hand:

  1. Full Disk Access for $BUN
     System Settings -> Privacy & Security -> Full Disk Access -> + -> Cmd-Shift-G
     -> paste the path above. Then restart the jobs:
         launchctl kickstart -k $DOMAIN/com.solenoid.server
     Without this: "zero contacts loaded" and an unopenable chat.db.
     Expect to redo it after a 'bun upgrade' — the grant follows the binary.

  2. Log rotation
         sudo cp deploy/host/newsyslog-solenoid.conf /etc/newsyslog.d/solenoid.conf

Check it:
    launchctl print $DOMAIN/com.solenoid.server | head -20
    tail -f $LOGS/server.log
    curl -s localhost:3000/health
NOTES
