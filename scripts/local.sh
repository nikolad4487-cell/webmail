#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export DATABASE_URL=postgres://webmail:local-demo-only@127.0.0.1:55432/webmail
export DEMO_MODE=1
export PORT="${PORT:-3000}"
exec "$@"
