#!/usr/bin/env bash
set -euo pipefail
echo "=== api direct ==="
docker exec docupro-demo-api node -e 'fetch("http://127.0.0.1:3001/api/health").then(async r=>{console.log(r.status); console.log(await r.text())}).catch(e=>{console.error(e); process.exit(1)})'
echo "=== web -> api hostname ==="
docker exec docupro-demo-web node -e 'fetch("http://docupro-demo-api:3001/api/health").then(async r=>{console.log(r.status); console.log(await r.text())}).catch(e=>{console.error(e); process.exit(1)})'
echo "=== env ==="
docker exec docupro-demo-web printenv API_INTERNAL_URL HOSTNAME PORT NODE_ENV
echo "=== web /api/health ==="
docker exec docupro-demo-web node -e 'fetch("http://127.0.0.1:5000/api/health").then(async r=>{console.log("status", r.status); console.log(await r.text())}).catch(e=>{console.error(e); process.exit(1)})'
echo "=== curl host 3018 ==="
curl -sv http://127.0.0.1:3018/api/health || true
echo
echo "=== web logs ==="
docker logs --tail 80 docupro-demo-web
echo "=== api logs ==="
docker logs --tail 40 docupro-demo-api
