#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p .quota-demo/tls
umask 077
if [[ ! -s .quota-demo/tls/key.pem ]]; then
  openssl req -x509 -newkey rsa:2048 -nodes -days 30     -subj '/CN=127.0.0.1' -addext 'subjectAltName=IP:127.0.0.1'     -keyout .quota-demo/tls/key.pem -out .quota-demo/tls/cert.pem
fi
compose=(docker compose -f compose.yaml -f compose.quota.yaml)
accounts=.quota-demo/postfix-accounts.cf
touch "$accounts" .quota-demo/dovecot-quotas.cf
hash="$(openssl passwd -6 'LocalTestMail-2026')"
for address in lena@formapoint.test info@formapoint.test ivan@skolehr.test mia@skolehr.test referada@skolehr.test petra@fzom.isvu.test referada@fzom.isvu.test narudzba@formapoint-orders.test promocije@formapoint.test postmaster@formapoint.test ucenik@skolehr.test ana@kupci.test marko@partneri.test ivana@racuni.test tomislav@partneri.test petra@partneri.test lucija@kupci.test; do
  if ! awk -F '|' -v address="$address" '$1==address{found=1} END{exit !found}' "$accounts"; then
    printf '%s|{SHA512-CRYPT}%s\n' "$address" "$hash" >> "$accounts"
  fi
  if ! awk -F ':' -v address="$address" '$1==address{found=1} END{exit !found}' .quota-demo/dovecot-quotas.cf; then
    printf '%s:15G\n' "$address" >> .quota-demo/dovecot-quotas.cf
  fi
done
"${compose[@]}" up -d database quota-mail
for ((attempt=0; attempt<30; attempt++)); do
  if timeout 2 openssl s_client -connect 127.0.0.1:3993 -verify_ip 127.0.0.1 \
       -CAfile .quota-demo/tls/cert.pem -verify_return_error -brief </dev/null >/dev/null 2>&1; then
    exit 0
  fi
  sleep 1
done
echo 'Dovecot IMAPS nije spreman na priključku 3993.' >&2
exit 1
