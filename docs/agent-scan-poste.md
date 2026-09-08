# Agent de numérisation — installation sur le poste de scan

> Remplaçant du **service Windows de numérisation** du source (§01.5.1), absent jusqu'ici de V6.
> Code : [`apps/scan-agent`](../apps/scan-agent). Écran alimenté : **Documents scannés** (§07),
> `http://<serveur>:5000/courriers/documents-scannes`.

## 1. À quoi il sert

Le pilote du scanner écrit ses fichiers dans un dossier local. L'agent surveille ce dossier et
dépose chaque fichier terminé dans la file « Documents scannés » via l'API. L'agent du courrier n'a
plus rien à téléverser à la main : il ouvre l'écran §07, la liste est déjà remplie.

```
Scanner ──► <dossier surveillé>\*.pdf ──► [ scan-agent ] ──POST /api/courriers/documents-scannes──►
   Serveur DocuPro ──► ARCHIVES\_courriers-scans\<uuid>.pdf + ligne mail_scanned_document
   ──► écran §07 « Documents scannés » ──► « Enregistrer » (§05) ──► courrier + document GED
```

Le dossier surveillé est **`D:\scans-entrants`** par défaut, modifiable par `SCAN_AGENT_WATCH_DIR`
(§5).

Après un envoi réussi, le fichier est **déplacé** dans `_envoyes\AAAA-MM-JJ\` : il ne peut plus être
renvoyé, mais il n'est jamais supprimé. Un fichier refusé part dans `_erreurs\` avec un fichier
`.motif.txt` expliquant pourquoi.

Ces deux sous-dossiers sont **masqués** : la personne qui numérise ne voit dans `D:\scans-entrants`
que ses PDF en attente d'envoi, rien d'autre. Pour les consulter en exploitation :

```powershell
Get-ChildItem D:\scans-entrants -Force -Recurse
```

L'agent n'accède **ni à la base ni au disque du serveur** : il lui faut uniquement le réseau vers
l'API et sa clé de service. On peut donc l'installer sur autant de postes que l'on veut.

## 2. Prérequis

| Sur le poste de scan                                               | Sur le serveur                    |
| ------------------------------------------------------------------ | --------------------------------- |
| Windows + **Node.js ≥ 20** ([nodejs.org](https://nodejs.org), LTS) | API DocuPro démarrée et joignable |
| Le dossier où le pilote dépose les scans                           | Une **clé de service** (voir §3)  |
| Port 3001 (API) ouvert vers le serveur                             | —                                 |

Formats acceptés : **PDF, JPG, JPEG, PNG, TIFF, TIF**. Tout le reste est ignoré et reste sur place
(c'est la liste de l'API — `.bmp` n'est pas accepté, faute de `file_type` en base).

## 3. Poser la clé de service (une fois, sur le serveur)

L'agent est un service, pas une personne : **il n'a ni compte ni mot de passe**. Il présente une
clé, posée une fois à l'installation. Générez-la :

```bash
node -e "console.log(require('node:crypto').randomBytes(36).toString('base64url'))"
```

Mettez-la dans le `.env` **du serveur**, puis **redémarrez l'API** (la clé est lue au démarrage) :

```ini
SCAN_AGENT_API_KEY="la-cle-generee"
```

Au redémarrage, l'API confirme dans son journal :

```
Scan agent key configured — X-Api-Key accepted on the scanned-documents queue
```

La même valeur ira dans le `.env` de chaque poste (§5). Points à connaître :

- **Révoquer un poste** : changez la clé côté serveur et redéployez-la sur les postes à garder.
- **Portée** : la clé n'ouvre que la file des documents scannés (lecture + dépôt). Elle ne donne
  accès à aucun autre écran, ni à la GED, ni à l'administration.
- **Auteur des dépôts** : `created_by` reste nul — un dépôt machine n'a pas d'auteur. L'auteur du
  courrier est saisi à l'enregistrement (§05), là où quelqu'un agit vraiment.

> **Repli** — sur un serveur antérieur à cette clé, l'agent sait encore utiliser un compte
> applicatif (`SCAN_AGENT_USERNAME` + `SCAN_AGENT_PASSWORD`), à condition que son rôle porte le menu
> `/courriers/documents-scannes`. À éviter : un mot de passe d'utilisateur posé sur un poste de scan
> finit toujours par expirer un vendredi soir.

## 4. Construire le paquet à copier (sur la machine de développement)

```bash
pnpm --filter @archivage/scan-agent build
```

Puis produisez un dossier autonome (`dist` + `node_modules` de production). Le chemin de sortie doit
être **relatif à la racine du dépôt** — un chemin absolu fait échouer `pnpm deploy` :

```bash
pnpm --filter @archivage/scan-agent deploy --prod ./out/scan-agent
```

Copiez le dossier `out\scan-agent` obtenu sur le poste de scan, dans `C:\DocuPro\scan-agent`.

> **Sans `pnpm deploy`** : copiez `apps\scan-agent\dist`, `apps\scan-agent\package.json` et
> `apps\scan-agent\.env.example` sur le poste, puis lancez-y `npm install --omit=dev`. L'agent n'a
> que trois dépendances (`dotenv`, `pino`, `zod`) et aucune dépendance native.

## 5. Configurer

Renommez `.env.example` en **`.env`** à côté de l'agent et renseignez-le :

```ini
SCAN_AGENT_API_URL="http://serveur-docupro:3001/api"
SCAN_AGENT_API_KEY="la-meme-cle-que-sur-le-serveur"
SCAN_AGENT_MACHINE_NAME="ACCUEIL-01"
#SCAN_AGENT_WATCH_DIR="D:/scans-entrants"   # décommentez pour surveiller un autre dossier
```

Trois lignes, aucune saisie ensuite : une fois le service installé, on numérise, point.

| Variable                            | Défaut              | Rôle                                                                                                        |
| ----------------------------------- | ------------------- | ----------------------------------------------------------------------------------------------------------- |
| `SCAN_AGENT_API_URL`                | —                   | Racine de l'API, **préfixe `/api` inclus**                                                                  |
| `SCAN_AGENT_API_KEY`                | —                   | Clé de service, identique à celle du serveur (§3)                                                           |
| `SCAN_AGENT_USERNAME` / `_PASSWORD` | —                   | Repli par compte applicatif, si le serveur n'a pas de clé                                                   |
| `SCAN_AGENT_WATCH_DIR`              | `D:\scans-entrants` | Dossier surveillé (créé s'il manque)                                                                        |
| `SCAN_AGENT_MACHINE_NAME`           | nom de la machine   | Colonne « Poste » de l'écran §07                                                                            |
| `SCAN_AGENT_POLL_MS`                | `5000`              | Intervalle entre deux balayages                                                                             |
| `SCAN_AGENT_STABLE_MS`              | `4000`              | Délai d'immobilité avant envoi — **à augmenter** si le scanner est lent ou le dossier sur un partage réseau |
| `SCAN_AGENT_MAX_ATTEMPTS`           | `5`                 | Essais avant quarantaine (pannes réseau/serveur)                                                            |
| `SCAN_AGENT_MAX_FILE_MB`            | `100`               | Taille maximale acceptée                                                                                    |

> ⚠️ **Ne pointez jamais `SCAN_AGENT_WATCH_DIR` sur la racine du coffre** (`D:\ARCHIVES`) :
> `DiskFileStore` y écrit les binaires de la GED à plat (`10.pdf`, `13.pdf`…). L'agent les
> réinjecterait dans la file §07 **et les sortirait du coffre**, rendant introuvable chaque document
> existant. Le cas est refusé au démarrage, avec le dossier à utiliser dans le message.

Le `.env` contient la clé : restreignez-le au compte qui fera tourner le service
(`icacls .env /inheritance:r /grant "SYSTEM:R" /grant "Administrateurs:F"`).

Configurez ensuite le **pilote du scanner** (NAPS2, l'utilitaire du constructeur, le dossier de
numérisation de l'imprimante…) pour écrire dans le dossier surveillé, en PDF de préférence.

## 6. Essai à la main

```bash
node dist\index.js
```

Attendu au démarrage :

```
"agent de numérisation démarré"  {watchDir, apiUrl, machineName, pollMs, auth: "clé de service"}
"accès à la file « Documents scannés » vérifié"
```

Déposez un PDF dans le dossier surveillé. En quelques secondes :

```
"scan déposé dans la file"  {fileName, mailScannedDocumentId, bytes}
```

Le fichier passe dans `_envoyes\AAAA-MM-JJ\` et la ligne apparaît sur
`http://<serveur>:5000/courriers/documents-scannes`. `Ctrl+C` pour arrêter.

## 7. Installer en service Windows (NSSM)

Même mécanique que les services du serveur (voir [deploiement-windows.md §7](deploiement-windows.md)).

`C:\DocuPro\scan-agent\run-scan-agent.cmd`

```bat
@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"
for /f "usebackq eol=# tokens=1,* delims==" %%a in (".env") do (
  set "val=%%b"
  set "val=!val:"=!"
  set "%%a=!val!"
)
set "NODE_ENV=production"
node dist\index.js
```

PowerShell **en administrateur** :

```powershell
$nssm  = "C:\tools\nssm.exe"
$agent = "C:\DocuPro\scan-agent"
New-Item -ItemType Directory -Force "$agent\logs" | Out-Null

& $nssm install DocuPro-ScanAgent "$agent\run-scan-agent.cmd"
& $nssm set DocuPro-ScanAgent AppDirectory  $agent
& $nssm set DocuPro-ScanAgent AppStdout     "$agent\logs\scan-agent.log"
& $nssm set DocuPro-ScanAgent AppStderr     "$agent\logs\scan-agent.err.log"
& $nssm set DocuPro-ScanAgent AppRotateFiles 1
& $nssm set DocuPro-ScanAgent Start SERVICE_AUTO_START

Start-Service DocuPro-ScanAgent
Get-Service   DocuPro-ScanAgent
```

> Si `SCAN_AGENT_WATCH_DIR` est un **partage réseau** (`\\serveur\scans`), le compte `LocalSystem`
> par défaut n'y aura pas accès : faites tourner le service sous un compte de domaine
> (`& $nssm set DocuPro-ScanAgent ObjectName "DOMAINE\compte" "motdepasse"`).

Testez un **redémarrage** du poste : sans rien lancer, un PDF déposé dans le dossier doit remonter
dans l'écran §07.

## 8. Exploitation

| Symptôme                                | Cause probable                                                           | Correctif                                                        |
| --------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| `clé de service refusée` au démarrage   | clé différente des deux côtés, ou API pas redémarrée après le changement | réaligner les deux `.env`, redémarrer l'**API** puis l'agent     |
| `API injoignable`, l'agent réessaie     | serveur arrêté, pare-feu, mauvais `SCAN_AGENT_API_URL`                   | rien à faire côté fichiers : ils partent dès le retour de l'API  |
| Fichier resté dans le dossier surveillé | extension non acceptée, ou fichier encore en écriture                    | vérifier l'extension ; augmenter `SCAN_AGENT_STABLE_MS`          |
| Fichier dans `_erreurs\`                | lire le `.motif.txt` à côté                                              | corriger, puis **remettre le fichier dans le dossier surveillé** |
| PDF tronqué côté serveur                | `SCAN_AGENT_STABLE_MS` trop court pour ce scanner                        | passer à 10 000 ms et réessayer                                  |

Le dossier masqué `_envoyes\` grossit indéfiniment : c'est voulu (trace locale). Purgez-le
périodiquement, les binaires sont déjà sur le serveur — par exemple, supprimer au-delà de 90 jours :

```powershell
Get-ChildItem "D:\scans-entrants\_envoyes" -Directory -Force |
  Where-Object { $_.Name -lt (Get-Date).AddDays(-90).ToString('yyyy-MM-dd') } |
  Remove-Item -Recurse -Force
```

> Le `-Force` est indispensable dans ces commandes : sans lui, PowerShell saute les dossiers
> masqués et la purge ne trouve rien.

## 9. Ce que l'agent ne fait pas

- **Il ne pilote pas le scanner** (pas de TWAIN/ESCL/NAPS2, contrairement au `ScanDocument` du
  source) : c'est le pilote constructeur qui numérise, l'agent ne fait que relayer le fichier.
- **Il ne crée ni courrier ni document GED** : le dépôt reste en attente jusqu'à l'action
  « Enregistrer » de l'écran §07, qui crée le `Mail` et promeut le scan en `Document` (§05).
- **Il ne supprime rien**, ni en local (`_envoyes`) ni sur le serveur.
