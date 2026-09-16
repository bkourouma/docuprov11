#!/usr/bin/env bash
# Verification de la production docupro-demo. Lecture seule par defaut :
# l'instance sert de vraies donnees, le script ne doit donc ni ecrire dans le
# coffre ni couper le service sans qu'on le lui demande explicitement.
#
#   bash verify-prod.sh                 # controles non intrusifs
#   RESTART=1 bash verify-prod.sh       # + redemarrage api/worker (coupure breve)
#   DOCUPRO_VERIFY_USER=... DOCUPRO_VERIFY_PASSWORD=... bash verify-prod.sh
#
# Les identifiants ne sont JAMAIS ecrits en dur : ce fichier est versionne.
set -uo pipefail

DOMAIN="docupro-demo.allianceconsultants.net"
COMPOSE_FILE="/home/deployer/docupro-demo/infra/compose/docker-compose.prod.yml"
ENV_FILE="/home/deployer/docupro-demo.env"
RESTART="${RESTART:-0}"
TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT

echecs=0
echec() { echo "ECHEC: $*" >&2; echecs=$((echecs + 1)); }

echo "=== conteneurs docupro-demo ==="
docker ps --filter name=docupro-demo --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
for c in postgres redis api worker web; do
  etat="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "docupro-demo-${c}" 2>/dev/null || echo absent)"
  [ "${etat}" = healthy ] || echec "docupro-demo-${c} n'est pas healthy (${etat})"
done

echo
echo "=== isolation : aucun port publie hors 127.0.0.1 ==="
if docker ps --filter name=docupro-demo --format '{{.Ports}}' | grep -q '0\.0\.0\.0'; then
  echec "un conteneur docupro-demo publie un port sur 0.0.0.0"
else
  echo "ok — tout binding hote reste sur la boucle locale"
fi

echo
echo "=== voisins non touches (temoin : docupro-new) ==="
docker inspect -f '{{.Name}} {{.State.Status}} depuis {{.State.StartedAt}}' docupro-new 2>/dev/null \
  || echo "docupro-new absent de cet hote"

echo
echo "=== migrations ==="
docker compose -p docupro-demo --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" \
  run --rm --no-deps --workdir /app/packages/db api \
  node /app/node_modules/prisma/build/index.js migrate status --schema=/app/packages/db/prisma \
  2>&1 | grep -vE '^warn|prisma-config' || echec "migrate status a echoue"

echo
echo "=== integrite du coffre ==="
# Non intrusif et plus probant qu'un fichier temoin : chaque binaire attendu par
# la base doit exister ET correspondre a l'empreinte SHA-256 qu'elle a enregistree.
docker exec docupro-demo-postgres sh -c \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tA -F" " -c "SELECT file_id, hash FROM document_file WHERE hash IS NOT NULL ORDER BY file_id"' \
  2>/dev/null | grep -E '^[0-9]+ ' | LC_ALL=C sort > "${TMP}/base.txt"

docker exec docupro-demo-api sh -c 'cd /data/archives && sha256sum *.pdf 2>/dev/null' \
  | awk '{ sub(/\.pdf$/, "", $2); print $2, $1 }' | LC_ALL=C sort > "${TMP}/disque.txt"

attendus="$(wc -l < "${TMP}/base.txt")"
manquants="$(LC_ALL=C comm -23 "${TMP}/base.txt" "${TMP}/disque.txt" | wc -l)"
orphelins="$(LC_ALL=C comm -13 "${TMP}/base.txt" "${TMP}/disque.txt" | wc -l)"

echo "binaires attendus par la base : ${attendus}"
if [ "${manquants}" -eq 0 ] && [ "${attendus}" -gt 0 ]; then
  echo "ok — tous presents et conformes a leur empreinte"
else
  echec "${manquants} binaire(s) absent(s) ou divergent(s)"
  LC_ALL=C comm -23 "${TMP}/base.txt" "${TMP}/disque.txt" | head -10
fi
# Un orphelin n'est pas une anomalie bloquante (reliquat de test, version remplacee).
[ "${orphelins}" -gt 0 ] && echo "note : ${orphelins} fichier(s) sur disque sans entree en base"

echo
echo "=== cle de scellement ==="
if docker exec docupro-demo-api test -f /data/archives/.keys/sealing-ed25519.pem; then
  scelles="$(docker exec docupro-demo-postgres sh -c \
    'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "SELECT count(*) FROM document_seal"' 2>/dev/null | tr -d '[:space:]')"
  echo "ok — cle presente, ${scelles} cachet(s) en base"
else
  # Normal tant qu'aucun document n'a ete scelle ; anormal des qu'il y en a.
  scelles="$(docker exec docupro-demo-postgres sh -c \
    'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "SELECT count(*) FROM document_seal"' 2>/dev/null | tr -d '[:space:]')"
  if [ "${scelles:-0}" -gt 0 ]; then
    echec "${scelles} cachet(s) en base mais AUCUNE cle : ils sont invérifiables"
  else
    echo "pas encore de cle (aucun scellement effectue) — normal"
  fi
fi

echo
echo "=== HTTPS ==="
curl -fsSI --max-time 20 "https://${DOMAIN}" | head -3 || echec "la page d'accueil ne repond pas"
curl -fsS --max-time 20 "https://${DOMAIN}/api/health" || echec "/api/health ne repond pas"
echo

echo
echo "=== le rewrite /api atteint bien le conteneur API ==="
# Sans identifiants, on verifie quand meme la chaine nginx -> next -> api :
# un refus d'authentification prouve que Nest a repondu (un 404 signalerait que
# Next n'a pas relaye la requete).
code_refus="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 -X POST "https://${DOMAIN}/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d '{"username":"__inexistant__","password":"__invalide__"}')"
case "${code_refus}" in
  401|403) echo "ok — HTTP ${code_refus}, l'API traite l'authentification" ;;
  404)     echo "HTTP 404"; echec "le rewrite /api ne pointe pas sur l'API" ;;
  *)       echo "HTTP ${code_refus} (inattendu pour des identifiants invalides)" ;;
esac

echo
echo "=== connexion reelle ==="
if [ -n "${DOCUPRO_VERIFY_USER:-}" ] && [ -n "${DOCUPRO_VERIFY_PASSWORD:-}" ]; then
  # Le corps transite par un tube : le mot de passe n'est ni ecrit sur disque,
  # ni visible dans la ligne de commande (donc pas dans `ps`).
  code="$(python3 -c 'import json,os,sys; sys.stdout.write(json.dumps({"username": os.environ["DOCUPRO_VERIFY_USER"], "password": os.environ["DOCUPRO_VERIFY_PASSWORD"]}))' \
    | curl -sS -o "${TMP}/login.json" -w '%{http_code}' --max-time 20 -X POST "https://${DOMAIN}/api/auth/login" \
        -H 'Content-Type: application/json' --data-binary @-)"
  if [ "${code}" = 200 ] || [ "${code}" = 201 ]; then
    python3 -c 'import json;d=json.load(open("'"${TMP}"'/login.json"));print("ok — jeton recu, longueur", len(d.get("accessToken") or ""))'
  else
    echec "connexion refusee (HTTP ${code}) pour ${DOCUPRO_VERIFY_USER}"
  fi
else
  echo "ignore — definir DOCUPRO_VERIFY_USER et DOCUPRO_VERIFY_PASSWORD pour tester"
  echo "         un compte reel (aucun identifiant n'est stocke dans ce depot)."
fi

echo
echo "=== journaux : erreurs de niveau >= 50 ==="
for c in api worker; do
  n="$(docker logs "docupro-demo-${c}" 2>&1 | grep -c '"level":5[0-9]' || true)"
  echo "docupro-demo-${c} : ${n}"
  [ "${n}" -gt 0 ] && echec "${n} erreur(s) dans docupro-demo-${c}"
done

if [ "${RESTART}" = "1" ]; then
  echo
  echo "=== persistance apres redemarrage (api + worker) ==="
  avant="$(docker exec docupro-demo-api sh -c 'cd /data/archives && sha256sum *.pdf 2>/dev/null | sha256sum')"
  docker restart docupro-demo-api docupro-demo-worker >/dev/null
  for _ in $(seq 1 24); do
    etat="$(docker inspect -f '{{.State.Health.Status}}' docupro-demo-api 2>/dev/null || echo x)"
    [ "${etat}" = healthy ] && break
    sleep 5
  done
  apres="$(docker exec docupro-demo-api sh -c 'cd /data/archives && sha256sum *.pdf 2>/dev/null | sha256sum')"
  if [ "${avant}" = "${apres}" ] && [ -n "${avant}" ]; then
    echo "ok — le coffre est identique apres redemarrage"
  else
    echec "le contenu du coffre a change au redemarrage"
  fi
else
  echo
  echo "=== persistance : ignoree (RESTART=1 pour l'executer, coupure breve) ==="
fi

echo
if [ "${echecs}" -eq 0 ]; then
  echo "RESULTAT : tous les controles sont passes."
else
  echo "RESULTAT : ${echecs} controle(s) en echec."
fi
exit "$([ "${echecs}" -eq 0 ] && echo 0 || echo 1)"
