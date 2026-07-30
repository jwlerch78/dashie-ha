#!/bin/sh
# Dashie for Home Assistant add-on entrypoint.
set -e
echo "[dashie-ha] starting brain runtime"
exec node /app/server/index.js
