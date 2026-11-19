#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export DATABASE_URL=postgres://webmail:local-demo-only@127.0.0.1:55432/webmail
# The server reads its database through the Composer service declaration, which
# hands the raw Postgres URL over as COMPOSER_DB_URL.
export COMPOSER_DB_URL="$DATABASE_URL"
export DEMO_MODE=1
export PORT="${PORT:-3000}"
exec "$@"
