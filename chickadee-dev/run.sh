#!/bin/sh
# Chickadee add-on entrypoint.
set -e
echo "[chickadee] starting brain runtime"
exec node /app/server/index.js
