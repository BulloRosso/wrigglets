#!/bin/sh
# Agent container entrypoint (spec §5.1 deploy/startup.sh).
# Runs as root only long enough to make the persistent /home writable for the app user,
# then drops privileges. On App Service, /home is an SMB mount owned by root.
set -eu

HOME_ROOT="${HOME_ROOT:-/home}"
for d in workspace artifacts staging .oc backups; do
  mkdir -p "$HOME_ROOT/$d"
done

if [ "$(id -u)" = "0" ]; then
  # Only fix ownership of our own directories (cheap on a fresh volume, idempotent afterwards).
  chown node:node "$HOME_ROOT" "$HOME_ROOT/workspace" "$HOME_ROOT/artifacts" "$HOME_ROOT/staging" "$HOME_ROOT/.oc" "$HOME_ROOT/backups" 2>/dev/null || true
  if [ "$(stat -c %U "$HOME_ROOT/workspace")" != "node" ]; then
    chown -R node:node "$HOME_ROOT/workspace" "$HOME_ROOT/artifacts" "$HOME_ROOT/staging" "$HOME_ROOT/.oc" 2>/dev/null || true
  fi
  mkdir -p /tmp/harness && chown node:node /tmp/harness
  exec setpriv --reuid=node --regid=node --init-groups -- env HOME=/home/node node /app/dist/main.js
fi

exec node /app/dist/main.js
