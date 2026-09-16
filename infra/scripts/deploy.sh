#!/usr/bin/env bash
# Déploiement idempotent DocuPro-V6 (projet Compose docupro-demo uniquement).
# Prérequis : /home/deployer/docupro-demo.env (mode 600), Docker Compose v2, nginx + certbot.
# N'arrête, ne reconstruit, ne prune aucun conteneur / volume hors préfixe docupro-demo.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ENV_FILE="${DOCUPRO_ENV_FILE:-/home/deployer/docupro-demo.env}"
COMPOSE_FILE="${ROOT}/infra/compose/docker-compose.prod.yml"
DOMAIN="docupro-demo.allianceconsultants.net"
SKIP_NGINX="${SKIP_NGINX:-0}"

cd "${ROOT}"

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "ERROR: missing ${ENV_FILE}" >&2
  echo "Run: python3 infra/scripts/generate-prod-env.py" >&2
  exit 1
fi
if grep -E '^(JWT_SECRET|POSTGRES_PASSWORD|DATABASE_URL|SCAN_AGENT_API_KEY)=' "${ENV_FILE}" \
  | grep -qE 'change-me-please|29122003|CHANGE_ME_GENERATE'; then
  echo "ERROR: ${ENV_FILE} still contains a placeholder or development secret" >&2
  exit 1
fi

compose() {
  docker compose -p docupro-demo --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" "$@"
}

wait_healthy() {
  local name="$1"
  local tries=0
  local status
  while (( tries < 60 )); do
    status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "${name}" 2>/dev/null || echo missing)"
    if [[ "${status}" == "healthy" ]]; then
      echo "${name}: healthy"
      return 0
    fi
    echo "${name}: waiting (${status})"
    sleep 5
    tries=$((tries + 1))
  done
  echo "ERROR: timeout waiting for ${name} (last status=${status})" >&2
  docker inspect "${name}" >&2 || true
  docker logs --tail 120 "${name}" >&2 || true
  return 1
}

snapshot_foreign_containers() {
  docker ps -a --format '{{.ID}} {{.Names}}' | awk '$2 !~ /^docupro-demo-/ { print }' | sort
}

echo "== snapshot of non-docupro-demo containers (must stay unchanged) =="
BEFORE="$(snapshot_foreign_containers)"
echo "${BEFORE}"

echo "== docker compose build (serial, to avoid RAM contention) =="
export COMPOSE_PARALLEL_LIMIT=1
compose build

echo "== up postgres + redis =="
compose up -d postgres redis
wait_healthy docupro-demo-postgres
wait_healthy docupro-demo-redis

echo "== prisma migrate deploy =="
compose run --rm --no-deps --name docupro-demo-migrate --workdir /app/packages/db api \
  node /app/node_modules/prisma/build/index.js migrate deploy --schema=/app/packages/db/prisma

echo "== prisma migrate status =="
compose run --rm --no-deps --name docupro-demo-migrate-status --workdir /app/packages/db api \
  node /app/node_modules/prisma/build/index.js migrate status --schema=/app/packages/db/prisma

echo "== seed admin if app_user is empty =="
USER_COUNT="$(
  docker exec docupro-demo-postgres \
    sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "SELECT COUNT(*) FROM app_user"' \
    | tr -d '[:space:]'
)"
echo "app_user count=${USER_COUNT}"
if [[ "${USER_COUNT}" == "0" ]]; then
  compose run --rm --no-deps --name docupro-demo-seed --workdir /app/packages/db api \
    node /app/node_modules/tsx/dist/cli.mjs prisma/seed.ts
else
  echo "seed skipped (users already present)"
fi

echo "== up full stack =="
compose up -d
wait_healthy docupro-demo-postgres
wait_healthy docupro-demo-redis
wait_healthy docupro-demo-api
wait_healthy docupro-demo-worker
wait_healthy docupro-demo-web

echo "== smoke HTTP via bind 127.0.0.1:3018 =="
curl -fsS -D - -o /tmp/docupro-demo-health-web.json http://127.0.0.1:3018/health
echo
cat /tmp/docupro-demo-health-web.json
echo
curl -fsS -D - -o /tmp/docupro-demo-health-api.json http://127.0.0.1:3018/api/health
echo
cat /tmp/docupro-demo-health-api.json
echo

if [[ "${SKIP_NGINX}" != "1" ]]; then
  echo "== nginx + TLS =="
  NGINX_HTTP="${ROOT}/infra/nginx/docupro-demo.http.conf"
  NGINX_TLS="${ROOT}/infra/nginx/docupro-demo.conf"
  if [[ -d /etc/nginx/sites-available ]]; then
    NGINX_AVAIL=/etc/nginx/sites-available/docupro-demo
    sudo cp "${NGINX_HTTP}" "${NGINX_AVAIL}"
    sudo ln -sfn "${NGINX_AVAIL}" /etc/nginx/sites-enabled/docupro-demo
  else
    NGINX_AVAIL=/etc/nginx/conf.d/docupro-demo.conf
    sudo cp "${NGINX_HTTP}" "${NGINX_AVAIL}"
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

  echo "== smoke HTTPS =="
  curl -fsSI --max-time 30 "https://${DOMAIN}"
  echo
  curl -fsS --max-time 30 "https://${DOMAIN}/health"
  echo
  curl -fsS --max-time 30 "https://${DOMAIN}/api/health"
  echo
fi

echo "== docker ps (docupro-demo only) =="
docker ps --filter name=docupro-demo --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'

echo "== worker logs (boot) =="
docker logs --tail 40 docupro-demo-worker

echo "== dangling image prune (no volumes, no running containers) =="
docker image prune -f

echo "== verify foreign containers unchanged =="
AFTER="$(snapshot_foreign_containers)"
if [[ "${BEFORE}" != "${AFTER}" ]]; then
  echo "ERROR: a container outside docupro-demo changed" >&2
  echo "--- before ---" >&2
  echo "${BEFORE}" >&2
  echo "--- after ---" >&2
  echo "${AFTER}" >&2
  exit 1
fi
echo "foreign containers unchanged"

echo "deploy ok"
