#!/usr/bin/env bash
# Smoke-tests the jev-trader backend (src/server.ts), assumed already
# running on BACKEND_URL. Checks the three documented endpoints.
set -euo pipefail

BACKEND_URL="${BACKEND_URL:-http://localhost:3000}"

echo "== GET / =="
curl -sf "$BACKEND_URL/" | head -c 400
echo
echo

echo "== GET /history =="
curl -sf "$BACKEND_URL/history" | head -c 300
echo
echo

echo "== GET /events (SSE, 3s) =="
curl -sfN --max-time 3 "$BACKEND_URL/events" | head -c 400 || true
echo
echo "smoke OK"
