#!/bin/sh
# Starts the watcher (+ Discord bot when DISCORD_BOT_TOKEN is set) and the web server.
# If either one exits, the script exits too, so the host restarts the whole container.
set -eu

mkdir -p /data/web /data/watcher

# The volume is mounted owned by root. Hand it to the unprivileged user, then drop root.
if [ "$(id -u)" = "0" ]; then
  chown -R app:app /data
  exec setpriv --reuid=app --regid=app --init-groups "$0" "$@"
fi

# The web app and the watcher talk over localhost. If no shared token was set as a secret,
# make one for this boot so the watcher API is never open, even inside the container.
if [ -z "${WATCHER_API_TOKEN:-}" ]; then
  WATCHER_API_TOKEN="$(python -c 'import secrets; print(secrets.token_urlsafe(32))')"
  export WATCHER_API_TOKEN
fi

cd /app
python -m watcher prod &
WATCHER_PID=$!

cd /app/web
node server.js &
WEB_PID=$!

STOPPING=0
stop() {
  kill -TERM "$WATCHER_PID" "$WEB_PID" 2>/dev/null || true
}
trap 'STOPPING=1; stop' TERM INT

# Wait until either process ends.
while kill -0 "$WATCHER_PID" 2>/dev/null && kill -0 "$WEB_PID" 2>/dev/null; do
  sleep 2
done
if [ "$STOPPING" = "1" ]; then
  wait || true
  exit 0
fi
echo "start.sh: a process exited; stopping the container so it restarts" >&2
stop
wait || true
exit 1
