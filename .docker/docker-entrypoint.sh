#!/bin/sh
# Fix ownership of app-owned volumes, then drop to node user.
# Do not chown the projects bind mount: on Docker Desktop a recursive ownership
# pass over a host projects directory can make startup appear hung.
#
# IMPORTANT: `docker compose exec` runs as root and bypasses this entrypoint.
# If you run `claude /login` via exec, the credentials file will be owned by
# root and the agent (running as node) cannot read it. Always use:
#   docker compose exec -u node <service> claude /login
if [ "$(id -u)" = "0" ]; then
  install -d -o node -g node /data /home/node/.claude /home/node/.codex 2>/dev/null || true
  chown -R node:node /data /home/node/.claude /home/node/.codex 2>/dev/null || true
  if [ -e /home/node/.claude.json ]; then
    chown node:node /home/node/.claude.json 2>/dev/null || true
  fi
  export HOME=/home/node
  exec gosu node "$@"
else
  exec "$@"
fi
