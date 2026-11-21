# Déploiement de la GED et de l'IA

Ce guide décrit la mise en production des lots GED et IA (socle IA, connecteurs, recherche sémantique, gouvernance, rédaction assistée, éditeur collaboratif) sur la pile `docupro-demo`. Il décrit l'état du code et des fichiers d'infrastructure de la copie de travail à la date du 2026-11-21, modifications non commitées comprises (Dockerfiles, `docker-compose.prod.yml`, `docs/ged-ia.md`, `apps/worker/src/index.ts`).

Les documents de lot restent la référence pour le comportement détaillé. Les contradictions relevées entre ces documents sont listées en section 7.

Documents liés : `docs/ged-ia.md`, `docs/ged-connecteurs.md`, `docs/ged-recherche.md`, `docs/ged-gouvernance.md`, `docs/ged-redaction.md`, `docs/ged-espaces.md`, `docs/ged-editeur.md`, `docs/operations.md`. Les documents `docs/ged-espaces.md` (espaces, membres, publication, versions) et `docs/ged-editeur.md` (éditeur collaboratif sur `/api/collab`, codes de fermeture, persistance en versions) sont livrés avec ce lot et font référence pour le détail des espaces et de l'éditeur.

Conventions : les valeurs entre chevrons (`<...>`) sont des espaces réservés. Ce document ne contient aucun secret. Les valeurs réelles se saisissent dans le fichier d'environnement de production, jamais dans le dépôt, un ticket ou un document partagé.

---

## Points bloquants avant la mise en production

1. **Variables absentes du fichier d'environnement de production.** Le compose ne transmet explicitement aucune variable `GED_*` ni `COLLAB_*`. Les services `api` et `worker` lisent `/home/deployer/docupro-demo.env` (`env_file`). Le gabarit `infra/.env.example`, dont se sert `infra/scripts/generate-prod-env.py`, ne contient aucune de ces variables. Il faut donc les ajouter à la main au fichier de production (section 2).
2. **WebSocket de l'éditeur collaboratif (`/api/collab`).** Le chemin prévu passe par nginx puis par le conteneur `web` (Next.js), alors que le serveur WebSocket tourne dans l'API, qui n'est publiée sur aucune interface de l'hôte. À notre connaissance, Next.js ne relaie pas l'upgrade WebSocket des rewrites. Tant que la recette (section 5) n'a pas confirmé le contraire, la collaboration temps réel doit être considérée comme non fonctionnelle en production (section 3).
3. **`NEXT_PUBLIC_COLLAB_WS_URL` sans effet en l'état.** C'est une variable de build du web. Elle n'est déclarée ni en `ARG` dans `Dockerfile.web`, ni en build arg dans le compose.
4. **Modèle local et `localhost`.** Le repli `http://localhost:11434/v1` du worker vise le conteneur lui-même, pas la machine hôte. Un endpoint joignable depuis le conteneur doit être fourni (section 2).
5. **Dossier surveillé.** Le connecteur « dossier surveillé » lit le système de fichiers du conteneur `worker`. Aucun volume source n'est monté dans le compose de production.
6. **Pas de retour arrière d'images.** `deploy.sh` construit des images taguées `:latest`, qui écrasent la version précédente. Une migration n'a pas de version de retour (section 4.4).
7. **Ajustements sécurité à décider.** `CORS_ORIGIN` restreint aussi l'origine acceptée par le WebSocket, et `GED_WHATSAPP_TRUST_PROXY` / `COLLAB_TRUST_PROXY` dépendent du nombre réel de proxys traversés (sections 2.5 et 7).

---

## 1. Prérequis pgvector

### 1.1 Image PostgreSQL

Dans `infra/compose/docker-compose.prod.yml`, le service `postgres` utilise désormais `pgvector/pgvector:pg16` au lieu de `postgres:16`. Ce changement est non commité dans la copie de travail.

- Même version majeure (16) : le volume `docupro-demo-postgres-data` reste lisible sans `pg_upgrade`. Selon l'indication de lot, la nouvelle image repose sur la même base Debian que l'ancienne ; à confirmer avec la commande de la section 1.5.
- Tirer l'image avant le déploiement : `docker pull pgvector/pgvector:pg16`. `compose up` ne la tire que si elle est absente, ce qui échoue si l'hôte ne joint pas le registre.
- Changer d'image recrée le conteneur `docupro-demo-postgres` (le volume est conservé). Les connexions de l'API et du worker sont coupées le temps du redémarrage ; Prisma les rétablit, mais il faut prévoir une brève interruption.

### 1.2 Ce que fait la migration `20261120120000_add_ged_ia_foundations`

Fichier : `packages/db/prisma/migrations/20261120120000_add_ged_ia_foundations/migration.sql`.

- Première instruction : `CREATE EXTENSION IF NOT EXISTS vector;`. Elle précède la table `ged_document_chunk`, qui porte la colonne `embedding vector(1024)`.
- Crée 11 tables : `ged_ai_setting`, `ged_ai_masking_rule`, `ged_ai_decision`, `ged_source_connector`, `ged_source_sync_run`, `ged_source_item`, `ged_document_chunk`, `ged_space`, `ged_space_member`, `ged_space_document`, `ged_version_info`.
- Ajoute des clés étrangères vers `document`, `document_version`, `app_user_group`, `role` et `dossier`.
- Ajoute les contraintes `CHECK ck_*`, les index uniques partiels (`ux_ged_chunk_document`, `ux_ged_chunk_source_item`, `ux_ged_space_member_user`, `ux_ged_space_member_role`) et l'index HNSW `ix_ged_chunk_embedding_hnsw` (distance cosinus, `m = 16`, `ef_construction = 64`).
- Insère une seule ligne de données : `ged_ai_setting` avec `ged_ai_setting_id = 1` et `mode = 0`, c'est-à-dire IA désactivée.
- Ne modifie aucune table existante (l'en-tête de la migration la décrit comme additive). Il n'existe pas de migration inverse : le retour arrière passe par la restauration de la sauvegarde (section 1.4).
- Les embeddings sont fixés à 1024 composantes. Un autre modèle de dimension différente exige une nouvelle migration (`docs/ged-ia.md` §10, point 5).

### 1.3 Droits requis pour `CREATE EXTENSION`

- `CREATE EXTENSION vector` exige un superutilisateur : pgvector n'est pas une extension « trusted » par défaut.
- `infra/scripts/deploy.sh` lance `prisma migrate deploy` dans un conteneur `api` éphémère, avec le `DATABASE_URL` du fichier d'environnement. Le script ne nomme aucun utilisateur : c'est `DATABASE_URL` qui le fixe.
- Le gabarit de `generate-prod-env.py` construit `DATABASE_URL` avec l'utilisateur `docupro`. L'image PostgreSQL crée `POSTGRES_USER` (valeur du gabarit : `docupro`) comme superutilisateur.
- Conséquence : la migration réussit si `DATABASE_URL` utilise le même utilisateur que `POSTGRES_USER`, et que cet utilisateur reste superutilisateur. Ce guide ne modifie pas `deploy.sh`.

Vérification (affiche `t`) :

```
docker exec docupro-demo-postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "SELECT rolsuper FROM pg_roles WHERE rolname = current_user"'
```

### 1.4 Sauvegarde avant migration

`deploy.sh` ne fait aucune sauvegarde. Avant tout déploiement de ces lots :

```
docker exec docupro-demo-postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > <dossier-de-sauvegarde>/docupro-demo-avant-ged-<AAAAMMJJ>.dump
docker exec -i docupro-demo-postgres pg_restore --list < <dossier-de-sauvegarde>/docupro-demo-avant-ged-<AAAAMMJJ>.dump > /dev/null && echo "dump lisible"
```

- Sauvegarder aussi le volume `docupro-demo-archives-data`. Il contient les binaires (absents du dump) et la clé de scellement `<ARCHIVES_PATH>/.keys/sealing-ed25519.pem`. Le `.env.example` indique « À SAUVEGARDER » : sans cette clé, les cachets déjà apposés deviennent invérifiables. `verify-prod.sh` contrôle sa présence.
- Sauvegarder le volume `docupro-demo-redis-data` si des jobs peuvent être en attente. Redis tourne avec `--appendonly yes`.
- Conserver l'image précédente (section 4.4).

### 1.5 Collation et variante d'image

Avant migration, noter la variante du système de la base :

```
docker exec docupro-demo-postgres sh -c 'grep PRETTY_NAME /etc/os-release'
```

Si le volume a été initialisé avec une variante Alpine puis reprise en Debian, les collations libc diffèrent et un `REINDEX` de la base est recommandé. Le faire en fenêtre de maintenance, après sauvegarde (il verrouille les index) :

```
docker exec docupro-demo-postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "REINDEX DATABASE \"$POSTGRES_DB\""'
```

Si la base n'a jamais servi sous Alpine, ce `REINDEX` n'est pas nécessaire.

### 1.6 Vérifications après migration

- Extension présente : `docker exec -it docupro-demo-postgres psql -U docupro -d DocuPro`, puis `\dx`. La ligne `vector` doit apparaître.
- Version : `SELECT extversion FROM pg_extension WHERE extname = 'vector';`. La relecture itérative HNSW (`hnsw.iterative_scan = relaxed_order`) n'est appliquée que si le réglage existe, c'est-à-dire pgvector 0.8 ou plus (`docs/ged-recherche.md` §4). Sous 0.8, la migration elle-même prévient que le filtre de droits peut appauvrir les résultats.
- Statut Prisma : `prisma migrate status` ne doit signaler aucune migration en attente (`deploy.sh` l'affiche déjà).

---

## 2. Variables d'environnement

### 2.1 Où les renseigner

- Fichier : `/home/deployer/docupro-demo.env` (mode 600), lu par `env_file` des services `postgres`, `api` et `worker`.
- Le service `web` n'a pas d'`env_file`. Il ne voit aucune des variables de ce tableau à l'exécution. Le seul paramètre de build qu'il reçoit est `API_INTERNAL_URL`.
- Le compose ne fixe explicitement que : `api` (`NODE_ENV`, `PORT`, `ARCHIVES_PATH`), `worker` (`NODE_ENV`, `ARCHIVES_PATH`, `TESSERACT_DATA_PATH=/opt/tessdata`), `web` (`NODE_ENV`, `HOSTNAME`, `PORT`, `API_INTERNAL_URL`). Une entrée de `environment:` prime sur la même clé de `env_file`.
- Une variable ajoutée au fichier n'est prise en compte qu'à la recréation du conteneur : `docker compose -p docupro-demo --env-file /home/deployer/docupro-demo.env -f infra/compose/docker-compose.prod.yml up -d api worker`. Un `docker restart` ne relit pas l'environnement.
- Aucune variable GED n'est validée au démarrage, sauf celles des schémas zod (voir la colonne « Obligatoire ? » de la section 2.2). Une faute de frappe sur une autre variable n'apparaît qu'au premier usage (`docs/ged-connecteurs.md` §11.2, point 33).
- Une valeur vide vaut « absente » pour les variables validées par zod (`emptyAsAbsent`) et, en pratique, pour la plupart des autres (`docs/ged-ia.md` §3.4).

### 2.2 Variables nouvelles ou à régler

Dans la colonne « Obligatoire ? », la mention « Démarrage » signale une valeur qui empêche l'API ou le worker de démarrer (validation zod).

| Variable | Composant | Rôle | Obligatoire ? | Défaut dans le code |
|---|---|---|---|---|
| `GED_CONNECTOR_KEY` | API, worker | Clé active de chiffrement des identifiants des connecteurs : 32 octets en base64 (`openssl rand -base64 32`). Dérive aussi la clé de signature des `state` OAuth. | Oui dès qu'un connecteur ou OAuth est utilisé (API : 503 ; worker : passe en erreur). Non pour le démarrage. Démarrage : non vérifiée. | Aucun |
| `GED_CONNECTOR_KEY_ID` | API, worker | Identifiant de la clé active, stocké avec chaque ligne chiffrée. 1 à 50 caractères : lettres, chiffres, `_`, `-`. | Non | `k1` |
| `GED_CONNECTOR_KEY_PREVIOUS` | API, worker | Anciennes clés (`id:base64,id:base64`), en déchiffrement seulement, pendant une rotation. | Non | Vide |
| `GED_CONNECTOR_SECRET_<NOM>` | API, worker | Objet JSON d'identifiants désigné par `credentials_ref`. Seul ce préfixe est accepté ; `<NOM>` suit `[A-Z0-9][A-Z0-9_]{0,59}`. | Non | Absente |
| `GED_CONNECTOR_FS_ROOTS` | API, worker | Racines autorisées du dossier surveillé, séparées par le séparateur de chemins du système (`:` sous Linux, `;` sous Windows). Chemins dans le conteneur. | Oui pour le dossier surveillé | Vide : aucun dossier accepté |
| `GED_CONNECTOR_ALLOWED_INTERNAL_HOSTS` | API, worker | Liste blanche SSRF d'exploitant : noms exacts, adresses ou CIDR, séparés par des virgules. Lue directement dans `process.env`. Préfixes plus larges que `/8` (IPv4) ou `/16` (IPv6) ignorés. | Non | Vide : aucun hôte interne accepté |
| `GED_GOOGLE_CLIENT_ID` | API, worker | Identifiant client OAuth Google (type « application web »). | Oui pour Google Drive | Aucun (`OAuthConfigError` qui cite le nom de la variable) |
| `GED_GOOGLE_CLIENT_SECRET` | API, worker | Secret client Google. Jamais journalisé, jamais dans une URL. | Oui pour Google Drive | Aucun |
| `GED_MS_CLIENT_ID` | API, worker | Identifiant d'application Microsoft Entra (OneDrive, SharePoint, Outlook). | Oui pour Microsoft | Aucun |
| `GED_MS_CLIENT_SECRET` | API, worker | Secret client Microsoft. Sa valeur n'est affichée qu'à la création, et il expire : noter l'échéance. | Oui pour Microsoft | Aucun |
| `GED_MS_TENANT` | API, worker | Locataire : GUID, nom de domaine, ou `common` / `organizations` / `consumers` (ces alias ne sont pas testés). Entre dans le chemin des URL. | Oui pour Microsoft | Aucun |
| `GED_OAUTH_REDIRECT_URIS` | API | Liste blanche exacte des URI de retour, séparées par des virgules. https obligatoire, sauf `http://localhost` et `http://127.0.0.1`. | Oui pour OAuth. Vide : démarrage d'autorisation refusé (409). | Vide |
| `GED_WHATSAPP_TRUST_PROXY` | API | `1` : `X-Forwarded-For` est lu pour l'adresse client, un seul proxy de confiance. Toute autre valeur : ignorée. | Recommandé derrière un proxy (voir section 7.7) | Vide (désactivé) |
| `GED_WHATSAPP_REPLAY_WINDOW_SECONDS` | API | Fenêtre anti-rejeu du webhook, de 60 à 604 800 secondes. Hors plage : valeur par défaut. | Non | `3600` |
| `GED_WHATSAPP_IP_RATE_LIMIT` | API | Requêtes par minute et par IP sur le webhook, de 1 à 10 000. | Non | `300` |
| `GED_WHATSAPP_SENDER_RATE_LIMIT` | API | Messages par 10 minutes et par expéditeur, de 1 à 10 000. | Non | `60` |
| `GED_AI_API_KEY` | API, worker | Clé de repli quand `api_key_ref` est vide ou désigne une variable vide. | Non | Vide |
| `GED_AI_<NOM>` | API, worker | Variable nommée par `ged_ai_setting.api_key_ref`. Nom accepté : `GED_AI_[A-Z0-9][A-Z0-9_]{0,59}`. Lue seulement si une référence la désigne. | Non | Non définie |
| `GED_AI_LOCAL_ENDPOINT` | API, worker | Endpoint du mode local (serveur compatible OpenAI, par exemple Ollama) quand la base n'en porte pas. Doit être une URL valide. | Non, mais à renseigner en pratique (voir section 2.4). Démarrage : une valeur non-URL empêche le démarrage. | API : aucun ; worker : `http://localhost:11434/v1` |
| `OPENAI_API_KEY` | API, worker | Clé du cloud OpenAI. Lue seulement en mode cloud, fournisseur `openai`, hôte `api.openai.com` en https. Ignorée ailleurs, erreur si référencée hors de ce cas. | Non | Absente |
| `OPENAI_MODEL` | API | Déclarée avec un défaut, mais aucun code ne la lit : le modèle vient de `ged_ai_setting.model`. Ne pas s'appuyer dessus. | Non (sans effet) | `gpt-5.6-terra` |
| `COLLAB_TRUST_PROXY` | API | Nombre de proxys de confiance devant l'API pour lire `X-Forwarded-For` (0 à 10). Valeur invalide : avertissement et 0. | Non | `0` |
| `NEXT_PUBLIC_COLLAB_WS_URL` | web, **build** | URL WebSocket de la collaboration, inlinée au build. Vide : dérivée de la page (`wss://<hôte>/api/collab`). | Non. Sans effet tant que l'image n'est pas construite avec ce build arg (section 3.4). | Dérivée de la page |

Variables existantes dont l'effet change avec ces lots : voir section 2.5.

Note : `docs/ged-connecteurs.md` §12.2 (étape 5) demande de renseigner le worker « une fois le point 34 corrigé ». Or le point 34 indique que la correction est faite : les variables OAuth doivent être renseignées pour l'API et pour le worker.

### 2.3 Noms qui ressemblent à des variables mais n'en sont pas

Ces noms apparaissent dans le code sans être lus dans l'environnement :

- `GED_EMBEDDING_DIMENSION` : constante `1024` de `packages/types/src/ged.ts`. Non configurable.
- `GED_AI_DEFAULT_CLOUD_PROVIDER`, `GED_AI_DEFAULT_CLOUD_ENDPOINT`, `GED_AI_DEFAULT_CLOUD_MODEL`, `GED_AI_DEFAULT_LOCAL_EMBEDDING_MODEL` : valeurs par défaut du contrat partagé.
- `GED_AI_FALLBACK_LOCAL_ENDPOINT` : constante du worker (`http://localhost:11434/v1`), utilisée lorsque ni la base ni `GED_AI_LOCAL_ENDPOINT` ne donnent d'endpoint.
- `GED_*_QUEUE`, `GED_*_JOB`, `*_LABELS`, `*_REGEX`, `GED_CONNECTOR_LIMITS`, `GED_CONNECTOR_ALLOWED_EXTENSIONS`, `GED_DRAFT_*`, `GED_QA_*`, `GED_SEMANTIC_*`, `GED_GOVERNANCE_*` : constantes.
- `GED_COLLAB_WS_PATH` et `COLLAB_WS_PATH` : chemin constant `/api/collab`. `GED_COLLAB_STATE_EXTENSION` (`.ydoc`) et `GED_COLLAB_SNAPSHOT_EXTENSION` (`.html`) : constantes de contrat.
- `COLLAB_MIN_WRITE_LEVEL` (3), `COLLAB_MAX_DOCUMENT_ID` : constantes.
- `COLLAB_SERVER_OPTIONS`, `COLLAB_PERSISTENCE`, `GED_OAUTH_STATE_STORE`, `GED_CONNECTOR_REGISTRY`, `GED_CONNECTOR_QUEUE_TOKEN`, `GED_WHATSAPP_RUNTIME`, `GED_OAUTH_RUNTIME`, `GED_CONNECTORS_RUNTIME` : jetons d'injection NestJS. Le serveur collaboratif ne lit aucune variable pour ses options par défaut (`collab-server.options.ts`).

### 2.4 Ce que le compose de production ne fournit pas (non modifié ici)

À décider avant déploiement, selon les fonctions retenues :

- **Modèle local sur la machine hôte.** Si Ollama tourne sur l'hôte, le conteneur ne peut pas joindre `localhost`. Il faut une adresse joignable depuis le conteneur, par exemple `extra_hosts: ["host.docker.internal:host-gateway"]` sur `api` et `worker`, puis `GED_AI_LOCAL_ENDPOINT=http://host.docker.internal:11434/v1` (ou l'endpoint saisi en base). Par défaut Ollama écoute sur `127.0.0.1` : il faut le configurer pour écouter sur l'interface joignable par la passerelle Docker, sinon la connexion est refusée. À vérifier en recette.
- **Dossier surveillé.** Montage d'un dossier source en lecture seule dans le service `worker`, avec un chemin de conteneur reporté dans `GED_CONNECTOR_FS_ROOTS`. Ce dossier ne doit ni contenir `ARCHIVES_PATH` (`/data/archives`), ni être un de ses parents ou descendants (`packages/connectors/src/connectors/filesystem.ts`).
- **API publiée sur le loopback**, si la route WebSocket directe est retenue (section 3, option A) : `ports: ["127.0.0.1:<port-libre>:3001"]` sur le service `api`. Le contrôle de `verify-prod.sh` (aucun binding hors `127.0.0.1`) reste satisfait. Ports déjà publiés par ce projet : `127.0.0.1:3018` (web) et `127.0.0.1:5435` (PostgreSQL). Vérifier qu'aucun autre projet de l'hôte n'utilise le port choisi.
- **Build arg `NEXT_PUBLIC_COLLAB_WS_URL`** pour le service `web`, avec un `ARG NEXT_PUBLIC_COLLAB_WS_URL` correspondant dans `infra/compose/Dockerfile.web`, si une URL WebSocket dédiée est retenue (section 3, option B). Un simple ajout dans `env_file` n'a aucun effet sur le bundle.

### 2.5 Variables existantes dont la portée change

- **`CORS_ORIGIN`** (API) : utilisé aussi par le serveur WebSocket. Si la valeur est vide, toute origine est acceptée à la connexion WebSocket (le jeton reste exigé). Si elle est renseignée, l'en-tête `Origin` doit correspondre exactement. Valeur recommandée : `https://docupro-demo.allianceconsultants.net`, sans barre finale. Le gabarit prévoit la clé ; sa valeur dans le fichier de production est à vérifier (non lue pour ce guide).
- **`TESSERACT_DATA_PATH`** : la disponibilité de l'extraction des courriers côté API est « vide, ou dossier existant » (`docs/ged-ia.md` §9). Le compose ne fixe `/opt/tessdata` que pour le worker, qui l'embarque. L'image API ne contient pas ce dossier. Si le fichier partagé fixe `TESSERACT_DATA_PATH=/opt/tessdata`, l'API annonce l'extraction indisponible. Garder la variable vide dans le fichier partagé.
- **`ARCHIVES_PATH`** : fixé par le compose à `/data/archives` pour `api` et `worker`.
- **`REDIS_URL`** : lue par `api` et `worker` depuis le fichier. Le gabarit donne `redis://docupro-demo-redis:6379` (forme attendue ; valeur non relue).
- **`API_INTERNAL_URL`** : le web en a besoin au build (rewrite `/api`) et au démarrage. Valeur du compose : `http://docupro-demo-api:3001`.

### 2.6 Protection des valeurs

- `.dockerignore` exclut `.env` et `.env.*` (seul `.env.example` reste) : aucune valeur réelle n'entre dans les images.
- Le fichier `/home/deployer/docupro-demo.env` doit rester en mode 600. `deploy.sh` refuse de démarrer s'il contient encore un secret de développement ou un placeholder pour `JWT_SECRET`, `POSTGRES_PASSWORD`, `DATABASE_URL` ou `SCAN_AGENT_API_KEY`. Il ne contrôle pas les variables GED : ce contrôle reste manuel.

---

## 3. Proxy WebSocket `/api/collab`

### 3.1 État actuel de la configuration nginx

Le fichier `infra/nginx/docupro-demo.conf` (vhost TLS, installé par `deploy.sh` après le certificat) contient déjà un bloc `location /api/collab`, placé après le commentaire « Collaboration temps réel ». Il n'y a donc pas de bloc à ajouter. Ce bloc :

- pointe vers l'upstream `docupro_demo_web` (`127.0.0.1:3018`, le conteneur Next.js) ;
- passe `proxy_http_version 1.1`, `Upgrade $http_upgrade` et `Connection "upgrade"` ;
- fixe `proxy_read_timeout 3600s` et `proxy_send_timeout 3600s`, avec `proxy_buffering off` ;
- transmet `Host`, `X-Real-IP`, `X-Forwarded-For`, `X-Forwarded-Proto` et `X-Forwarded-Host`.

Le vhost HTTP de bootstrap (`docupro-demo.http.conf`) n'a pas de bloc WebSocket : c'est normal, il ne sert qu'au certificat.

### 3.2 Comportement par défaut du web

- `apps/web/app/lib/editeur.ts`, fonction `deriveWsUrl` : si `NEXT_PUBLIC_COLLAB_WS_URL` est vide, l'URL est `ws://` ou `wss://` selon le protocole de la page, suivi de l'hôte de la page et du chemin `wsPath` renvoyé par la session. Le chemin vient du serveur (`GED_COLLAB_WS_PATH`, soit `/api/collab`), jamais d'une constante côté web.
- En production, le navigateur ouvre donc `wss://docupro-demo.allianceconsultants.net/api/collab`, sur le port 443, puis nginx.
- `apps/web/app/components/editeur/EditorShell.tsx` lit `process.env.NEXT_PUBLIC_COLLAB_WS_URL` au moment du build. Le jeton n'est jamais dans l'URL : il voyage dans le protocole.

### 3.3 Le point de rupture

- Nginx envoie cette requête au conteneur web (`127.0.0.1:3018`), pas à l'API.
- Le serveur WebSocket est attaché à l'écouteur HTTP de l'API (`collab-server.service.ts`, événement `upgrade` sur `/api/collab`). Il n'existe que sur le port 3001 du conteneur API, lequel n'est publié nulle part.
- Les rewrites de Next.js (`apps/web/next.config.mjs`, règle `/api/:path*`) relaient les requêtes HTTP vers l'API. À notre connaissance, ils ne relaient pas les upgrades WebSocket.
- Conséquence attendue : la poignée de main WebSocket échoue (réponse du serveur Next, non `101 Switching Protocols`), et l'éditeur ne se connecte pas. Ce comportement n'a pas été reproduit dans ce dépôt : c'est à confirmer par la recette (section 5, « Éditeur collaboratif »).

### 3.4 Deux options pour corriger

**Option A (recommandée) : route nginx directe vers l'API.**

1. Publier l'API sur le loopback dans le compose (section 2.4).
2. Dans le vhost TLS, remplacer le `proxy_pass` du bloc `/api/collab` par l'adresse publiée. Le reste du bloc est déjà correct :

```
location /api/collab {
    proxy_pass http://127.0.0.1:<port-libre>;   # API publiée sur le loopback
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
    proxy_buffering off;
}
```

3. Régler `COLLAB_TRUST_PROXY=1` : nginx est alors le seul proxy de confiance et ajoute l'adresse client en fin de `X-Forwarded-For`.

**Option B : `NEXT_PUBLIC_COLLAB_WS_URL` vers une URL directe.** Elle exige tout de même une route publique vers l'API (donc la même publication de port et le même bloc nginx), plus un build arg et un `ARG` dans `Dockerfile.web`, puis un rebuild du web. Elle n'apporte rien de plus que l'option A et coûte davantage.

Avant de retenir l'une ou l'autre, vérifier en recette que la requête atteint bien l'API (section 5).

### 3.5 Limites liées au proxy

Voir section 7.7, « Proxys et adresses client ».

---

## 4. Ordre de mise à jour

### 4.1 Ce que fait `infra/scripts/deploy.sh`

Le script est idempotent et ne fait rien en dehors du projet `docupro-demo`. Son déroulé réel est :

1. Relevé des conteneurs hors `docupro-demo-*`, à comparer en fin de script.
2. `compose build` en série (`COMPOSE_PARALLEL_LIMIT=1`).
3. `compose up -d postgres redis`, puis attente de l'état `healthy`. Le conteneur PostgreSQL est recréé si l'image a changé (section 1.1).
4. `prisma migrate deploy` dans un conteneur `api` éphémère, construit à l'étape 2 : c'est donc le nouveau code qui applique la migration, pendant que l'ancienne API et l'ancien worker tournent encore. Puis `migrate status`.
5. Seed initial seulement si la table `app_user` est vide (premier déploiement).
6. `compose up -d` (pile complète) : `api`, `worker` et `web` sont recréés s'ils ont changé. `web` attend `api` en `healthy`. Puis attente de tous les `healthy`.
7. Contrôles HTTP sur `127.0.0.1:3018` (`/health` et `/api/health`), puis installation du vhost HTTP, certificat, vhost TLS, contrôles HTTPS.
8. `docker ps`, journal du worker, `docker image prune -f` (images orphelines seulement), contrôle des conteneurs étrangers, « deploy ok ».

Ce que `deploy.sh` ne fait pas : il ne sauvegarde rien, il ne réordonne pas API, worker et web, et il ne vérifie ni pgvector, ni les files, ni le WebSocket.

### 4.2 Ordre recommandé et raisons

**Sauvegarder → migrer → API → worker → web.**

- **Sauvegarder d'abord.** Il n'existe pas de migration inverse, et l'on ne peut pas revenir en arrière sur les données saisies entre-temps.
- **Migrer avant le nouveau code.** La migration est additive (section 1.2) : l'ancien code continue de fonctionner sur le nouveau schéma, et le nouveau code trouve ses tables en place dès son démarrage. C'est ce que fait déjà `deploy.sh` : la migration passe avant `compose up -d`.
- **API avant worker.** Le code ne montre pas de dépendance stricte entre les deux. L'API produit les jobs, le worker les consomme. Déployer l'API d'abord limite la fenêtre pendant laquelle des jobs d'un type nouveau attendent sans consommateur. Les files sont persistantes (Redis en AOF) : un job en attente n'est pas perdu.
- **Web en dernier.** Le web sert l'interface et relaie `/api` vers l'API. Un web nouveau devant une API ancienne donnerait des 404 sur les routes nouvelles. Une API nouvelle devant un web ancien ne casse pas les écrans existants. Le compose impose d'ailleurs `web` après `api` en `healthy`.

Dans la pratique, `compose up -d` recrée `api` et `worker` en parallèle, et `web` après `api`. Ce n'est pas un déploiement glissant : il y a une brève période où API et worker sont ensemble sur le nouveau code.

### 4.3 Procédure

1. Sauvegarde (section 1.4) et tirage de l'image PostgreSQL.
2. Ajout des variables de la section 2 au fichier `/home/deployer/docupro-demo.env`, mode 600 conservé.
3. Lancement de `infra/scripts/deploy.sh` (sans modification).
4. Vérifications de la section 5, dans l'ordre des sections.

### 4.4 Retour arrière

- Pas de migration inverse. Le retour arrière passe par la restauration du dump (`pg_restore`), avec l'arrêt de l'API et du worker pendant la restauration.
- Les images sont taguées `:latest` : le déploiement précédent est écrasé. Pour pouvoir revenir en arrière, tagger l'image courante avant le build (`docker tag docupro-demo-api:latest docupro-demo-api:avant-ged`, de même pour `worker` et `web`). Ce tag n'est pas fait par le script.
- Les variables ajoutées n'ont pas besoin d'être retirées pour revenir à l'ancien code, qui les ignore.

---

## 5. Checklist de recette sur base réelle

Les cases se cochent après exécution. « Attendu » donne le résultat à obtenir. Les commandes supposent les noms de conteneurs de `docker-compose.prod.yml` et les valeurs du gabarit (utilisateur `docupro`, base `DocuPro`).

### 5.1 Base et pgvector

- [ ] `\dx` (psql) liste `vector`. Attendu : une ligne `vector`, avec sa version.
- [ ] `SELECT extversion FROM pg_extension WHERE extname = 'vector';` Attendu : 0.8 ou plus (sinon la relecture itérative HNSW n'est pas appliquée).
- [ ] `SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name LIKE 'ged_%';` Attendu : 11.
- [ ] `SELECT ged_ai_setting_id, mode FROM ged_ai_setting;` Attendu : une ligne, `1` et `0` (IA désactivée).
- [ ] `\d ged_document_chunk` affiche `ix_ged_chunk_embedding_hnsw` et la colonne `embedding vector(1024)`.
- [ ] `prisma migrate status` ne signale aucune migration en attente.

### 5.2 Redis et files BullMQ

- [ ] `docker exec docupro-demo-redis redis-cli ping` : `PONG`.
- [ ] Au démarrage du worker, la ligne `Worker booted` liste sept files : `acquisition`, `courriers-reminders`, `ged-ai`, `ged-embedding`, `ged-connector-sync`, `ged-governance`, `ged-whatsapp-inbound`. Commande : `docker logs docupro-demo-worker 2>&1 | grep "Worker booted"`.
- [ ] Les files existent dans Redis sous la forme `bull:<file>:…` (préfixe par défaut de BullMQ) : `docker exec docupro-demo-redis redis-cli --scan --pattern 'bull:ged-*:meta'`.
- [ ] Aucun échec accumulé : `docker exec docupro-demo-redis redis-cli ZCARD bull:<file>:failed` renvoie `0` pour chaque file utilisée. Pour `ged-embedding`, le rattrapage passe toutes les 10 minutes : vérifier après un intervalle.
- [ ] Le worker n'affiche pas d'erreur de configuration : `docker logs docupro-demo-worker 2>&1 | grep -i "invalid environment"` ne renvoie rien.

### 5.3 Comptes OAuth (Google, Microsoft)

- [ ] Google Cloud : identifiant client de type « Application Web ». URI de redirection autorisée : `https://docupro-demo.allianceconsultants.net/connecteurs/oauth/callback`, identique à une entrée de `GED_OAUTH_REDIRECT_URIS` (correspondance exacte, `docs/ged-connecteurs.md` §12.2).
- [ ] Google, mode de publication : en mode « Test », les jetons de rafraîchissement expirent au bout de 7 jours et seuls les comptes déclarés « utilisateurs test » peuvent autoriser (à confirmer dans la documentation Google, §12.2, étape 6). Pour un usage durable, passer en production ; le périmètre `drive.readonly` est « sensible » et peut exiger une vérification Google pour une application externe.
- [ ] Google : écran de consentement avec le seul périmètre `https://www.googleapis.com/auth/drive.readonly`.
- [ ] Microsoft Entra : plateforme « Web », URI identique à la précédente ; locataire renseigné (`GED_MS_TENANT`) ; secret créé, date d'expiration notée.
- [ ] Microsoft : autorisations déléguées `Files.Read`, `Sites.Read.All`, `Mail.Read`, `offline_access` ; consentement administrateur accordé si la politique du locataire l'exige. Le périmètre minimal est à confirmer avec un vrai locataire (§12.2, étape 4).
- [ ] Un connecteur OAuth de chaque fournisseur, autorisé depuis la page web : retour sur `/connecteurs/…` avec le statut « Autorisé ». Attendu : le callback n'expose que `connectorId`, `authorized` et `expiresAt`.
- [ ] Une passe de synchronisation réussie : les éléments apparaissent dans la vue « Éléments et provenance ». Une erreur `invalid_client` indique une faute sur les identifiants de l'application.

### 5.4 Meta (WhatsApp Business)

- [ ] URL de rappel dans la console Meta : `https://docupro-demo.allianceconsultants.net/api/ged/webhooks/whatsapp/<id-du-connecteur>`, avec le verify token et l'abonnement au champ `messages`.
- [ ] Challenge GET de vérification accepté par Meta.
- [ ] Envoi de test depuis la console Meta : réponse 200, puis le message est traité (élément créé, accusé si activé). Ce test vérifie aussi que la signature `X-Hub-Signature-256` est bien validée à travers nginx et le rewrite Next.js : le corps doit arriver intact.
- [ ] Contrôle négatif : un appel avec une signature fausse reçoit 401 (pas d'information sur l'existence du connecteur).
- [ ] Limites : tester le dépassement du quota par IP (`GED_WHATSAPP_IP_RATE_LIMIT`) depuis deux réseaux distincts, pour vérifier que `GED_WHATSAPP_TRUST_PROXY` retient bien l'adresse du client (section 7).

### 5.5 Modèle d'IA

- [ ] Mode local : depuis le conteneur worker, l'endpoint répond. Exemple : `docker exec docupro-demo-worker node -e "fetch('<endpoint>/models').then(r=>console.log(r.status)).catch(e=>console.log(e.message))"`. Attendu : `200`. Une erreur `ECONNREFUSED` sur `127.0.0.1` ou `localhost` signifie que l'endpoint pointe vers le conteneur (section 2.4).
- [ ] Modèle d'embedding `bge-m3` (valeur par défaut) ou autre modèle à 1024 dimensions. Un modèle à une autre dimension fait échouer l'indexation (`Fournisseur d’embeddings : dimension inattendue`).
- [ ] Mode cloud : clé fournie par `OPENAI_API_KEY` ou par une variable `GED_AI_<NOM>` désignée par `api_key_ref` ; masquage activé (contrainte `ck_ged_ai_setting_cloud_masking`).
- [ ] Paramétrage via l'API d'administration (`/api/ged/ai/settings`) : `enabled: true` dans `GET /api/ged/ai/status`.
- [ ] Une action d'IA génère une ligne dans `ged_ai_decision` (journal). Avec l'IA désactivée, aucune ligne n'est créée et le message « IA désactivée » s'affiche.

### 5.6 Éditeur collaboratif (deux onglets, WebSocket)

- [ ] Ouvrir un document texte natif dans deux onglets (de préférence deux sessions). Une frappe dans l'un apparaît dans l'autre.
- [ ] Dans les outils de développement, onglet Réseau : la connexion `/api/collab` passe en `101 Switching Protocols`. Si elle reste en erreur ou renvoie une page Next, la route n'est pas bonne (section 3.3).
- [ ] Journal nginx (`/var/log/nginx/access.log`) : le chemin `/api/collab` répond `101`, pas `404` ou `502`.
- [ ] Fermer les deux onglets, rouvrir : le contenu est conservé (pièce d'état `.ydoc` du document).
- [ ] Origine : une connexion depuis une autre origine que celle configurée dans `CORS_ORIGIN` est refusée, si la variable est renseignée.

### 5.7 Connecteurs

- [ ] Dossier surveillé : le dossier est monté dans le worker (section 2.4) et sa racine figure dans `GED_CONNECTOR_FS_ROOTS`. Un fichier déposé apparaît après la passe. Un dossier hors des racines est refusé.
- [ ] IMAP : la boîte répond. Un hôte interne (adresse privée ou nom sans point) est refusé sauf s'il figure dans `GED_CONNECTOR_ALLOWED_INTERNAL_HOSTS`.
- [ ] Identifiants : un connecteur enregistré avec identifiants chiffrés se synchronise. Si `GED_CONNECTOR_KEY` est absente, l'API répond 503 à l'enregistrement.
- [ ] Rotation de clé (optionnelle, `docs/ged-connecteurs.md` §7.2) : `POST /api/ged/connectors/rotate-keys` et contrôle `credentials_key_id`.
- [ ] Aucun identifiant ni jeton n'apparaît dans les journaux du worker et de l'API.

### 5.8 Gouvernance

- [ ] Lancer une analyse (`POST /api/governance/analyze`). Les propositions apparaissent dans l'écran Gouvernance.
- [ ] Rien n'est appliqué sans validation : valider une proposition de doublon archive le document en le gelant (`is_frozen`), sans suppression.
- [ ] Un utilisateur sans droit sur le document ou sur l'original ne voit pas la proposition.
- [ ] Mode cloud : aucune détection de noms ; le message permanent de l'écran le signale.

### 5.9 Recherche sémantique et questions-réponses

- [ ] Réindexation (administrateur, `POST /api/semantic-search/reindex`) ou attente du rattrapage (10 minutes). Les segments apparaissent dans `ged_document_chunk`.
- [ ] Une recherche retrouve un document indexé. Un utilisateur sans droit ne le voit pas, et la réponse ne distingue jamais « existe mais interdit ».
- [ ] Une question sans segment pertinent (seuil 0,30) répond « Je ne sais pas » ; sa décision est journalisée sans le texte de la question.
- [ ] Limite de débit : 20 recherches par minute et 6 questions par minute et par utilisateur, puis 429 avec `Retry-After`.

### 5.10 Contrôle d'ensemble

- [ ] `infra/scripts/verify-prod.sh` (lecture seule) : tous les contrôles passent. Il ne couvre ni pgvector, ni les files, ni le WebSocket, ni les connecteurs : la présente checklist est nécessaire en complément.

---

## 6. Dépendances des images

- Les trois Dockerfiles (`Dockerfile.api`, `Dockerfile.web`, `Dockerfile.worker`) partent de `node:20-bookworm-slim` : base Debian avec glibc. Les images d'exécution sont sur la même base.
- `@napi-rs/canvas` fournit des binaires précompilés par plateforme, en paquets optionnels séparés (dans le `node_modules` Windows local, on trouve `@napi-rs/canvas-win32-x64-msvc`). Sous Linux glibc, c'est le paquet `gnu` qui doit être installé. Il est déclaré dans `apps/api` et `packages/pdf`. À vérifier dans l'image construite : `docker run --rm --entrypoint sh docupro-demo-api:latest -c 'ls /app/node_modules/@napi-rs'`.
- `imapflow` (dépendance de `packages/connectors`) et `happy-dom` (dépendance de `packages/editor`) sont du JavaScript pur. Dans le `node_modules` local, aucun des deux paquets ne déclare de script d'installation ni de fichier `binding.gyp`. Ce constat ne remplace pas une vérification dans l'image.
- Les trois Dockerfiles exécutent `pnpm install --frozen-lockfile` à la racine, sans filtre : chaque image installe donc tout le workspace.
- **`packages/connectors/package.json` est désormais copié dans les trois Dockerfiles** (une ligne ajoutée après `packages/storage`). C'est une modification non commitée de la copie de travail. Elle est nécessaire pour que l'installation du lockfile trouve ce paquet ; ce point n'a pas été vérifié par un build.
- Le worker télécharge `eng.traineddata.gz` et `fra.traineddata.gz` depuis `tessdata.projectnaptha.com` au moment du build (`ADD`). Le build exige donc un accès sortant à cet hôte.
- `.dockerignore` exclut `.env*`, `docs/`, `infra/` et les `tsbuildinfo`. Les valeurs de production ne peuvent pas entrer dans l'image.

---

## 7. Limites connues consolidées

Liste dédupliquée. Chaque entrée renvoie à son document source (`ged-connecteurs` = `docs/ged-connecteurs.md`, et ainsi de suite). « pt » renvoie au numéro du point dans la section indiquée. Les formulations sont celles des documents.

### 7.1 Droits et permissions

- Les droits d'origine modifiés ou retirés à la source ne sont pas répercutés sur les permissions du document, ni en copie ni en synchronisation. Une révocation reste active tant qu'elle n'est pas retirée à la main, et un droit ajouté n'est pas accordé. **Décision métier en attente** (encadré d'en-tête ; `ged-connecteurs` §11.2, pt 16).
- Le repli de droits (`rights.fallbackUserGroupIds`) s'applique aussi quand l'ACL est lisible mais qu'aucun principal n'est mappé : le document peut être ouvert à plus de personnes que dans la source. Cela contredit la règle « jamais plus ouvert qu'à la source » de `ged-connecteurs` §7.4 ; à trancher avec le point 16 (§11.2, pt 48).
- Les droits créés par l'ingestion portent comme `granted_by` le groupe bénéficiaire, et non l'auteur de l'octroi : la trace d'audit des droits est inexacte (`ged-connecteurs` §11.2, pt 17).
- Le principal des droits d'origine Outlook est l'adresse `mailboxAddress` saisie, non comparée au compte qui autorise (§11.2, pt 49 ; §12.2, étape 7).
- Sans bits POSIX (Windows, SMB sans mapping), aucune ACL n'est lue : seuls les groupes de repli s'appliquent. Un lecteur « autre » est ignoré (§11.2, pt 30 et 31).
- Un doublon n'ajoute aucun droit à l'original ; une personne qui n'a accès qu'à la seconde source ne voit pas le document, sans signal (§11.2, pt 21).
- Le texte indexé en place est dans `origin_metadata.indexedText`, hors recherche documentaire et hors pipeline IA. Il n'est pas exposé par l'API, mais aucun droit DocuPro ne le protège encore (§11.2, pt 24).
- Le numéro de l'expéditeur WhatsApp est stocké en clair dans `origin_metadata` et dans la clé `wa:` de `rights.principalMap`. Il n'est ni dans `origin_acl`, ni dans les journaux (`ged-connecteurs` §16.5).
- Gouvernance : les droits de visibilité suivent un filtre SQL qui est une copie synchronisée de `DocumentsService.canAccess` (test d'équivalence inclus). Cette copie doit être maintenue à chaque évolution des droits (`ged-gouvernance`, « API »).

### 7.2 Synchronisation, fichiers et suppressions

- Aucune détection de suppression IMAP : `deletedExternalIds` est toujours vide (§11.2, pt 7).
- Suppressions du dossier partielles : `findMissing` ne tourne qu'en fin de passe complète, et seulement sur certains états (pt 8).
- Un fichier qui arrive avec une date de modification antérieure au dernier élément rendu n'est jamais repris, le curseur ne revenant pas en arrière. Il n'existe pas de remise à zéro du jeton par l'API (pt 9 ; voir aussi pt 4, 32 et 39).
- Renommage ou déplacement : le chemin est l'identifiant. Le fichier déplacé devient un nouvel élément ; l'ancien passe « Supprimé à la source ». Le document n'est pas renommé (pt 10).
- Détection de fin d'écriture fondée sur la seule date de modification (30 secondes par défaut) : aucun contrôle de taille stable ni de verrou (pt 11).
- Chaque page de 100 éléments refait un parcours complet du dossier : le coût suit la taille de l'arborescence (pt 12).
- Chaque fichier est chargé entièrement en mémoire (jusqu'à 50 Mio), et deux passes peuvent tourner en parallèle (pt 13).
- Quotas : seul l'IMAP lève `ConnectorQuotaError`, et aucun quota n'est configurable par connecteur (pt 14).
- Création non atomique : le rejeu est idempotent et adopte le document orphelin, mais une source modifiée entre-temps donne une version supplémentaire (pt 15).
- Changement de mode : aucun élément déjà traité n'est converti (pt 18).
- Anti-concurrence quasi atomique : une fenêtre de quelques millisecondes permet à deux passes de coexister. Un vrai verrou demanderait une colonne ou un verrou consultatif PostgreSQL (pt 19).
- Connecteur en échec répété : pas de recul progressif ni de limite d'éléments en erreur ; chaque passe rejoue tous les éléments en erreur (pt 20).
- Un jeton illisible fait échouer la passe à chaque tick jusqu'à intervention manuelle (pt 32).
- Une clé sans identifiant (`credentials_key_id` NULL) ne se déchiffre jamais : correction manuelle en base (pt 22).
- Un connecteur désactivé reste « Inactif » après ré-autorisation : ni `oauth/start` ni `oauth/callback` ne vérifient `isActive` (pt 57).
- Une ligne `credentials` saisie à la main est refusée pour les types OAuth : les identifiants par référence ne servent pas à ces types (pt 58).
- Changement de mode, indexation en place : un élément indexé en place identique à une copie devient un doublon sans texte indexé ; les types non extractibles ne sont pas dédoublonnés (pt 26).

### 7.3 Extraction de texte et pièces

- Seuls `.txt`, `.csv`, `.md`, `.html`, `.htm` et `.pdf` (couche texte) donnent un texte. Pas d'OCR sur les images ni les PDF scannés (pt 25 et 29).
- Bornes d'extraction : HTML tronqué à 2 Mio ; PDF au-delà de 500 pages ou de 30 secondes : texte NULL (pt 25).
- Pièces ignorées sans trace au listage : images de moins de 10 Ko, images incorporées, extensions non autorisées (IMAP pt 28 ; Outlook pt 43).
- Pièces jointes Outlook : au-delà de 5 pages de pièces jointes pour un même message, les suivantes sont ignorées sans erreur (`MAX_ATTACHMENT_PAGES`, pt 42). Une page peut produire plus d'éléments que `pageSize` (pt 42).
- Outlook : un message déplacé est vu comme supprimé, et son identifiant Graph peut changer (pt 41). Les suppressions sont retenues en mémoire d'instance : si la passe s'interrompt après l'avance du jeton, elles sont perdues (pt 40 ; `ged-connecteurs` §13.5).
- Sortie du périmètre (dossier ou bibliothèque) : l'élément n'est ni repris ni signalé supprimé (pt 44).
- Google Drive : le coût de la restriction à un dossier, qui remonte les parents sans cache, n'a pas été mesuré (pt 45). La limite de 10 Mo pour les exports, affichée par le code, n'est pas vérifiée contre la documentation Google (pt 47).
- SharePoint : une bibliothèque nommée n'est cherchée que sur 5 pages de bibliothèques ; au-delà, « introuvable » (pt 46).
- Images WhatsApp : pas d'OCR (`ged-connecteurs` §16.5, dernier point ; pt 25).

### 7.4 Sécurité et configuration des connecteurs

- Les variables des connecteurs et OAuth ne figurent dans aucun schéma d'environnement : aucun contrôle au démarrage (`ged-connecteurs` §11.1 pt 3 ; §11.2 pt 33 et 38 ; §9).
- La garde SSRF lit `GED_CONNECTOR_ALLOWED_INTERNAL_HOSTS` dans `process.env` et non dans l'environnement injecté : un test qui fournit un autre environnement ne l'atteint pas (§11.1, pt 5).
- Deux fonctions `redactSecrets` coexistent (`crypto.ts` et `imap-errors.ts`), avec des seuils différents (§11.1, pt 6).
- La clé par défaut est `k1` si `GED_CONNECTOR_KEY_ID` n'a jamais été défini : la rotation doit alors mettre `k1` dans `GED_CONNECTOR_KEY_PREVIOUS` (§11.2, pt 23).
- La rotation Microsoft est persistée par le worker, mais son comportement réel après rotation reste à confirmer avec un compte réel (§11.2, pt 35).
- Messages « réinitialisez le jeton » sans route pour le faire (`ged-connecteurs` §11.1 pt 4 ; §11.2 pt 39).
- Écarts avec le brief, sans effet fonctionnel signalé : écran d'administration non décrit dans le document (§11.1, pt 1) ; contrôle de rotation par SQL faute de route (pt 2) ; stockage d'état OAuth par script Lua et non `GETDEL` (§11.2, pt 37).

### 7.5 OAuth réel (non vérifié sans compte)

- Consentement granulaire Google : une case décochée fait refuser l'autorisation (« autorisation incomplète »), comportement non confronté à Google (§11.2, pt 50 ; §12.3 étape 6).
- Expiration des jetons Google en mode test : le code ne fixe une échéance que si la réponse contient `refresh_token_expires_in` ; la durée réelle n'est pas vérifiée (§11.2, pt 51 ; §12.2, étape 6).
- Microsoft : aucune échéance calculée ; la durée de validité du jeton de rafraîchissement n'est pas modélisée (§11.2, pt 52).
- Hôtes de téléchargement Graph (SharePoint, OneDrive) non vérifiés en conditions réelles (§11.2, pt 53).
- Réponses simulées : aucun test n'a été lancé contre Google ni Microsoft (§11.2, pt 54 ; §15).
- Permissions Microsoft minimales à confirmer avec un vrai locataire, et consentement administrateur possiblement requis (§12.2, étapes 4 et 5).
- Le secret client Microsoft expire : à son échéance, les passes échouent avec `invalid_client` et le connecteur passe « En erreur » (§12.2, étape 3 ; §13.6).
- Tests : le script `test` de `apps/web` affiche « no tests yet » ; `apps/web/app/connecteurs/_tests/oauth.test.ts` n'est lancé par aucune commande du paquet (§11.2, pt 55 ; §15).

### 7.6 WhatsApp Business (`ged-connecteurs` §16.5)

- Non vérifié contre l'API réelle de Meta : forme de l'URL du média (hôte `lookaside.fbsbx.com` supposé) et redirections ; présence de `Content-Length` ; format de `sha256` ; codes d'erreur Graph ; acceptation de `phone_number_id` sur le GET du média ; délai de réponse attendu pour les webhooks ; signature sur les octets exacts.
- Modèles de messages et fenêtre de service de 24 heures : hors périmètre. Un accusé hors fenêtre peut être refusé par Meta ; l'échec est journalisé sans faire échouer l'ingestion.
- Limiteurs de l'API en mémoire, par instance. Sans `GED_WHATSAPP_TRUST_PROXY=1` derrière un proxy, toutes les requêtes partagent l'IP du proxy. Un client IPv6 avec un préfixe `/64` peut contourner le quota par IP en changeant d'adresse.
- Après une panne de l'API de plus d'une heure, les messages ré-émis par Meta sont comptés comme périmés et perdus (réponse 200). Les messages excédentaires d'un expéditeur sont ignorés avec un 200.
- Messages d'expéditeurs inconnus, non pris en charge ou limités : aucun élément créé, donc rien dans « Messages reçus » (seulement dans les journaux, pseudonymisés).
- Un jeton Graph expiré rend l'élément « En erreur » définitivement : le message doit être renvoyé après correction du jeton.
- Plusieurs numéros sous une même application Meta partagent le secret d'application ; l'isolation repose sur `phone_number_id`.

### 7.7 Proxys et adresses client

Ce point est une conséquence de la chaîne réelle (section 3) plus qu'une limite documentée. Les documents supposent un proxy unique devant l'API. Or la requête vers l'API traverse nginx puis le proxy interne de Next.js (`rewrites`). Si Next.js ajoute sa propre entrée à `X-Forwarded-For`, la dernière entrée lue avec `GED_WHATSAPP_TRUST_PROXY=1` ou `COLLAB_TRUST_PROXY=1` serait l'adresse de la passerelle Docker, et non celle du client : tous les clients partageraient alors un même quota. Non vérifié dans ce dépôt. Test de recette : section 5.4.

### 7.8 Socle IA (`docs/ged-ia.md`)

- Configuration et clés lues deux fois, côté API et côté worker. Divergences : référence `GED_AI_*` vide (l'API retombe sur `OPENAI_API_KEY` en cloud OpenAI, le worker non) ; https de l'endpoint OpenAI contrôlé à des moments différents ; cloud sans clé traité différemment ; repli `localhost:11434` uniquement côté worker (§12, pt 1).
- Journal côté API incomplet : un échec de masquage ou de configuration n'y laisse aucune trace ; le worker journalise les échecs de masquage (§12, pt 2).
- Le journal est dit « append-only », mais la revue modifie `status`, `validated_by` et `validated_at` (§12, pt 3).
- Commentaires du schéma : `provider` dit « validé par l'API » alors que seule la longueur est contrôlée ; `api_key_ref` évoque un « identifiant de coffre » non implémenté ; `ck_ged_ai_setting_dimension` ne vérifie que `> 0`, la dimension 1024 n'étant imposée que par l'API (§12, pt 4).
- `OPENAI_MODEL` déclarée sans lecteur (§12, pt 5 ; section 2.2 de ce guide).
- Pas de relance : un échec fournisseur reste une décision `Erreur`, et une nouvelle tentative suppose un nouvel appel à `analyze` (§12, pt 6).
- Extraction des courriers : `POST /api/courriers/extraction-ia` ne vérifie pas `isEnabled()` avant la lecture locale (OCR), la réponse étant 503 si l'IA est désactivée (§12, pt 7). **Contradiction** : la fin de `docs/ged-ia.md` (§13) affirme au contraire que `ai.status()` est testé avant l'OCR et qu'aucun OCR ne se lance. À trancher par le code avant recette.
- Noms libres non détectés, ni par le pipeline ni par l'extraction des courriers ; les libellés envoyés au cloud ne sont masqués que par les règles configurées (§12, pt 8 ; §9).
- Masquage : noms propres sans civilité ni libellé, noms en minuscules après une civilité, montants en lettres, e-mails obfusqués, adresses postales, dates de naissance, identifiants de moins de 8 chiffres : non détectés. Sur-masquage assumé : références de 9 chiffres ou plus, « Client : … » jusqu'en fin de ligne, mots en capitales après une civilité (§4, « Limites connues »).
- Dimension : 1024 imposée par l'API ; la colonne `vector(1024)` est fixe. Une autre dimension exige une migration (§8 ; §10, pt 5).
- Documentation d'exploitation : `.env.example` indique encore que « sans clé, la case n'apparaît pas », alors que la disponibilité dépend désormais de l'IA activée et de la lecture locale (§12, pt 9).

### 7.9 Recherche sémantique (`docs/ged-recherche.md`)

- Rien n'a été exécuté sur PostgreSQL avec pgvector. Restent non vérifiés : le SQL (droits, pgvector, HNSW, `iterative_scan`, CHECK, index unique partiel), le typage des paramètres de `$executeRaw`, le comportement réel de BullMQ (`upsertJobScheduler`, déduplication par `jobId`), l'efficacité des consignes anti-injection sur un vrai modèle, et le rendu de la page (§9).
- Limite de débit en mémoire, propre à chaque processus, non partagée entre instances (§5).
- Hypothèses métier à valider : segments d'environ 800 caractères avec chevauchement de 120 ; 8 segments envoyés au modèle ; seuil de similarité 0,30 « à calibrer selon le modèle » ; documents gelés exclus (`/search` les inclut) ; état « Restreint » non exclu comme dans `/search` (§8).
- La recherche ne couvre que les documents indexés. Pas de hook dans `doc-versions` : un changement de version est rattrapé par le `sweep` sous 10 minutes au plus (§2 ; §8).

### 7.10 Gouvernance (`docs/ged-gouvernance.md`)

- `is_frozen` sert d'archivage logique. Une colonne `document.duplicate_of_id` ou `archived_at` serait souhaitable plus tard (« Limites connues », point 1).
- Refus de valider un doublon si l'original est gelé ou épuré.
- Totaux : une ligne invalide seulement sur des champs secondaires peut être comptée sans être listée (écart d'un en plus au pire).
- Quasi-doublons sémantiques : `hnsw.iterative_scan` activé conditionnellement (pgvector 0.8 ou plus), comme en recherche.
- Périmètre : la détection des noms par le modèle n'a lieu qu'en mode local ; en cloud elle est désactivée (`namesDetection: 'disabled_cloud'`), et aucun texte de document n'est envoyé au modèle pour la gouvernance.
- Non vérifié : le SQL (agrégats, `GROUPING SETS`, pgvector, filtres de droits, `FOR UPDATE`) n'a été validé que par la forme des requêtes avec un faux Prisma. Une recette sur PostgreSQL et pgvector avec des jeux de droits reste à faire.

### 7.11 Rédaction assistée (`docs/ged-redaction.md`)

- Modification additive hors module : `CollabDocumentsService.createDocumentFromHtml` et son export dans `collab.module.ts` (§5).
- Liens de notification : une mention ouvre `/editeur/<id>` et l'e-mail utilise `TARGET_LINK.document` (§5).
- Non vérifié sans modèle réel : qualité du français, respect des règles d'isolation par un vrai modèle, troncature à 3000 jetons de sortie. Non vérifié sans navigateur : rendu clair et sombre, focus clavier, insertion Tiptap réelle (§5).

### 7.12 Incohérences relevées entre documents

- `ged-connecteurs` §15 affirme qu'« aucun test du worker ne couvre encore le lot 2b » (renvoi au point 56), alors que le point 56 indique que `sync.processor.spec.ts` couvre le câblage de `connectorEnv()` et la persistance de la rotation. Les deux ne peuvent pas être vrais en même temps.
- `ged-ia` §12 (pt 7) et §13 (dernière puce) se contredisent sur le contrôle de l'IA avant l'OCR des courriers (voir 7.8).
- `ged-connecteurs` §12.2 (étape 5) attend « le point 34 corrigé » ; le point 34 indique que la correction est faite (voir section 2.2).
- `ged-ia` §8 décrit l'indexation comme « non indexée » et « relève du lot 3 ». Ce passage est dépassé depuis le lot 3 (`docs/ged-recherche.md`) : ne pas le suivre pour le comportement actuel.

---

*Fin du guide. Mettre à jour ce document lorsque `docs/ged-espaces.md` et `docs/ged-editeur.md` seront finalisés, et lorsque les modifications non commitées (Dockerfiles, compose) auront été commitées.*
