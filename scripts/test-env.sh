#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export PORT="${PORT:-3001}"
export APP_ORIGIN="http://127.0.0.1:$PORT"
export ADMIN_ORIGIN="http://localhost:$PORT"
export UNSUBSCRIBE_SECRET="local-test-key-not-for-production"
export RECOVERY_SENDER="info@formapoint.test"
order="$(printf '%s' 'order_test_key_only_0000000000000000' | sha256sum | cut -d' ' -f1)"
promotion="$(printf '%s' 'promotion_test_key_only_00000000000' | sha256sum | cut -d' ' -f1)"
export INTEGRATION_KEYS="[{\"hash\":\"$order\",\"address\":\"narudzba@formapoint-orders.test\",\"kind\":\"order\"},{\"hash\":\"$promotion\",\"address\":\"promocije@formapoint.test\",\"kind\":\"promotion\",\"consent\":true,\"delivery\":true}]"
export EDNEVNIK_SUPABASE_PROJECT_ID=ednevnik-test
export EDNEVNIK_SUPABASE_URL=http://127.0.0.1:3014
export EDNEVNIK_SUPABASE_AUTH_KEY=ednevnik-test-auth
export EDNEVNIK_USERNAME_RPC=webmail_login_identifier
export EDNEVNIK_USERNAME_RPC_TOKEN=ednevnik-test-resolver
export FORMAPOINT_SUPABASE_PROJECT_ID=formapoint-test
export FORMAPOINT_SUPABASE_URL=http://127.0.0.1:3015
export FORMAPOINT_USERNAME_LOGIN_URL=http://127.0.0.1:3015/functions/v1/webmail-login
export FORMAPOINT_USERNAME_LOGIN_TOKEN=formapoint-test-login
exec bash scripts/local.sh "$@"
