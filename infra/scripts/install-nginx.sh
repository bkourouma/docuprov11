#!/usr/bin/env bash
# Installe le vhost HTTP, obtient le certificat, bascule sur la conf TLS définitive.
set -euo pipefail
ROOT="${1:-/home/deployer/docupro-demo}"
DOMAIN="docupro-demo.allianceconsultants.net"
NGINX_HTTP="${ROOT}/infra/nginx/docupro-demo.http.conf"
NGINX_TLS="${ROOT}/infra/nginx/docupro-demo.conf"

sed -i 's/\r$//' "${NGINX_HTTP}" "${NGINX_TLS}"

if [[ -d /etc/nginx/sites-available ]]; then
  sudo cp "${NGINX_HTTP}" /etc/nginx/sites-available/docupro-demo
  sudo ln -sfn /etc/nginx/sites-available/docupro-demo /etc/nginx/sites-enabled/docupro-demo
else
  sudo cp "${NGINX_HTTP}" /etc/nginx/conf.d/docupro-demo.conf
fi
sudo nginx -t
sudo systemctl reload nginx

if sudo test -f "/etc/letsencrypt/live/${DOMAIN}/fullchain.pem"; then
  echo "certificate already present for ${DOMAIN}"
else
  sudo certbot --nginx -d "${DOMAIN}" --agree-tos -m admin@allianceconsultants.net --no-eff-email --redirect
fi

if [[ -d /etc/nginx/sites-available ]]; then
  sudo cp "${NGINX_TLS}" /etc/nginx/sites-available/docupro-demo
else
  sudo cp "${NGINX_TLS}" /etc/nginx/conf.d/docupro-demo.conf
fi
sudo nginx -t
sudo systemctl reload nginx

echo "=== curl -I https://${DOMAIN} ==="
curl -fsSI --max-time 30 "https://${DOMAIN}"
echo
echo "=== https /health ==="
curl -fsS --max-time 30 "https://${DOMAIN}/health"
echo
echo "=== https /api/health ==="
curl -fsS --max-time 30 "https://${DOMAIN}/api/health"
echo
