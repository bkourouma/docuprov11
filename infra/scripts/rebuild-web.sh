#!/usr/bin/env bash
set -euo pipefail
cd /home/deployer/docupro-demo
sed -i 's/\r$//' turbo.json infra/compose/Dockerfile.web infra/compose/docker-compose.prod.yml apps/web/next.config.mjs
docker compose -p docupro-demo --env-file /home/deployer/docupro-demo.env -f infra/compose/docker-compose.prod.yml build web
docker compose -p docupro-demo --env-file /home/deployer/docupro-demo.env -f infra/compose/docker-compose.prod.yml up -d web
for i in $(seq 1 24); do
  s="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' docupro-demo-web)"
  echo "web: ${s}"
  if [[ "${s}" == "healthy" ]]; then
    break
  fi
  sleep 5
done
echo "=== /health ==="
curl -sS http://127.0.0.1:3018/health
echo
echo "=== /api/health ==="
curl -sS -D - http://127.0.0.1:3018/api/health
echo
echo "=== rewrite destination in image ==="
docker exec docupro-demo-web sh -c 'grep -oE "docupro-demo-api|127.0.0.1:3001" /app/apps/web/.next/routes-manifest.json | sort | uniq -c'
echo "=== web logs tail ==="
docker logs --tail 15 docupro-demo-web
