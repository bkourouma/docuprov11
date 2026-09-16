#!/usr/bin/env bash
set -euo pipefail
echo "=== docker ps docupro-demo ==="
docker ps --filter name=docupro-demo --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
echo
echo "=== docupro-new still running ==="
docker ps --filter name=^docupro-new$ --format '{{.Names}} {{.Status}} {{.Ports}}'
echo
echo "=== migrate status ==="
docker compose -p docupro-demo --env-file /home/deployer/docupro-demo.env -f /home/deployer/docupro-demo/infra/compose/docker-compose.prod.yml \
  run --rm --no-deps --name docupro-demo-migrate-status --workdir /app/packages/db api \
  node /app/node_modules/prisma/build/index.js migrate status --schema=/app/packages/db/prisma
echo
echo "=== worker logs ==="
docker logs --tail 50 docupro-demo-worker
echo
echo "=== volume persist marker ==="
docker exec docupro-demo-api sh -c 'echo persist-ok > /data/archives/.persist-probe && ls -la /data/archives/.persist-probe /data/archives/.keys 2>/dev/null || true'
echo "restart api+worker (not postgres)"
docker restart docupro-demo-api docupro-demo-worker
sleep 8
docker exec docupro-demo-api cat /data/archives/.persist-probe
echo
echo "=== curl HTTPS ==="
curl -fsSI --max-time 20 https://docupro-demo.allianceconsultants.net | head -20
echo
curl -fsS --max-time 20 https://docupro-demo.allianceconsultants.net/api/health
echo
echo "=== login via rewrite ==="
LOGIN_CODE="$(curl -sS -o /tmp/docupro-demo-login.json -w '%{http_code}' --max-time 20 -X POST https://docupro-demo.allianceconsultants.net/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"admin1234"}')"
echo "HTTP ${LOGIN_CODE}"
python3 -c 'import json; d=json.load(open("/tmp/docupro-demo-login.json")); print("accessToken present:", bool(d.get("accessToken"))); print("keys:", sorted(d.keys()))'
rm -f /tmp/docupro-demo-login.json
echo
echo "=== foreign container names (sample docupro-new) ==="
docker inspect -f '{{.State.Status}} {{.Name}} {{.Id}}' docupro-new
