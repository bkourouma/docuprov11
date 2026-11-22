# @archivage/e2e — tests de bout en bout (Playwright)

Une commande monte une pile complète et hermétique (PostgreSQL jetable, Redis, API NestJS,
worker BullMQ, web Next.js), la peuple, lance les tests Chromium, puis arrête tout.
Stratégie, périmètre et index des scénarios : [`docs/e2e/README.md`](../../docs/e2e/README.md).

## Prérequis

- `pnpm install` à la racine (installe `@playwright/test` 1.65.1, qui utilise le Chromium
  `chromium-1255` déjà présent sous `%LOCALAPPDATA%\ms-playwright` ; ailleurs :
  `pnpm --filter @archivage/e2e exec playwright install chromium`).
- Docker Desktop démarré (`docker info` répond) : PostgreSQL (image `pgvector/pgvector:pg17`) et
  Redis (`redis:7-alpine`, conteneur partagé `docupro-e2e-redis` sur 127.0.0.1:6399) y tournent.
  Les deux images sont déjà présentes sur la machine de développement.
- Aucun `.env` n'est nécessaire (ni lu) : la pile fabrique son propre environnement.

## Commandes

Depuis la racine du dépôt (ou `pnpm --filter @archivage/e2e <script>`) :

| But | Commande |
| --- | --- |
| Suite complète (monte, teste, arrête) | `pnpm e2e` |
| Un dossier | `pnpm e2e tests/smoke` |
| Un fichier | `pnpm e2e tests/smoke/auth.spec.ts` |
| Un test (par titre) | `pnpm e2e -g "SMK-02"` |
| Un test (par ligne) | `pnpm e2e tests/smoke/auth.spec.ts:20` |
| Débogage pas à pas (inspecteur) | `pnpm e2e tests/smoke/auth.spec.ts --debug` |
| Navigateur visible | `pnpm e2e --headed --workers=1` |
| Mode UI de Playwright | `pnpm e2e --ui` |
| Trace systématique | `pnpm e2e --trace on` puis `pnpm --filter @archivage/e2e exec playwright show-trace test-results/<test>/trace.zip` |
| Rapport HTML du dernier lancement | `pnpm --filter @archivage/e2e e2e:report` |
| Builds seuls de la pile (préchauffe, sans base ni démarrage) | `pnpm --filter @archivage/e2e e2e:build` |
| Typecheck + lint du paquet | `pnpm --filter @archivage/e2e lint` |

Les arguments après `pnpm e2e` sont passés à `playwright test`. En cas d'échec, la trace, la
capture d'écran et le contexte d'erreur sont dans `apps/e2e/test-results/<test>/` (trace gardée en
cas d'échec seulement).

### Garder la pile montée entre deux lancements (boucle rapide)

```powershell
pnpm --filter @archivage/e2e e2e:up        # monte la pile et rend la main (processus détachés)
pnpm e2e tests/courriers                    # réutilise la pile : démarre en quelques secondes
pnpm e2e tests/courriers -g COU-04          # … autant de fois que voulu
pnpm --filter @archivage/e2e e2e:status     # état des services, PID, journaux
pnpm --filter @archivage/e2e e2e:down       # arrête tout (services + PostgreSQL)
```

Une pile montée par `e2e:up` n'est jamais arrêtée par le teardown de Playwright. Une pile montée
par `pnpm e2e` l'est, sauf avec `E2E_KEEP_STACK=1`. Sur une pile réutilisée, la base n'est PAS
remise à zéro (seuls l'administrateur, le storageState et les seeds de module sont rejoués) :
`e2e:up --fresh` remonte de zéro.

### Relancer après un correctif de code

| Code corrigé | Commande | Durée indicative |
| --- | --- | --- |
| API (`apps/api`, paquets qu'elle importe) | `pnpm --filter @archivage/e2e e2e:restart api` | voir « Mesures » |
| Worker (`apps/worker`) | `pnpm --filter @archivage/e2e e2e:restart worker` | idem |
| Web (`apps/web`, `packages/ui`…), pile en prod | `pnpm --filter @archivage/e2e e2e:restart web` (rebuild Next) | idem |
| Web, pile en dev (`E2E_WEB_MODE=dev`) | rien : rechargement à chaud | immédiat |
| `packages/db/prisma` (seed, SQL) | `pnpm --filter @archivage/e2e e2e:up --fresh` (base modèle reconstruite) | ≈ 1 à 2 min de plus |

`restart` reconstruit (turbo pour l'API et le worker, `next build` pour le web, seulement si les
sources ont changé) puis redémarre le seul processus visé ; la base est conservée. Pour corriger
du code web en boucle, monter la pile en dev : `E2E_WEB_MODE=dev pnpm --filter @archivage/e2e e2e:up`
(les pages se compilent à leur première visite : premier passage plus lent, ensuite immédiat).

## Variables d'environnement

| Variable | Défaut (lot 0) | Rôle |
| --- | --- | --- |
| `E2E_API_PORT` | `6100` | port de l'API |
| `E2E_WEB_PORT` | `6200` | port du web (et clé de la pile : `.tmp/stack-<port>`, `.auth/stack-<port>`) |
| `E2E_PG_PORT` | `6300` | port du PostgreSQL jetable (conteneur `docupro-e2e-pg-<port>`) |
| `E2E_REDIS_URL` | `redis://127.0.0.1:6399/0` | base Redis de la pile (vidée à chaque montage neuf, `FLUSHDB` seulement) |
| `E2E_DATABASE_URL` | — | base déjà fournie (CI) : ni conteneur, ni DROP ; migrations + seeds idempotents |
| `E2E_PG_MODE` | `docker` | `local` : cluster `initdb` sous `.tmp/pg-<port>` avec les binaires de `E2E_PG_BIN` (exige pgvector) |
| `E2E_PG_BIN` | `D:/Program Files/PostgreSQL/18/bin` | binaires du mode `local` |
| `E2E_PG_IMAGE` | `pgvector/pgvector:pg17` | image du mode `docker` |
| `E2E_WEB_MODE` | `prod` | `prod` : `next build` + `next start` ; `dev` : `next dev --turbopack` |
| `E2E_WEB_REBUILD` | — | `1` : force le `next build` |
| `E2E_KEEP_STACK` | — | `1` : le teardown laisse la pile montée |
| `E2E_WORKERS` | `4` | nombre de workers Playwright |
| `CI` | — | `retries: 1`, `forbidOnly` |

Ports attribués par lot :

| Lot | API | Web | PostgreSQL | Redis |
| --- | --- | --- | --- | --- |
| 0 | 6100 | 6200 | 6300 | `/0` |
| 1 courriers | 6110 | 6210 | 6310 | `/1` |
| 2 archives | 6120 | 6220 | 6320 | `/2` |
| 3 GED | 6130 | 6230 | 6330 | `/3` |
| 4 workflows | 6140 | 6240 | 6340 | `/4` |
| 5 socle | 6150 | 6250 | 6350 | `/5` |
| intégration | 6170 | 6270 | 6370 | `/7` |

Exemple (PowerShell) :

```powershell
$env:E2E_API_PORT=6110; $env:E2E_WEB_PORT=6210; $env:E2E_PG_PORT=6310; $env:E2E_REDIS_URL='redis://127.0.0.1:6399/1'
pnpm e2e tests/courriers
```

## API des fixtures (version définitive)

```ts
import { test, expect } from '../../fixtures'; // depuis apps/e2e/tests/<module>/x.spec.ts
```

Fixtures de test :

| Fixture | Type | Rôle |
| --- | --- | --- |
| `page` | `Page` | déjà connectée en administrateur (storageState du global setup, jeton dans `localStorage.token`) |
| `api` | `ApiClient` | client REST administrateur, propre au test |
| `loginAs` | `(page, username, password) => Promise<void>` | connexion par l'écran de connexion ; vide la session existante, attend la sortie de /login |
| `apiAs` | `(username, password) => Promise<ApiClient>` | client REST d'un autre utilisateur, libéré en fin de test |
| `uniq` | `(prefix?: string) => string` | identifiant unique ASCII (`COU-mh3k2x1a-4f2-1`) |

`ApiClient` (`apps/e2e/support/api-client.ts`) — `path` relatif à `/api` (`'courriers'` ou
`'/courriers'`), appelle l'API directement (`http://127.0.0.1:<E2E_API_PORT>/api/…`) :

```ts
api.get<T>(path, opts?)                 // → corps décodé (JSON, sinon texte, sinon undefined)
api.post<T>(path, body?, opts?)
api.put<T>(path, body?, opts?)
api.patch<T>(path, body?, opts?)
api.del<T>(path, opts?)
api.upload<T>(path, { field?: 'file', file: 'chemin/sur/disque.pdf' | { name, mimeType, buffer }, fields?: { … } }, opts?)
// opts : { query?: Record<string, scalaire | scalaire[]>, headers?: Record<string,string>, timeout?: ms }
// statut >= 400 → lève ApiError { method, path, status, body } avec un message lisible
api.raw.get / post / put / patch / del / upload   // mêmes signatures, renvoient l'APIResponse Playwright sans lever
api.token, api.baseURL, api.dispose()
```

Exports utiles de `fixtures/index.ts` : `test`, `expect`, `uniq`, `loginAs`, `apiAs` (version hors
fixture : appeler `dispose()` soi-même), `ADMIN_USER`, `ADMIN_PASSWORD`, `ApiError`, types
`ApiClient`, `RawApi`, `RequestOptions`, `UploadSpec`, `UploadFile`, `GlobalSeedContext`.
`support/index.ts` exporte en plus `createApiClient({ token?, apiURL? })` (client anonyme sans
jeton : tests de 401) et `loginApi(username, password)` (renvoie le jeton).

Exemples :

```ts
test('COU-07 refus sans permission', async ({ api, apiAs, uniq }) => {
  const login = uniq('agent');
  await api.post('users', { username: login, password: 'secret12', /* … */ });
  const agent = await apiAs(login, 'secret12');
  expect((await agent.raw.get('admin/roles')).status()).toBe(403);
});

test('ARC-03 dépôt d’un lot', async ({ api }) => {
  await api.upload('acquisition/batches', { file: path.join(__dirname, '_helpers/lot.pdf'), fields: { categoryId: 1 } });
});

test.describe('profil agent', () => {
  test.use({ storageState: { cookies: [], origins: [] } }); // page non connectée
  test('SOC-02 …', async ({ page, loginAs }) => { await loginAs(page, 'agent', 'secret12'); });
});
```

Seed de module (optionnel) — `tests/<module>/_helpers/global-seed.ts`, exécuté par le global setup
après le socle, à chaque lancement (donc **idempotent**) :

```ts
import type { GlobalSeedContext } from '../../../support';
export default async function seed({ api }: GlobalSeedContext): Promise<void> {
  // ex. créer un utilisateur de test s'il n'existe pas
}
```

Administrateur : `ADMIN_USER = 'admin'`, `ADMIN_PASSWORD = 'E2e-Admin-2026'` (le global setup
change le `admin1234` du seed, ce qui lève le changement de mot de passe forcé). Il est
`isAdmin`, membre du groupe « Administrateurs » (groupe par défaut) et porte le rôle système
« Admin système » (toutes les permissions de menu).

Points que les lots modules peuvent tenir pour acquis :

- `api.raw.<verbe>` (y compris `api.raw.upload`) renvoie l'`APIResponse` de Playwright
  (`status()`, `json()`, `text()`, `body()`, `headers()`), sans jamais lever ;
- le client rendu par `apiAs()` est un `ApiClient` complet, `raw` compris ;
- le fichier d'`upload` est soit un chemin, soit `{ name, mimeType, buffer }` ;
- `loginAs` efface d'abord `localStorage['token']` (là où le web garde le jeton) ;
- les specs peuvent vivre dans des sous-dossiers (`tests/ged/espaces/x.spec.ts`, import
  `../../../fixtures`) : `testDir: './tests'` est parcouru récursivement ; le glob des seeds reste
  `tests/*/_helpers/global-seed.ts` (un seul niveau) ;
- `process.env.E2E_WORKER` et `process.env.E2E_CONNECTOR_FS_ROOT` sont posés par le global setup ;
  `process.env.E2E_API_URL` (`http://127.0.0.1:<port>/api`) et `process.env.E2E_BASE_URL`
  (origine du web) par `playwright.config.ts`.
- **Compte à mot de passe à changer (`mustChangePwd`)** : ni `loginAs` ni `apiAs` ne s'en
  occupent, et ils n'en ont pas besoin aujourd'hui : l'API délivre le jeton et ne bloque aucune
  route sur ce drapeau, l'écran de connexion mène à /dashboards (seul « Mon profil » affiche une
  alerte). Un test qui veut un compte « propre » le lève lui-même par l'API :
  `await (await apiAs(u, p)).post('auth/change-password', { currentPassword: p, newPassword: p2 })`.

### Specs qui modifient un état global : `*.global.spec.ts`

Un test qui change un réglage global de la pile (arrêt d'urgence des workflows, plafond global…)
fausserait les tests qui tournent en parallèle. Nommez son fichier `<nom>.global.spec.ts` : il est
exclu du projet principal `chromium` et tourne dans le projet `etat-global`, avec un seul worker,
APRÈS le projet principal (`dependencies`). Il doit remettre l'état global comme il l'a trouvé
(`afterAll`/`finally`). Conséquences : si un test du projet principal échoue, `etat-global` est
sauté (règle de Playwright) ; pour lancer un seul de ces fichiers sans rejouer toute la suite
principale : `pnpm e2e tests/workflows/arret.global.spec.ts --no-deps` (ou
`--project=etat-global --no-deps`).

## Environnement de la pile (vu par les tests)

Valeurs de test en clair dans `support/env.ts` et `support/stack/services.ts`, aucune vraie clé :

| Sujet | Valeur dans la pile |
| --- | --- |
| IA | désactivée : ni `OPENAI_API_KEY` ni `GED_AI_*` ; seule la ligne `ged_ai_setting` posée par la migration (IA désactivée) existe, aucun seed IA |
| Connecteurs GED | `GED_CONNECTOR_KEY` = clé de test 32 octets base64 ; `GED_CONNECTOR_FS_ROOTS` = `.tmp/stack-<webPort>/connector-fs` (hors `ARCHIVES_PATH`, vidé à chaque montage neuf), exposé aux tests par `process.env.E2E_CONNECTOR_FS_ROOT` (et `CONNECTOR_FS_ROOT` de `support/`) ; aucune variable `GED_GOOGLE_*` / `GED_MS_*` |
| Collaboration temps réel | `API_INTERNAL_URL=http://127.0.0.1:<E2E_API_PORT>` au build ET au démarrage du web ; `NEXT_PUBLIC_COLLAB_WS_URL` absente (URL déduite de la page) ; `CORS_ORIGIN` absent, donc l'upgrade WebSocket accepte toute origine (s'il était posé, il devrait valoir exactement l'origine web, sinon 403) |
| Worker | `process.env.E2E_WORKER === '1'` dans les tests : le worker BullMQ de la pile tourne (sa ligne `Worker booted` est attendue au montage) |
| E-mail | `SMTP_HOST` vide : canal e-mail désactivé |
| `NODE_ENV` | `production` pour l'API et le worker |

Paquets du workspace (`packages/*`, dont `packages/connectors`) : `turbo run build
--filter=@archivage/api --filter=@archivage/worker` reconstruit aussi leurs dépendances
(`dependsOn: ["^build"]`), à chaque montage et à chaque `restart`. Après un correctif dans un
paquet : `pnpm --filter @archivage/e2e e2e:restart api` (ou `worker`, ou `all` si les deux
l'importent) ; si le paquet est importé par le web (`packages/ui`, `types`, `editor`, `mailer`) :
`e2e:restart web` (l'empreinte du build web couvre ces paquets).

## Ce que fait le montage

1. En parallèle : PostgreSQL (conteneur `docupro-e2e-pg-<port>`, volume du même nom), Redis
   (`FLUSHDB` de la base de la pile), build API + worker (`turbo run build`, cache), build web
   (`next build` dans `apps/web/.next-e2e-<webPort>`, seulement si les sources ou l'URL de l'API
   ont changé : Next 15 fige les rewrites `/api` au build).
2. Base neuve `docupro_e2e` clonée de la base modèle `docupro_e2e_tpl` ; celle-ci n'est
   reconstruite (migrate deploy + `prisma/sql/analytics.sql` + seeds de référence) que si
   `packages/db/prisma` a changé.
3. API (`node apps/api/dist/main.js`), worker (`node apps/worker/dist/index.js`) et web
   (`next start`) lancés directement par `node`, détachés, journaux dans
   `apps/e2e/.tmp/stack-<webPort>/logs/`. Attente : `GET /api/health` (API), ligne
   `Worker booted` (worker), `/login` et `/api/health` à travers le proxy du web.
4. Administrateur rendu utilisable, storageState écrit (`.auth/stack-<webPort>/admin.json`), seeds
   de module.

Arrêt : `taskkill /PID <pid> /T /F` sur les seuls PID de `state.json`, après vérification que leur
ligne de commande contient bien le chemin de la copie de travail (jamais d'arrêt par nom), puis
`docker stop` du conteneur PostgreSQL. `pnpm --filter @archivage/e2e exec tsx support/cli.ts procs`
liste les processus restants de la copie de travail.

## Mesures (machine de développement, 28 cœurs)

Relevées le 2026-11-22, machine chargée par d'autres piles et builds (les durées varient du simple
au double selon la charge) :

| Étape | Durée |
| --- | --- |
| Montage à froid (web jamais construit, base modèle à créer) | ≈ 5 min (dont `next build` ≈ 3 min 45, base modèle ≈ 35 s à 2 min) |
| Montage à chaud (rien n'a changé : builds en cache, base clonée) | ≈ 2 min (démarrage API ≈ 40 à 90 s) |
| `pnpm e2e tests/smoke` sur une pile gardée montée | ≈ 30 s à vide, ≈ 2 min sous charge |
| `pnpm e2e tests/smoke` complet (monte, teste, arrête) | ≈ 3 min 30 |
| `e2e:restart api` (build turbo + redémarrage) | ≈ 1 min |
| `e2e:restart web` sans changement / avec `next build` | ≈ 30 s / ≈ 4 min |
| `e2e:down` | ≈ 30 s |

Boucle conseillée pour un lot module : `e2e:up` une fois, puis `pnpm e2e tests/<module>` ; après un
correctif API, `e2e:restart api` (≈ 1 min) ; pour corriger du code web en boucle, une pile en
`E2E_WEB_MODE=dev`.

## Pièges connus

- **pgvector obligatoire.** La migration `20261120120000_add_ged_ia_foundations` exécute
  `CREATE EXTENSION vector` : le PostgreSQL 18 installé sur la machine ne l'a pas, d'où le mode
  `docker` par défaut (image pgvector). `E2E_PG_MODE=local` échoue avec un message explicite.
- **Pas de `prisma db push`.** Après `migrate deploy`, l'écart restant avec le schéma Prisma est
  minime (actions ON DELETE de quelques clés étrangères, index HNSW posé en SQL brut) ; `db push`
  supprimerait l'index HNSW de `ged_chunk`. La procédure de `docs/deploiement-windows.md` §3.B
  (push) date d'avant l'arrivée de `analytics_target` dans les migrations.
- **Port 5000.** Pris par un processus système sur la machine : `ensure-single-dev.mjs` et
  `ensure-no-dev.mjs` lisent désormais `ARCHIVAGE_WEB_PORT` (défaut 5000). La pile E2E ne passe
  pas par ces scripts : elle lance `next` directement, avec son propre dossier de sortie
  (`ARCHIVAGE_WEB_DIST_DIR`, lu par `next.config.mjs`), ce qui ne touche jamais au `.next` du
  développeur.
- **Fichiers suivis réécrits par Next.** Avec un dossier de sortie autre que `.next`, `next build`
  et `next dev` réécrivent `apps/web/next-env.d.ts` et `apps/web/tsconfig.json`, et
  `copy-pdfjs-assets` réécrit les LICENSE de `public/pdfjs` : la pile les remet octet pour octet
  (date comprise) après chaque build et démarrage. Si un arrêt brutal en laisse un modifié :
  `git checkout -- apps/web/next-env.d.ts apps/web/tsconfig.json apps/web/public/pdfjs`.
- **Pourquoi un `next build` ?** Le journal `build-web.log` (et la console) donne les fichiers
  modifiés qui l'ont déclenché. La vérification de types du build est sautée
  (`ARCHIVAGE_WEB_SKIP_TYPECHECK=1`, lu par `next.config.mjs`) : le typage reste vérifié par le
  build et le lint du web.
- **Rewrites figés au build.** En mode prod, changer `E2E_API_PORT` impose un `next build` (fait
  automatiquement : l'URL de l'API entre dans l'empreinte du build).
- **Client Prisma.** Généré seulement s'il manque : sous Windows, la DLL du moteur est verrouillée
  tant qu'une API tourne, `prisma generate` échouerait.
- **`NODE_ENV=production`** pour l'API et le worker : `test` désactiverait le consommateur
  d'événements Docu-Flow et les purges planifiées de l'assistant.
- **Base non remise à zéro sur une pile réutilisée** : les tests doivent créer leurs données avec
  `uniq()` et ne jamais compter sur une base vide.
- **`getByRole('alert')` ambigu** : Next pose sur chaque page un `role="alert"` vide
  (`#__next-route-announcer__`). Filtrer : `getByRole('alert').filter({ hasText: '…' })`.
- **Docker Desktop redémarré** : la pile perd PostgreSQL et Redis (journaux du worker pleins de
  `ECONNRESET`). `e2e:down` puis remonter ; le conteneur Redis a `--restart unless-stopped`.
- **Démarrage de l'API ≈ 40 s** à froid (chargement des modules Nest sous Windows) : c'est l'étape
  la plus longue d'un `restart api`.
- **`networkidle`** : utilisable sur les pages actuelles, mais une page qui interroge l'API en
  continu (moins de 500 ms entre deux requêtes) ne l'atteindrait jamais ; préférer l'attente d'un
  élément ou d'une réponse précise.
