#!/bin/sh
# Starts the Agent Harness once at image build time so that it installs its plugin dependencies
# into $HARNESS_HOME. At runtime the harness then starts without npm registry access.
# opencode installs them lazily when the first project instance is created, so we create a session.
set -eu

export HOME="${HARNESS_HOME:-/opt/harness-home}"
export XDG_DATA_HOME=/tmp/prewarm-data
export OPENCODE_SERVER_PASSWORD=prewarm
export OPENCODE_DISABLE_AUTOUPDATE=true OPENCODE_DISABLE_MODELS_FETCH=true OPENCODE_DISABLE_DEFAULT_PLUGINS=true
mkdir -p "$HOME" /tmp/prewarm-ws
cat > /tmp/prewarm.json <<'EOF'
{ "$schema": "https://opencode.ai/config.json", "autoupdate": false, "share": "disabled" }
EOF
export OPENCODE_CONFIG=/tmp/prewarm.json

cd /tmp/prewarm-ws
git init -q -b main .
opencode serve --hostname 127.0.0.1 --port 4999 >/tmp/prewarm.log 2>&1 &
PID=$!

AUTH="Basic $(printf 'opencode:prewarm' | base64)"
call() { node -e "fetch('http://127.0.0.1:4999$1',{method:'$2',headers:{authorization:'$AUTH','content-type':'application/json'},body:$3}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; }

ok=0
for i in $(seq 1 90); do
  if call /global/health GET undefined; then ok=1; break; fi
  sleep 1
done
if [ "$ok" != "1" ]; then echo "harness did not start during prewarm:"; cat /tmp/prewarm.log; exit 1; fi

# create a session → instance bootstrap → plugin dependency install
call /session POST "JSON.stringify({title:'prewarm'})" || true
for i in $(seq 1 120); do
  if [ -d "$HOME/.config/opencode/node_modules/@opencode-ai" ]; then break; fi
  sleep 1
done
sleep 5
kill "$PID" 2>/dev/null || true
wait "$PID" 2>/dev/null || true
if [ ! -d "$HOME/.config/opencode/node_modules" ]; then
  echo "WARNING: harness plugin dependencies were not installed during prewarm"; cat /tmp/prewarm.log
fi
rm -rf "$HOME/.npm" /tmp/prewarm-data /tmp/prewarm-ws /tmp/prewarm.json /tmp/prewarm.log
du -sh "$HOME" || true
