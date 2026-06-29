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
  # Create directories with correct ownership
  install -d -o node -g node /data /home/node/.claude /home/node/.codex 2>/dev/null || true
  chown -R node:node /data /home/node/.claude /home/node/.codex /home/node/.npm 2>/dev/null || true

  # Persist ~/.claude.json on the same volume as ~/.claude/ so it survives
  # container restarts.  The Claude CLI stores session auth inside ~/.claude/
  # but writes top-level config to ~/.claude.json — without the symlink that
  # file lives on the ephemeral container layer and is lost on restart.
  CLAUDE_JSON_ON_VOL="/home/node/.claude/claude.json"
  CLAUDE_JSON_HOME="/home/node/.claude.json"
  if [ ! -L "$CLAUDE_JSON_HOME" ]; then
    # First run or symlink missing — migrate existing file into the volume
    if [ -f "$CLAUDE_JSON_HOME" ] && [ ! -L "$CLAUDE_JSON_HOME" ]; then
      mv "$CLAUDE_JSON_HOME" "$CLAUDE_JSON_ON_VOL" 2>/dev/null || true
    fi
    # Create the backing file if it doesn't exist yet
    [ -f "$CLAUDE_JSON_ON_VOL" ] || echo '{}' > "$CLAUDE_JSON_ON_VOL"
    chown node:node "$CLAUDE_JSON_ON_VOL"
    ln -sf "$CLAUDE_JSON_ON_VOL" "$CLAUDE_JSON_HOME"
    chown -h node:node "$CLAUDE_JSON_HOME"
  fi

  # Set TMPDIR inside the volume so that Claude CLI atomic rename (temp →
  # credential file) stays on the same filesystem and doesn't fail with EXDEV.
  CLAUDE_TMP="/home/node/.claude/tmp"
  install -d -o node -g node "$CLAUDE_TMP"
  export TMPDIR="$CLAUDE_TMP"

  # Mark /home/www (bind-mounted host projects) as safe for git.
  # Without this, git >= 2.36 refuses to operate in directories owned by a
  # different uid ("detected dubious ownership") — the host uid rarely matches
  # the container's node (1000).
  gosu node git config --global --add safe.directory '*'

  export HOME=/home/node
  exec gosu node "$@"
else
  exec "$@"
fi