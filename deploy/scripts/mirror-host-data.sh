#!/bin/bash
# Snapshot the macOS databases the container cannot reach into ./hostmirror,
# laid out under the same paths they have in $HOME so nothing downstream has to
# learn a second shape.
#
# Why a copy rather than a bind mount of ~/Library: the container would be
# opening a live WAL database across the virtiofs boundary, where SQLite's
# advisory locks do not cross reliably. A snapshot is read-only by definition
# and cannot be torn by Messages writing underneath it.
#
# Runs on the host, under launchd, as the logged-in user. That user's launchd
# job needs Full Disk Access — see deploy/README.md.
set -euo pipefail

REPO="${SOLENOID_REPO:-$HOME/Documents/Code/solenoid-assistant}"
DEST="$REPO/hostmirror"

mkdir -p "$DEST/Library/Messages" "$DEST/Library/Application Support"

# chat.db: copy the whole WAL set together, then let the reader recover from
# them. Copying chat.db alone loses every message still in the -wal.
for f in chat.db chat.db-wal chat.db-shm; do
  [ -f "$HOME/Library/Messages/$f" ] && cp -f "$HOME/Library/Messages/$f" "$DEST/Library/Messages/$f"
done

# AddressBook: the whole tree, because the contacts live in per-source
# subdirectories (Sources/<UUID>/AddressBook-v22.abcddb), not just the root.
rsync -a --delete \
  "$HOME/Library/Application Support/AddressBook/" \
  "$DEST/Library/Application Support/AddressBook/"

echo "mirrored to $DEST at $(date -Iseconds)"
