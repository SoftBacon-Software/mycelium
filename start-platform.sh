#!/usr/bin/env bash
# Mycelium substrate launcher — Jetson (the squad's :3002 host).
# Absolute node path so it's robust under systemd's minimal env (no nvm sourcing).
# The platform doesn't use dotenv, so export .env here.
cd "$HOME/mycelium" || exit 1
set -a; . ./.env; set +a
export DATA_DIR="$HOME/mycelium/server/data"
exec "$HOME/.nvm/versions/node/v25.9.0/bin/node" server/index.js
