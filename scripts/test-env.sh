#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export PORT="${PORT:-3001}"
export APP_ORIGIN="http://127.0.0.1:$PORT"
export UNSUBSCRIBE_SECRET="local-test-key-not-for-production"
export RECOVERY_SENDER="info@formapoint.test"
order="$(printf '%s' 'order_test_key_only_0000000000000000' | sha256sum | cut -d' ' -f1)"
promotion="$(printf '%s' 'promotion_test_key_only_00000000000' | sha256sum | cut -d' ' -f1)"
export INTEGRATION_KEYS="[{\"hash\":\"$order\",\"address\":\"narudzba@formapoint-orders.test\",\"kind\":\"order\"},{\"hash\":\"$promotion\",\"address\":\"promocije@formapoint.test\",\"kind\":\"promotion\",\"consent\":true,\"delivery\":true}]"
exec bash scripts/local.sh "$@"
