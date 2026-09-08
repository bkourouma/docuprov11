# Guide de déploiement — DocuPro (« Archivage par QR ») sur Windows

Guide **pas‑à‑pas** pour mettre l'application en production sur une machine Windows.
Il est écrit pour ton cas actuel (**ton PC sert de serveur**) tout en restant valable
pour un **vrai serveur** plus tard : les rares différences sont signalées par
> 🖥️ **Serveur dédié** : …

Tu peux suivre les phases dans l'ordre. Coche au fur et à mesure.

- **Niveau 1** (§1 → §6) : builder en mode prod + lancer le code compilé. *Indispensable, commence ici.*
- **Niveau 2** (§7) : transformer les 3 apps en **services Windows** (démarrage auto, redémarrage si crash). *Le vrai mode « serveur ».*
- **Niveau 3** (§8) : reverse‑proxy **HTTPS** devant. *Optionnel sur un PC, utile sur le serveur final.*

---

## 0. Vue d'ensemble

L'application est un **monorepo pnpm + Turborepo** composé de **3 services Node** :

| Service | Dossier | Port | Lancement (prod) | Rôle |
|---|---|---|---|---|
| **web** | `apps/web` | `5000` | `next start -p 5000` | Interface (Next.js) |
| **api** | `apps/api` | `3001` | `node dist/main.js` | API REST (NestJS), préfixe `/api` |
| **worker** | `apps/worker` | — | `node dist/index.js` | Traitement des lots (BullMQ) |

…plus **2 dépendances d'infrastructure** :

| Brique | Où | Port | Statut sur ton PC |
|---|---|---|---|
| **PostgreSQL** | natif Windows | `5432` | ✅ déjà installé (base `DocuPro`) |
| **Redis** | conteneur Docker | `6379` | ✅ déjà via `docker compose` |

Et un **coffre disque** pour les binaires (jamais en base) : `ARCHIVES_PATH` (par défaut `D:\ARCHIVES`).

### Ce qui change par rapport à ton mode dev

> ⚠️ En dev tu lances `start-docupro.bat` → `pnpm dev` (`nest start --watch`, `next dev`, `tsx watch`).
> **On ne fait JAMAIS ça en prod.** En prod on **compile** (`pnpm build`) puis on lance le
> **code compilé** (`node dist/...`), maintenu vivant indépendamment de toute fenêtre.

La seule vraie nouveauté est donc : **build** + **mode de lancement**. Le reste (Postgres, Redis, `.env`) tu le connais déjà.

---

## 1. Prérequis (à vérifier une fois)

Ouvre **PowerShell** et vérifie :

```powershell
node -v        # doit afficher v20.x ou plus
corepack -v    # présent (fourni avec Node)
docker -v      # Docker Desktop installé et démarré (pour Redis)
```

Active pnpm via corepack (pas d'install globale) :

```powershell
corepack enable
corepack prepare pnpm@9.15.0 --activate
pnpm -v        # doit afficher 9.15.0
```

Vérifie que **PostgreSQL** tourne et écoute sur `5432` :

```powershell
Get-Service -Name "postgresql*"             # doit être "Running"
Test-NetConnection -ComputerName localhost -Port 5432   # TcpTestSucceeded : True
```

> 🖥️ **Serveur dédié** : installe au préalable Node ≥ 20, Docker (ou Redis natif/**Memurai**),
> et PostgreSQL (installeur EDB) ; recrée le rôle `archivage` + la base `DocuPro`.

- [ ] Node ≥ 20, pnpm 9.15.0, Docker, PostgreSQL OK

---

## 2. Préparer la configuration de production (`.env`)

L'application lit ses variables depuis **deux** fichiers `.env` (déjà présents chez toi) :

- `D:\Docu-Archives-V6\.env` → l'**api** (via `@nestjs/config`) et le **script de lancement** (qui les injecte au **worker**).
- `D:\Docu-Archives-V6\packages\db\.env` → la **CLI Prisma** (migrations / generate / seed).

> ⚠️ **Le worker ne lit pas `.env` tout seul** : il lit `process.env`. C'est le script de lancement
> (§5) qui charge `.env` dans l'environnement avant de démarrer le worker. Ne saute pas cette étape.

### 2.1 Renseigner le `.env` racine pour la prod

Édite `D:\Docu-Archives-V6\.env` et passe ces valeurs en mode production :

```ini
# --- Database (PostgreSQL local) ---
DATABASE_URL="postgresql://archivage:TON_MOT_DE_PASSE@localhost:5432/DocuPro?schema=public"

# --- Redis (BullMQ) ---
REDIS_URL="redis://localhost:6379"

# --- Coffre disque (binaires hors base) ---
ARCHIVES_PATH="D:/ARCHIVES"

# --- Auth ---
# ⚠️ GÉNÈRE une vraie valeur (voir 2.2). NE GARDE PAS la valeur d'exemple.
JWT_SECRET="REMPLACE_PAR_UN_SECRET_ALEATOIRE_64_CARACTERES"
JWT_EXPIRES_IN="1d"

# --- API ---
NODE_ENV="production"
PORT=3001

# --- OCR ---
TESSERACT_LANG="fra+eng"
TESSERACT_DATA_PATH=""

# --- (Optionnel) Restreindre CORS en prod : origines autorisées séparées par des virgules.
# Laisse vide/absent pour autoriser toute origine (pratique en test local).
# CORS_ORIGIN="http://localhost:5000"
```

### 2.2 Générer un vrai `JWT_SECRET`

```powershell
node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"
```

Copie la sortie dans `JWT_SECRET`.

> ⚠️ Si tu laisses le secret d'exemple (`change-me-please…`), n'importe qui peut forger un jeton **administrateur**.

### 2.3 Vérifier le `.env` de Prisma

Assure‑toi que `D:\Docu-Archives-V6\packages\db\.env` contient **le même** `DATABASE_URL` que ci‑dessus :

```ini
DATABASE_URL="postgresql://archivage:TON_MOT_DE_PASSE@localhost:5432/DocuPro?schema=public"
```

- [ ] `.env` racine en `NODE_ENV=production` + vrai `JWT_SECRET`
- [ ] `packages/db/.env` avec le bon `DATABASE_URL`

---

## 3. Préparer la base de données

⚠️ **Avant toute commande Prisma : ferme tout `pnpm dev` / processus `node` en cours**, sinon
`prisma generate` échoue en `EPERM` (le moteur Prisma est verrouillé par un node actif).

```powershell
# Stoppe les éventuels node de dev encore ouverts :
Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force
```

Place‑toi à la racine du projet pour toutes les commandes Prisma :

```powershell
cd D:\Docu-Archives-V6
```

### 3.A — Ton PC actuel : la base existe déjà ✅

Tu développes déjà sur cette base `DocuPro` : **le schéma est déjà en place**. Tu n'as donc
**rien à recréer**. Régénère simplement le client Prisma (utilisé par le build) :

```powershell
pnpm --filter @archivage/db run prisma:generate
```

> Ne relance **pas** le seed sur ta base existante (§3.B étape 5) : il est réservé à une base vierge,
> il pourrait réinitialiser le mot de passe admin / créer des doublons de référentiels.

Passe directement au **§4**.

### 3.B — Base vierge (futur serveur, ou si tu repars de zéro)

Sur une base **neuve**, applique le schéma complet **dans cet ordre** :

```powershell
# 1) Migration initiale : 21 tables + SQL brut critique
#    (index GIN plein-texte, uniques partiels, CHECK). N'a PAS besoin de shadow DB.
pnpm --filter @archivage/db run prisma:deploy

# 2) Synchronise la table ajoutée APRÈS la migration init (couche analytics : "analytics_target").
pnpm --filter @archivage/db exec prisma db push

# 3) Objets analytics additifs (index de perf, CHECK, cible par défaut). Idempotent.
pnpm --filter @archivage/db exec prisma db execute --file prisma/sql/analytics.sql --schema prisma

# 4) Génère le client typé
pnpm --filter @archivage/db run prisma:generate

# 5) Données initiales : admin/admin1234, niveaux de permission, catégories QR, référentiels démo
pnpm --filter @archivage/db run db:seed
```

> **Pourquoi `migrate deploy` PUIS `db push` ?** La migration `init` ne contient pas la table
> `analytics_target` (ajoutée plus tard au schéma). `migrate deploy` pose les 21 tables **et** le
> SQL brut (dont l'index plein‑texte indispensable à la recherche P3) ; `db push` complète avec la
> table analytics manquante sans toucher au reste. `migrate deploy` n'exige pas de privilège
> `createdb` (contrairement à `migrate dev`), il fonctionne donc avec l'utilisateur `archivage`.

- [ ] Base prête (3.A : `generate` seul / 3.B : deploy → push → analytics.sql → generate → seed)

---

## 4. Builder l'application en mode production

Toujours à la racine (`D:\Docu-Archives-V6`) :

```powershell
# 1) Dépendances figées (reproductible)
pnpm install --frozen-lockfile

# 2) Le client Prisma DOIT exister avant de compiler (api/worker importent ses types)
pnpm --filter @archivage/db run prisma:generate

# 3) Build complet : Turborepo compile d'abord les packages, puis les apps
pnpm build
```

Ce que `pnpm build` produit :

- `apps/api/dist/main.js`
- `apps/worker/dist/index.js`  *(ce dossier n'existait pas encore — c'est normal)*
- `apps/web/.next/` (build Next.js)
- `packages/*/dist/` (qr, pdf, ocr, exports, storage, types — requis au runtime par l'api/worker)

Vérifie que les sorties existent :

```powershell
Test-Path D:\Docu-Archives-V6\apps\api\dist\main.js
Test-Path D:\Docu-Archives-V6\apps\worker\dist\index.js
Test-Path D:\Docu-Archives-V6\apps\web\.next
```

> Les trois doivent renvoyer `True`. Si le build échoue sur `bcrypt` (module natif), voir §11.

- [ ] `pnpm build` OK, les 3 sorties existent

---

## 5. Niveau 1 — Lancer la version compilée

On crée **un script de lancement de prod** qui : charge `.env` dans l'environnement (indispensable
pour le worker), démarre Redis, puis ouvre les **3 services compilés** chacun dans sa fenêtre.

### 5.1 Créer `start-prod.bat`

Crée le fichier `D:\Docu-Archives-V6\start-prod.bat` avec ce contenu :

```bat
@echo off
setlocal enabledelayedexpansion
title DocuPro - PRODUCTION
cd /d "%~dp0"

echo ============================================================
echo   DocuPro - lancement PRODUCTION (code compile)
echo ============================================================

REM --- 1) Charger les variables depuis .env (le worker en depend) ---
if not exist ".env" (
  echo [ERREUR] .env introuvable a la racine.
  pause & exit /b 1
)
for /f "usebackq eol=# tokens=1,* delims==" %%a in (".env") do (
  set "val=%%b"
  set "val=!val:"=!"
  set "%%a=!val!"
)
set "NODE_ENV=production"
if "%ARCHIVES_PATH%"=="" set "ARCHIVES_PATH=D:\ARCHIVES"
if not exist "%ARCHIVES_PATH%" mkdir "%ARCHIVES_PATH%"
echo [OK] Config chargee (NODE_ENV=%NODE_ENV%, coffre=%ARCHIVES_PATH%)

REM --- 2) Verifier que le build existe ---
if not exist "apps\api\dist\main.js" (
  echo [ERREUR] Build manquant. Lance d'abord : pnpm build
  pause & exit /b 1
)

REM --- 3) Redis (Docker) ---
echo [..] Demarrage de Redis (Docker)...
docker compose up -d redis
if errorlevel 1 echo [ATTENTION] Redis non demarre - lance Docker Desktop.

REM --- 4) Lancer les 3 services compiles (fenetres separees) ---
echo.
echo   web    : http://localhost:5000
echo   api    : http://localhost:3001/api
echo   login  : admin / admin1234
echo ------------------------------------------------------------
start "DocuPro API"    cmd /k "cd /d "%~dp0apps\api"    && node dist\main.js"
start "DocuPro Worker" cmd /k "cd /d "%~dp0apps\worker" && node dist\index.js"
start "DocuPro Web"    cmd /k "cd /d "%~dp0apps\web"    && node node_modules\next\dist\bin\next start -p 5000"

echo [OK] 3 services lances dans des fenetres separees.
echo      Ferme ces fenetres pour arreter l'application.
endlocal
```

> Les fenêtres ouvertes par `start` **héritent** des variables chargées juste avant : c'est ainsi que
> le **worker** reçoit `DATABASE_URL`, `REDIS_URL`, `ARCHIVES_PATH`, etc.

### 5.2 Lancer

Double‑clique sur `start-prod.bat` (ou en PowerShell) :

```powershell
cd D:\Docu-Archives-V6
.\start-prod.bat
```

Trois fenêtres s'ouvrent (API, Worker, Web). Attends quelques secondes que chacune affiche son message de démarrage.

- [ ] Les 3 fenêtres tournent sans erreur rouge

---

## 6. Vérifier que tout fonctionne (smoke test)

1. **API en ligne** — dans PowerShell :
   ```powershell
   Invoke-WebRequest http://localhost:3001/api -UseBasicParsing | Select-Object StatusCode
   ```
   Une réponse (même `404` sur la racine) prouve que l'API écoute. La fenêtre « DocuPro API »
   doit afficher `API ready on http://localhost:3001/api`.

2. **Interface** — ouvre **http://localhost:5000** dans le navigateur.
   Connecte‑toi avec **admin / admin1234** (puis change le mot de passe : voir §10.4).

3. **Chaîne complète (api + worker + Redis + base + OCR)** — c'est le vrai test de bout en bout :
   - va sur **`/intercalaires`**, génère une feuille d'intercalaires (P1) ;
   - va sur **`/acquisition`**, dépose un PDF (P2) → la fenêtre « DocuPro Worker » doit logguer
     `job completed` ;
   - va sur **`/search`**, recherche un terme (P3) → les documents traités remontent.

Si ces 3 écrans marchent, **ton déploiement de prod fonctionne**. 🎉

- [ ] Login OK + acquisition traitée par le worker + recherche OK

---

## 7. Niveau 2 — Installer en services Windows (NSSM)

Objectif : que l'application **démarre toute seule au boot** et **redémarre si elle plante**, sans
aucune fenêtre ouverte. C'est exactement le mécanisme que tu utiliseras sur le serveur final.

On utilise **NSSM** (*Non‑Sucking Service Manager*), l'outil le plus fiable pour transformer un
process Node en service Windows.

### 7.1 Installer NSSM

- Télécharge NSSM depuis https://nssm.cc/download (zip), extrais `win64\nssm.exe`
  par exemple dans `D:\tools\nssm.exe`.
- Ouvre **PowerShell en administrateur** (obligatoire pour créer des services).

### 7.2 Créer un script qui charge `.env` puis lance un service

Pour que chaque service reçoive les variables d'environnement (le worker en a besoin), on fait
pointer NSSM sur un petit **wrapper** par service. Crée le dossier `D:\Docu-Archives-V6\svc\` puis
ces 3 fichiers :

`svc\run-api.cmd`
```bat
@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0.."
for /f "usebackq eol=# tokens=1,* delims==" %%a in (".env") do (
  set "val=%%b"
  set "val=!val:"=!"
  set "%%a=!val!"
)
set "NODE_ENV=production"
cd /d "%~dp0..\apps\api"
node dist\main.js
```

`svc\run-worker.cmd`
```bat
@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0.."
for /f "usebackq eol=# tokens=1,* delims==" %%a in (".env") do (
  set "val=%%b"
  set "val=!val:"=!"
  set "%%a=!val!"
)
set "NODE_ENV=production"
cd /d "%~dp0..\apps\worker"
node dist\index.js
```

`svc\run-web.cmd`
```bat
@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0.."
for /f "usebackq eol=# tokens=1,* delims==" %%a in (".env") do (
  set "val=%%b"
  set "val=!val:"=!"
  set "%%a=!val!"
)
set "NODE_ENV=production"
cd /d "%~dp0..\apps\web"
node node_modules\next\dist\bin\next start -p 5000
```

> Le wrapper se termine par `node …` au **premier plan** : NSSM suit ce process et le relance s'il meurt.
> `setlocal enabledelayedexpansion` (2ᵉ ligne) est indispensable pour que `!val!` soit évalué dans la boucle.

### 7.3 Enregistrer les 3 services (PowerShell admin)

```powershell
$nssm = "D:\tools\nssm.exe"
$svc  = "D:\Docu-Archives-V6\svc"
$logs = "D:\Docu-Archives-V6\logs"
New-Item -ItemType Directory -Force $logs | Out-Null

# --- API ---
& $nssm install DocuPro-Api  "$svc\run-api.cmd"
& $nssm set DocuPro-Api AppStdout "$logs\api.log"
& $nssm set DocuPro-Api AppStderr "$logs\api.err.log"
& $nssm set DocuPro-Api AppRotateFiles 1
& $nssm set DocuPro-Api Start SERVICE_AUTO_START

# --- Worker ---
& $nssm install DocuPro-Worker "$svc\run-worker.cmd"
& $nssm set DocuPro-Worker AppStdout "$logs\worker.log"
& $nssm set DocuPro-Worker AppStderr "$logs\worker.err.log"
& $nssm set DocuPro-Worker AppRotateFiles 1
& $nssm set DocuPro-Worker Start SERVICE_AUTO_START

# --- Web ---
& $nssm install DocuPro-Web "$svc\run-web.cmd"
& $nssm set DocuPro-Web AppStdout "$logs\web.log"
& $nssm set DocuPro-Web AppStderr "$logs\web.err.log"
& $nssm set DocuPro-Web AppRotateFiles 1
& $nssm set DocuPro-Web Start SERVICE_AUTO_START
```

> **Dépendances** : Postgres (service `postgresql-x64-16` ou similaire) et Redis doivent être prêts
> avant l'API/worker. Redis tourne sous Docker ; le plus simple est de garder Docker Desktop en
> démarrage auto, ou de basculer Redis vers **Memurai** (service natif) sur le serveur final. Tu peux
> aussi forcer une dépendance vers Postgres :
> ```powershell
> & $nssm set DocuPro-Api DependOnService "postgresql-x64-16"
> & $nssm set DocuPro-Worker DependOnService "postgresql-x64-16"
> ```

### 7.4 Démarrer / arrêter / surveiller

```powershell
Start-Service DocuPro-Api, DocuPro-Worker, DocuPro-Web
Get-Service  DocuPro-*            # statut
# Arrêt :
Stop-Service  DocuPro-Web, DocuPro-Worker, DocuPro-Api
# Suppression d'un service (si besoin de refaire) :
& $nssm remove DocuPro-Api confirm
```

Teste un **reboot** : après redémarrage de Windows, sans rien lancer, http://localhost:5000 doit répondre.

- [ ] Les 3 services démarrent au boot et survivent à un crash
- [ ] Désactive `start-prod.bat` (Niveau 1) quand tu passes en services, pour ne pas lancer en double

### 7.5 Quatrième service — l'agent de numérisation (sur les postes de scan)

`DocuPro-ScanAgent` ne s'installe **pas sur le serveur** mais sur chaque poste équipé d'un scanner :
il y surveille le dossier de numérisation et pousse les fichiers dans l'écran « Documents scannés ».
Il n'a besoin ni de Postgres ni de Redis, seulement du réseau vers l'API.

→ Procédure complète : [agent-scan-poste.md](agent-scan-poste.md).

---

## 8. Niveau 3 — Reverse proxy HTTPS (optionnel)

Sur un PC en test local, tu peux t'arrêter au Niveau 2. Sur le **serveur final**, mets un
reverse‑proxy devant pour : **HTTPS**, un **seul nom d'hôte**, et router `/api` vers l'API.

Exemple **nginx (Windows)** — `nginx.conf` :

```nginx
server {
    listen 443 ssl;
    server_name docupro.mon-domaine.local;

    ssl_certificate     C:/certs/docupro.crt;
    ssl_certificate_key C:/certs/docupro.key;

    client_max_body_size 200m;   # gros PDF d'acquisition

    location /api/ { proxy_pass http://127.0.0.1:3001; }
    location /     {
        proxy_pass http://127.0.0.1:5000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
    }
}
```

> Alternative **IIS** : installe les modules **URL Rewrite** + **Application Request Routing (ARR)**,
> ajoute un certificat, et crée les mêmes règles (`/api/*` → `:3001`, le reste → `:5000`).
> Certificat : AD CS en interne, ou **win‑acme** (Let's Encrypt) si exposé publiquement.

Quand tu passes par un proxy HTTPS sur un domaine, pense à :
- définir `CORS_ORIGIN="https://docupro.mon-domaine.local"` dans `.env` ;
- reconstruire le **web** avec la bonne URL d'API (voir §9, variable bakée au build).

---

## 9. Accès depuis une autre machine du réseau (LAN)

Pour ouvrir l'app sur le PC lui‑même, `http://localhost:5000` suffit (rien à faire).

Pour y accéder **depuis un autre poste** du réseau :

1. **Pare‑feu** — autorise le port web (et l'API si tu n'utilises pas de proxy) :
   ```powershell
   New-NetFirewallRule -DisplayName "DocuPro Web 5000" -Direction Inbound -Protocol TCP -LocalPort 5000 -Action Allow
   New-NetFirewallRule -DisplayName "DocuPro API 3001" -Direction Inbound -Protocol TCP -LocalPort 3001 -Action Allow
   ```
2. **URL de l'API côté navigateur** — ⚠️ le web embarque l'URL de l'API **au moment du build**
   (variable `NEXT_PUBLIC_API_URL`, défaut `http://localhost:3001/api`). Depuis un autre poste,
   `localhost` désignerait *ce* poste, pas le serveur. Crée donc `apps/web/.env.production` :
   ```ini
   NEXT_PUBLIC_API_URL=http://192.168.1.50:3001/api
   ```
   (remplace par l'IP du serveur — `ipconfig` pour la trouver), puis **rebuild** :
   ```powershell
   pnpm --filter @archivage/web build
   ```
   et redémarre le service web.

> 🖥️ **Serveur dédié** : préfère le proxy HTTPS (§8) et `NEXT_PUBLIC_API_URL=https://docupro.mon-domaine/api`.

---

## 10. Exploitation

### 10.1 Sauvegardes (indispensable)

Deux choses à sauvegarder **ensemble** — la base seule est inutile sans les fichiers :

```powershell
# Base PostgreSQL (dump compressé)
pg_dump -U archivage -d DocuPro -F c -f "D:\backups\DocuPro_$(Get-Date -Format yyyyMMdd).dump"

# Coffre disque (binaires)
robocopy D:\ARCHIVES D:\backups\ARCHIVES /MIR /R:1 /W:1
```

Planifie‑les via le **Planificateur de tâches** Windows (quotidien).

### 10.2 Logs

- **Niveau 1** : visibles dans les 3 fenêtres `cmd`.
- **Niveau 2** : fichiers sous `D:\Docu-Archives-V6\logs\*.log` (rotation activée via NSSM).

### 10.3 Procédure de mise à jour (nouvelle version du code)

```powershell
cd D:\Docu-Archives-V6
# 0) stopper les services (Niveau 2)
Stop-Service DocuPro-Web, DocuPro-Worker, DocuPro-Api

# 1) récupérer le code, 2) deps, 3) migrations éventuelles, 4) client, 5) build
pnpm install --frozen-lockfile
pnpm --filter @archivage/db run prisma:deploy      # si nouvelles migrations
pnpm --filter @archivage/db run prisma:generate
pnpm build

# 6) redémarrer
Start-Service DocuPro-Api, DocuPro-Worker, DocuPro-Web
```

### 10.4 Sécurité (à faire au premier déploiement)

- [ ] Changer le mot de passe **admin/admin1234** dès la première connexion.
- [ ] Vrai `JWT_SECRET` (§2.2), `NODE_ENV=production`.
- [ ] Mot de passe PostgreSQL robuste ; n'exposer 5432/6379 qu'en local (pas ouverts au LAN).
- [ ] Empêcher la mise en veille du PC‑serveur :
  ```powershell
  powercfg /change standby-timeout-ac 0
  powercfg /change hibernate-timeout-ac 0
  ```
- [ ] ℹ️ **ACL documents** : actuellement le filtrage « deny‑by‑default » par utilisateur est
  **désactivé** (tout utilisateur connecté voit tous les documents). Si la prod doit cloisonner
  l'accès par utilisateur, c'est à réactiver côté code avant ouverture.

---

## 11. Dépannage (pièges connus)

| Symptôme | Cause | Solution |
|---|---|---|
| `prisma generate` → **EPERM** / fichier verrouillé | un process `node` (dev) tient le moteur Prisma | `Get-Process node \| Stop-Process -Force` puis relancer |
| Worker démarre puis crash : *Invalid environment variables* | `.env` non injecté dans son process | lancer via `start-prod.bat` / wrapper `svc\run-worker.cmd` (pas `node` à la main) |
| API : *port 5432 already in use* au démarrage de Postgres Docker | un Postgres **local** occupe déjà 5432 | on utilise le Postgres **local** : ne **pas** démarrer le conteneur `postgres` (seulement `redis`) |
| `pnpm build` échoue sur **bcrypt** (compilation native) | binaire prédéfini absent pour ta version de Node | installer les *Build Tools* VS, **ou** figer une version de Node avec binaire prédéfini ; sinon basculer `bcrypt`→`bcryptjs` (code) |
| Recherche (P3) lente ou vide sur base neuve | index plein‑texte / schéma incomplet | base vierge : avoir bien fait `migrate deploy` **puis** `db push` **puis** `analytics.sql` (§3.B) |
| Page web OK mais appels API en erreur depuis un autre poste | `NEXT_PUBLIC_API_URL` bakée sur `localhost` | définir l'IP/domaine dans `apps/web/.env.production` et **rebuild** le web (§9) |
| Dashboards en erreur (`analytics_target` manquante) | base créée via `migrate deploy` seul | exécuter `db push` + `analytics.sql` (§3.B étapes 2‑3) |
| Redis indisponible / worker bloqué | Docker Desktop arrêté | démarrer Docker, `docker compose up -d redis` |

---

## Annexe — Aide‑mémoire des commandes

```powershell
# Build complet
cd D:\Docu-Archives-V6
pnpm install --frozen-lockfile
pnpm --filter @archivage/db run prisma:generate
pnpm build

# Lancer (Niveau 1)
.\start-prod.bat

# Services (Niveau 2)
Start-Service DocuPro-Api, DocuPro-Worker, DocuPro-Web
Stop-Service  DocuPro-Web, DocuPro-Worker, DocuPro-Api
Get-Service   DocuPro-*

# Base vierge (futur serveur)
pnpm --filter @archivage/db run prisma:deploy
pnpm --filter @archivage/db exec prisma db push
pnpm --filter @archivage/db exec prisma db execute --file prisma/sql/analytics.sql --schema prisma
pnpm --filter @archivage/db run prisma:generate
pnpm --filter @archivage/db run db:seed
```

**Comptes / URLs par défaut** — web : http://localhost:5000 · api : http://localhost:3001/api · login : `admin` / `admin1234`.
