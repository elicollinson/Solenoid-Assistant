#!/bin/bash
# The failure launchd cannot see.
#
# KeepAlive restarts a process that *exits*. It has nothing to say about one
# that is still running and no longer answering — a wedged event loop, a
# deadlocked ONNX session, a fetch that never resolves. This checks the thing
# that actually matters (does /health answer) and restarts the job when it
# stops, after three consecutive misses so a slow vision call is not mistaken
# for a hang.
set -uo pipefail

PORT="${PORT:-3000}"
STATE="/tmp/solenoid-watchdog.fails"
LIMIT=3
UID_NUM="$(id -u)"

if /usr/bin/curl -fsS --max-time 10 "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
  rm -f "$STATE"
  exit 0
fi

fails=$(( $(cat "$STATE" 2>/dev/null || echo 0) + 1 ))
echo "$fails" > "$STATE"
echo "$(date -Iseconds) health check failed (${fails}/${LIMIT})"

if [ "$fails" -ge "$LIMIT" ]; then
  echo "$(date -Iseconds) restarting com.solenoid.server"
  /bin/launchctl kickstart -k "gui/${UID_NUM}/com.solenoid.server"
  rm -f "$STATE"
fi
