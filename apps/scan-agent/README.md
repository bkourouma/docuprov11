# @archivage/scan-agent

Agent de numérisation à installer **sur le poste de scan**. Il surveille un dossier local et dépose
chaque fichier terminé dans la file « Documents scannés » (§07) via
`POST /api/courriers/documents-scannes`.

Remplaçant du service Windows de numérisation du source (§01.5.1). Aucun accès base ni disque
serveur : uniquement HTTP + une **clé de service** (`SCAN_AGENT_API_KEY`, en-tête `X-Api-Key`),
posée une fois à l'installation. Pas de compte utilisateur, pas de mot de passe qui expire.

> **Installation, configuration, service Windows, dépannage → [`docs/agent-scan-poste.md`](../../docs/agent-scan-poste.md).**

## Développement

```bash
pnpm --filter @archivage/scan-agent test        # 33 tests
pnpm --filter @archivage/scan-agent build
pnpm --filter @archivage/scan-agent start:dev   # tsx watch, lit le .env local
```

Le script s'appelle `start:dev` et non `dev` **volontairement** : `pnpm dev` à la racine lance
`turbo run dev` sur tout le monorepo, et l'agent se mettrait alors à téléverser le contenu du
dossier surveillé à chaque session de développement.

## Carte du code

| Fichier             | Rôle                                                                                                       |
| ------------------- | ---------------------------------------------------------------------------------------------------------- |
| `src/index.ts`      | Boucle de service : vérification d'accès au démarrage, cycles séquentiels, arrêt propre sur SIGINT/SIGTERM |
| `src/watcher.ts`    | Un cycle : balayage, envoi, classement dans `_envoyes` / `_erreurs`                                        |
| `src/candidates.ts` | Extensions acceptées (miroir de l'API) et détection de fin d'écriture                                      |
| `src/api-client.ts` | Clé de service ou JWT (renouvelé sur 401), envoi multipart, tri rejouable / définitif                      |
| `src/dispatch.ts`   | Nommage des dossiers de classement et anti-collision                                                       |
| `src/config/env.ts` | Contrat `SCAN_AGENT_*`, validé au démarrage                                                                |

## Invariants

- Un fichier envoyé quitte le dossier surveillé : **jamais deux dépôts pour un même scan**.
- Un fichier refusé n'est jamais supprimé : il part en quarantaine avec son motif.
- Les dossiers de service (`_envoyes`, `_erreurs`) sont masqués : le dossier surveillé ne montre que
  les scans en attente. Masquage cosmétique et best-effort — l'agent se comporte à l'identique s'il
  échoue.
- Un problème de compte (401/403) **n'écarte aucun fichier** — le cycle s'interrompt, tout reste en
  place et repart après correction du rôle.
- Le dossier surveillé n'est **jamais** la racine d'`ARCHIVES_PATH` : `DiskFileStore` y écrit les
  binaires de la GED à plat, l'agent les sortirait du coffre. Refusé au démarrage par
  `resolveWatchDir`.
- La liste des extensions doit rester alignée sur `ACCEPTED_EXTENSIONS` de
  `apps/api/src/modules/courriers/mail-scanned.service.ts`.
