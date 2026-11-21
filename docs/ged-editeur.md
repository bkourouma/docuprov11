# Éditeur natif collaboratif (lot 4b)

Ce document décrit le code livré par le lot 4b : édition à plusieurs en temps réel, versions, commentaires, mentions, import et export DOCX. Il a été rédigé en lisant le code et les tests. Ce qui n'a pas pu être vérifié (navigateur, relais nginx, charge) est signalé explicitement.

La rédaction assistée par l'IA (lot 4c : modèles, panneau « Rédiger avec l'IA ») est décrite dans `docs/ged-redaction.md`. Ce document ne la reprend pas.

Principe : le serveur est l'autorité. Droits, taille, débit et structure du contenu sont contrôlés côté serveur. Le masquage des boutons côté web (lecture seule, bandeaux) n'est qu'ergonomique (`apps/web/app/components/editeur/EditorShell.tsx`, commentaire de `EditorShell`).

## 1. Fichiers

| Zone | Fichiers |
| --- | --- |
| Contrat du module | `apps/api/src/modules/collab/collab.contracts.ts` |
| Module Nest | `apps/api/src/modules/collab/collab.module.ts` |
| Serveur temps réel | `server/collab-server.service.ts`, `server/collab-server.options.ts`, `server/collab-protocol.ts`, `server/collab-client-ip.ts`, `server/collab-rate-limiter.ts`, `server/collab-room-identity.ts`, `server/collab-structure-guard.ts`, `server/collab-update-guard.ts` |
| Accès | `access/collab-access.service.ts` |
| API REST | `documents/collab-documents.controller.ts`, `documents/collab-documents.service.ts`, `documents/collab-documents.dto.ts` |
| Persistance | `persistence/collab-persistence.service.ts`, `persistence/collab-working-state.ts`, `persistence/collab-mentions-registry.ts`, `persistence/keyed-mutex.ts` |
| Éditeur partagé (navigateur et serveur) | `packages/editor/src/` : `schema.ts`, `structure.ts`, `sanitize.ts`, `ydoc.ts`, `comments.ts`, `content.ts`, `constants.ts`, `index.ts` (entrée isomorphe), `server.ts` (entrée serveur) |
| DOCX | `packages/editor/src/docx-import.ts`, `packages/editor/src/docx-export.ts` |
| Types partagés | `packages/types/src/ged-collab.ts` (extension `.ydoc`, extension `.html`, chemin `/api/collab`, DTO) |
| Web | `apps/web/app/components/editeur/` (`EditorShell.tsx`, `EditorToolbar.tsx`, `CommentsPanel.tsx`, `VersionHistoryPanel.tsx`, `mention-suggestion.ts`, CSS modules ; `DraftingPanel.tsx` relève du lot 4c), `apps/web/app/lib/editeur.ts` |
| Pages | `apps/web/app/editeur/[documentId]/page.tsx`, `apps/web/app/editeur/nouveau/page.tsx` |

Les tests sont dans les fichiers `*.spec.ts` de ces dossiers, ainsi que `apps/web/app/lib/editeur.test.ts`.

## 2. Architecture temps réel

- Le serveur temps réel est Hocuspocus 4.9 (`@hocuspocus/server` côté API, `@hocuspocus/provider` côté web). Il n'a pas de processus propre : il est greffé sur le serveur HTTP de Nest. `CollabServerService.onApplicationBootstrap` récupère ce serveur via `HttpAdapterHost` puis appelle `attach` (`collab-server.service.ts:300-321`). L'écouteur `upgrade` ne traite que le chemin exact `/api/collab` (`COLLAB_WS_PATH`, `collab.contracts.ts:11`). Les autres chemins reçoivent un 404 si ce service est le seul écouteur `upgrade` (`:526-531`).
- Le serveur WebSocket `ws` fonctionne en `noServer` avec `perMessageDeflate` désactivé et `maxPayload` = 1 Mio + 64 Kio (`:262-267`).
- Les routes REST (`/api/collab/documents…`) sont des requêtes HTTP ordinaires, distinctes de l'upgrade.
- Côté web, `EditorSession` crée un `HocuspocusProvider` dont le `name` est l'identifiant du document en décimal (`EditorShell.tsx`, création du provider). L'URL vient de `NEXT_PUBLIC_COLLAB_WS_URL` si elle est définie, sinon de `deriveWsUrl` (`apps/web/app/lib/editeur.ts`) : même hôte que la page, `ws://` ou `wss://` selon `http:` ou `https:`, chemin `wsPath` renvoyé par la session.
- Le jeton est fourni par une fonction (`token: () => readToken()`), relue à chaque (re)connexion, et voyage dans le protocole. Un paramètre d'URL nommé `token`, `access_token`, `accesstoken`, `jwt`, `auth`, `authorization` ou `bearer` fait refuser l'upgrade en 400 (`collab-server.service.ts:536-540`, `collab-protocol.ts`, `urlCarriesToken`).
- Une connexion socket ne peut porter qu'une salle : le premier message fixe la clé d'adressage, un message vers une autre salle ferme la connexion en 4409 (`:670-680`).

### Point d'attention : relais de l'upgrade

Les rewrites Next.js (`apps/web/next.config.mjs:13-16`, `/api/:path*` vers l'API) sont déclarés en HTTP. Aucun code de `apps/web` ne traite l'événement `upgrade`. La capacité de Next à relayer un upgrade WebSocket n'a pas été vérifiée. Le serveur WebSocket doit donc être atteint directement : par un reverse proxy qui envoie `/api/collab` à l'API, ou par `NEXT_PUBLIC_COLLAB_WS_URL` pointant sur l'API.

Or `infra/nginx/docupro-demo.conf` route `/api/collab` vers l'upstream web (`docupro_demo_web`, `127.0.0.1:3018`, lignes 5-6 et 39-51) avec les en-têtes d'upgrade. Cette configuration n'a pas été testée. Voir la section 14.

### Arrêt

À l'arrêt (`shutdown`, `collab-server.service.ts:324-358`) : flush des autosaves en attente, fermeture de tous les sockets en `1001` (`server-shutdown`), attente des salles pendant `shutdownTimeoutMs` (10 s), puis attente des tâches de persistance.

## 3. Authentification et droits

### 3.1 À l'ouverture de la connexion

Ordre dans `onAuthenticate` (`collab-server.service.ts:890-978`) :

1. Le socket est encore ouvert et le nom de salle est un décimal strict (`parseRoomName`, `collab-protocol.ts`).
2. Vérification du jeton par `CollabAccessService.verifyToken` (`access/collab-access.service.ts:61`) :
   - chaîne de 8192 caractères au plus ;
   - signature HS256 avec `JWT_SECRET` (même secret que l'API HTTP) ;
   - `exp` obligatoire et non échu (un jeton sans `exp` est refusé, contrairement à la stratégie HTTP) ;
   - `sub` entier strictement positif, `username` chaîne, `isAdmin` booléen, `userGroupId` null ou entier ;
   - `isScanAgent` n'est jamais lu depuis le jeton.
3. Calcul du mode par `resolveMode` (`collab-access.service.ts:99`) :
   - identifiant de document hors plage refusé ;
   - agent de numérisation refusé ;
   - `DocumentsService.canAccess` d'abord (refus = `null`) ;
   - niveau effectif : absent = refus ;
   - document gelé ou épuré = `read` ;
   - niveau >= 3 (`COLLAB_MIN_WRITE_LEVEL`) = `write`, sinon `read`.
   - Les droits d'espace ne sont jamais consultés.
4. Si le document n'est pas déjà en mémoire, chargement anticipé (`loadDocument`). `null` (document inexistant ou non texte) produit le même refus. Un état persisté dépassant `maxStateBytes` est refusé.
5. Limites de connexions, vérifiées après l'accès : 50 connexions par document et 20 par utilisateur. Dépassement : 4409 (`too-many-connections`).
6. Ouverture en écriture : une entrée d'audit `collab-open-write` est écrite à chaque ouverture en écriture. Si l'audit échoue, la connexion s'ouvre en lecture seule (`:941-956`).
7. La configuration de connexion reçoit `readOnly` (`:958`). Hocuspocus ignore alors les mises à jour de cette connexion (test « (b) lecture seule », `collab-server.service.spec.ts:637`). L'awareness reste permis, mais son identité est réécrite par le serveur.

Un refus est toujours `4401` avec la raison `unauthorized`, qu'il s'agisse d'un jeton invalide, d'un document inconnu, refusé ou non texte. Le serveur répond aussi au refus d'authentification par la raison `permission-denied` (`COLLAB_DENIED_REASON`, `:91`, `:976`). La durée d'un refus est portée à un plancher de 250 ms plus une gigue de 0 à 100 ms (`padRefusal`, `:1603-1608`) pour ne pas révéler l'existence du document. Le motif réel est journalisé sans jeton (`logRefusal`).

### 3.2 Pendant la connexion

- Balayage toutes les 15 s (`sweepIntervalMs`). `revalidateAccess` recalcule `resolveMode` pour chaque couple (document, utilisateur), au plus 16 en parallèle, un seul balayage à la fois (`:780-802`).
  - `null` (droit retiré, document devenu inaccessible) : fermeture 4401 `unauthorized` (`applyMode`, `:836-844`).
  - `write` vers `read` (document gelé ou épuré, niveau abaissé sous 3) : passage en lecture seule côté serveur, sans message au client (`:846-857`).
  - `read` vers `write` : jamais. Il faut ouvrir une nouvelle connexion (`:858`).
  - Panne de la base pendant le balayage : le mode accordé est conservé, nouvel essai au balayage suivant (`:819-824`).
- Renouvellement de jeton (`onTokenSync`, `:980-1010`) : le jeton doit appartenir au même utilisateur, l'expiration est prolongée, les droits sont recalculés selon la même règle. Un refus ferme en 4401.
- Expiration du JWT : fermeture 4401 `session-expired`, au balayage (`:746-752`) et avant chaque message (`beforeHandleMessage`, `:1024-1026`).
- Lecture seule effective : `beforeSync` ne contrôle pas les connexions en lecture seule (`:1047`) ; leurs mises à jour sont filtrées par Hocuspocus.

### 3.3 Côté web

- Le mode est lu une seule fois, depuis `GET /collab/documents/:id/session` : `readOnly = session.mode === 'read'` (`EditorShell.tsx`, `EditorCanvas`).
- Le web n'utilise ni l'événement `onAuthenticated` ni `authorizedScope` du provider (aucune occurrence dans `apps/web/app/components/editeur` ni dans `apps/web/app/lib/editeur.ts`). Le serveur, de son côté, n'envoie aucun message lors d'un passage en lecture seule (`applyMode` ne modifie que l'état serveur).
- Conséquence : une bascule en lecture seule pendant une session laisse l'éditeur modifiable jusqu'au rechargement. Les modifications sont alors ignorées par le serveur. Constat par lecture de code, non vérifié dans un navigateur (section 14).

### 3.4 Comptes désactivés

- Le chemin d'accès temps réel ne consulte pas `is_disabled`. `canAccess` et le niveau effectif ne lisent pas ce champ (recherche dans `apps/api/src/modules/documents` : aucune occurrence), et `JwtStrategy.validate` ne va pas en base. Un compte désactivé garde donc l'accès jusqu'à l'expiration du jeton (`JWT_EXPIRES_IN`, 1 jour par défaut, `apps/api/src/modules/auth/auth.module.ts:18`). Le comportement HTTP est identique.

## 4. Limites et protections

| Réglage (`DEFAULT_COLLAB_SERVER_OPTIONS`) | Valeur | Effet et refus |
| --- | --- | --- |
| `maxMessageBytes` | 1 Mio | Message plus gros : 4409 `policy-violation`. Au-delà de 1 Mio + 64 Kio, `ws` ferme lui-même en 1009. |
| `messagesPerSecond` / `messageBurst` | 60 / 240 | Dépassement : 4409 `policy-violation`. Les pings applicatifs comptent aussi (`onSocketMessage`, `:656-662`). |
| `bytesPerSecond` / `byteBurst` | 512 Kio/s / 2 Mio | La rafale est relevée à `maxMessageBytes` si elle est plus petite (`resolveCollabServerOptions`). Dépassement : 4409. |
| `authTimeoutMs` | 10 s | Pas d'authentification à temps : 4401 `unauthorized`. Filet Hocuspocus à 20 s. File avant authentification : 64 messages. |
| `idleTimeoutMs` | 60 s | Délai d'inactivité passé à Hocuspocus (`timeout`). Ping au balayage ; pas de pong au balayage suivant : socket terminé. |
| `maxConnectionsPerDocument` | 50 | 4409 `too-many-connections`, après contrôle d'accès. |
| `maxConnectionsPerUser` | 20 | 4409 `too-many-connections`, après contrôle d'accès. |
| `maxConnectionsPerIp` | 200 | Refus HTTP 429 à l'upgrade. Sans proxy de confiance, toutes les requêtes passant par le même reverse proxy partagent une adresse : la limite devient un plafond global (commentaire `collab-server.options.ts:92-96`). |
| `maxSockets` | 2000 | Refus HTTP 503 à l'upgrade. |
| `maxStateBytes` | 8 Mio (`EDITOR_LIMITS.MAX_STATE_BYTES`) | Mise à jour qui dépasserait la limite : refusée en 4409 avant application. Chargement refusé au-delà. |
| `maxStructuralUpdateBytes` | 256 Kio | Mise à jour structurelle plus grosse : 4409 `structure`, sans calcul de validation. |
| `maxStructureDepth` / `maxStructureNodes` | 64 / 100 000 | Bornes de la validation de structure (section 6). |
| `structureValidationBurstMs` / `structureValidationMsPerSecond` | 1000 ms / 500 ms par seconde | Budget de calcul de la validation par salle : une salle très sollicitée est ralentie, pas refusée. |
| `structureShadowIdleMs` | 2 min | Copie de validation libérée après cette durée sans usage. |
| `maxAwarenessClientsPerConnection` / `maxAwarenessStateBytes` | 4 / 8 Kio | Identifiants d'awareness revendiqués par connexion, taille de chaque état. |
| `refusalMinDelayMs` / `refusalJitterMs` | 250 ms / 100 ms | Plancher et gigue des refus d'accès. |
| `allowedOrigins` | `CORS_ORIGIN` | Origine de l'upgrade contrôlée si la liste n'est pas vide. Un upgrade sans en-tête `Origin` (client non navigateur) est accepté ; le jeton reste exigé. Liste vide : aucun contrôle (`:571-577`). |

Limites REST (`collab-documents.dto.ts`) : fichier DOCX 10 Mio (multer refuse au-delà avant tout traitement), libellé 500 caractères, résumé de version 2000 caractères, recherche de mention 100 caractères.

### COLLAB_SERVER_OPTIONS

`COLLAB_SERVER_OPTIONS` n'est pas une variable d'environnement. C'est un jeton d'injection Nest (`collab-server.options.ts:7`) lu en `@Optional()` par `CollabServerService` (`:244`). `CollabModule` ne le fournit pas (`collab.module.ts:21-34`). En exploitation, toutes les limites ci-dessus valent donc leurs défauts : aucun réglage par l'environnement. Seuls les tests ou un module qui fournirait ce jeton peuvent les modifier.

### COLLAB_TRUST_PROXY

- Nombre de sauts de proxy de confiance devant l'API, entier de 0 à 10 (`MAX_TRUSTED_PROXY_HOPS`, `collab-client-ip.ts`). Vide ou absent : 0.
- Valeur invalide : avertissement au démarrage et valeur 0 (`collab-server.service.ts:247-254`).
- Avec N > 0, l'adresse retenue est l'entrée située N positions depuis la droite de `X-Forwarded-For`. Ce qu'un client a forgé à gauche n'est jamais lu. Chaîne trop courte, entrée invalide ou en-tête de plus de 2048 caractères : l'en-tête est ignoré (`resolveClientIp`).
- Cette variable n'est pas déclarée dans le schéma de validation `apps/api/src/config/env.ts` : elle est lue brute, puis validée par `parseTrustProxy`.

## 5. Codes de fermeture WebSocket

Constantes : `CollabCloseCode` (`collab.contracts.ts:14-21`). Raisons : `CLOSE_REASON` (`collab-server.service.ts:92-104`). Le serveur n'envoie aucun détail sur l'existence d'un document.

| Code | Sens selon le contrat | Sens réel dans le service (raisons émises) | Comportement du web |
| --- | --- | --- | --- |
| 4401 `Unauthorized` | Authentification absente, invalide ou expirée, ou document inaccessible (volontairement identique). | Raison `unauthorized` : tous les refus d'accès, jeton, salle invalide, droit retiré au balayage ou au renouvellement, pas d'authentification dans le délai, échec de chargement, message reçu après fermeture. Raison `session-expired` : JWT échu (`:750`, `:1025`). Raison `permission-denied` : réponse au refus d'authentification (`:91`), la fermeture porte ensuite `unauthorized` (`:975`). | `session-expired` : redirection vers `/login` et jeton effacé. `unauthorized` : écran « Document inaccessible », sans reconnexion (`EditorShell.tsx`, `onClose`). |
| 4409 `PolicyViolation` | « Message trop gros / débit dépassé ». Ce commentaire est incomplet : le code utilise aussi 4409 pour les refus de structure et les limites de connexions. | Raison `policy-violation` : message non binaire, trop gros, débit dépassé, en-tête malformé, type de message interdit, deux salles sur une connexion, exception de traitement, état du document au-delà de `maxStateBytes`, salle abandonnée. Raison `too-many-connections` : limites de connexions. Raison `structure` : mise à jour Yjs à dépendances manquantes ou malformée, mise à jour structurelle trop grosse, structure non conforme (`:1055-1056`, `:1062-1063`, `:1086-1088`, `:1096-1102`, `:1117`). | Raison contenant `structure` : bandeau « Modification incompatible », éditeur figé, aucune reconnexion automatique ; seul « Recharger » relance la session. Autres raisons : bandeau « Limite de débit ou de taille atteinte », reconnexion après 5, 10, 20, 30 puis 30 s (5 tentatives), puis bouton « Reconnecter » (`LIMIT_RETRY_DELAYS_MS`, `closeAction`). |
| 4410 `Reload` | « Salle réinitialisée (restauration de version) : le client doit se reconnecter. » | Raison `reload`. Émis par `resetRoom` (restauration, `collab-documents.service.ts:289`) et par `ensureLiveStructure` (`collab-server.service.ts:471-479`) : un état vivant non conforme, détecté à la lecture, à la sauvegarde ou au déchargement, ramène la salle au dernier état persisté. Ce second cas n'est pas une restauration, et le commentaire du contrat ne le dit pas. | `reset` : nouvelle session chargée et nouveau `Y.Doc` immédiatement (`EditorShell.tsx`, `docRecreation`). |
| 1001 (standard) | Non défini dans le contrat. | Raison `server-shutdown` à l'arrêt du serveur (`:337`). | Pas de traitement particulier (`other`). |

Refus à l'upgrade (avant le handshake WebSocket, codes HTTP) : 400 (jeton dans l'URL), 403 (origine non autorisée), 404 (autre chemin, si seul écouteur), 429 (limite par IP), 503 (arrêt en cours ou plafond global), 500 (erreur interne).

Le contrat dit « 4410 : restauration de version ». Le code l'emploie aussi pour un état vivant non conforme. Le contrat devrait être complété (`collab.contracts.ts:17-20`).

## 6. Validation de structure

Le contenu est un fragment ProseMirror (`EDITOR_FRAGMENT` = `default`). La validation a deux niveaux.

### 6.1 Validation de l'état (`packages/editor/src/structure.ts`)

`validateYDocStructure` projette le fragment en mode strict (`projectFragment`, itératif, sans récursion). Sont refusés :

- un nœud dont le nom n'est pas dans le schéma, ou un second nœud `doc` ;
- une profondeur supérieure à `maxDepth` (64 par défaut) ;
- plus de `maxNodes` nœuds (100 000 par défaut) ;
- un attribut non primitif, une chaîne de plus de 100 000 caractères, un tableau de plus de 1000 éléments ou contenant autre chose que des primitives ;
- un texte placé à un emplacement qui n'accepte pas de texte inline ;
- une marque inconnue, une marque dont les attributs ne sont pas un objet, un texte qui n'est pas une chaîne ;
- un type Yjs qui n'est ni élément ni texte dans le fragment ;
- un contenu qui ne respecte pas le modèle ProseMirror (`root.check()`).

Le mode tolérant (`ydoc.ts`, `yDocToJson`, `yDocToPlainText`) ignore les nœuds invalides et ne lève jamais : il sert à l'affichage, à l'indexation et à l'export HTML, jamais à l'acceptation d'une écriture.

### 6.2 Garde des mises à jour (`server/collab-structure-guard.ts`, `collab-server.service.ts`)

Avant application, chaque mise à jour cliente en écriture est traitée ainsi (`beforeSync`, `:1046-1074`) :

1. Dépendances (`findMissingDependency`, `collab-update-guard.ts`) : structures non contiguës, structures sautées, référence à un élément inconnu, suppression de contenu inconnu, ou mise à jour illisible. Refus, 4409 `structure`. Sans cette garde, la mise à jour resterait « en attente » et serait recopiée dans chaque état encodé.
2. Taille : la partie réellement nouvelle ne doit pas faire dépasser `maxStateBytes`. Sinon 4409 `policy-violation`.
3. Structure (`classifyUpdate`) : la frappe de texte simple (texte sans attribut ni marque dans un `Y.XmlText`, hors fragment ou dans un texte) est neutre et non validée. Tout le reste est structurel : nouvel élément, attribut, marque, suppression de nœud. Une mise à jour structurelle est validée sur une copie miroir de la salle, jamais sur la salle vivante. Une validation à la fois par salle (verrou tenu jusqu'à l'application, libéré au plus tard après 5 s). Budget de calcul par salle (section 4). Si la validation échoue : refus, 4409 `structure`, la mise à jour n'est ni appliquée, ni diffusée, ni persistée.
4. Après application, filet : une mise à jour qui aurait laissé des structures en attente est écartée et la connexion fermée en 4409 `structure` (`afterHandleMessage`, `:1112-1118`).

Au-delà de 20 000 structures dans une mise à jour, ou de 20 000 suppressions à examiner, la mise à jour est traitée comme structurelle sans détail.

### 6.3 Chargement et mutation serveur

- Un état persisté qui ne passe pas la validation n'est pas chargé : `onLoadDocument` lève une erreur et la connexion reçoit 4401. Rien n'est écrit (ni autosave, ni version). Au moment de la lecture par la persistance, `loadDocument` lève `InvalidCollabStateException` (422, message générique) (`collab-persistence.service.ts:267-272`).
- Une mutation serveur (import DOCX dans une salle ouverte, `mutateDocument`) est projetée sur une copie jetable : taille et structure sont vérifiées avant d'être appliquée à la salle (`project`, `:385-452`). Un résultat non conforme ne touche pas la salle.

## 7. Persistance et versions

### 7.1 Stockage

| Donnée | Emplacement | Détail |
| --- | --- | --- |
| Pièces d'une version | Coffre disque `ARCHIVES_PATH` (`DiskFileStore`) | `.ydoc` (état Yjs complet, `sortOrder` 0) et `.html` (instantané HTML assaini, `sortOrder` 1). Empreinte SHA-256 en base (`document_file.hash`). |
| Lignes de version | Base | `document_version` (version courante = `is_current`), `document_file`, `ged_version_info` (type de changement, résumé, empreinte de contenu). |
| État de travail (autosave) | `ARCHIVES_PATH/collab/<id>.bin` et `<id>.json` | Hors base, écriture atomique. Les métadonnées portent la version de base, la taille et l'empreinte. |
| Registre des mentions notifiées | `ARCHIVES_PATH/collab/<id>.mentions.json` | Côté serveur, hors Y.Doc. 5000 identifiants au plus, 128 Kio au plus (`collab-mentions-registry.ts:7-10`). |

Au chargement (`loadDocument`, `:225-282`), l'état de travail est utilisé seulement s'il dérive de la version courante, s'il est décodable et s'il passe la validation. Sinon, on lit le `.ydoc` de la version courante, dont la taille, l'empreinte et la structure sont contrôlées. Le fichier n'est jamais réparé automatiquement.

### 7.2 Autosave

- Hocuspocus déclenche `onStoreDocument` après 2 s sans modification (`storeDebounceMs`) et au plus 10 s après le premier changement (`storeMaxDebounceMs`) (`collab-server.service.ts:275-276`).
- `storeRoom` (`:1320-1365`) valide l'état vivant, l'encode et écrit l'état de travail via `saveWorkingState`. Aucune version n'est créée par l'autosave, sauf la version « idle » décrite plus bas.
- En cas d'échec d'écriture, la salle reste en mémoire (`unsaved`). Le balayage relance le déchargement, et `beforeUnload` retente l'écriture (`:1381-1418`). Une salle n'est jamais déchargée sans sauvegarde réussie.
- Les déchargements sont immédiats à la dernière déconnexion (`unloadImmediately`, `:277`).

### 7.3 Quand une version est créée

| Raison (`CollabVersionReason`) | Déclencheur | Résumé par défaut |
| --- | --- | --- |
| `manual` | `POST /collab/documents/:id/versions` (bouton « Enregistrer une version ») | « Enregistrement manuel », ou le résumé saisi |
| `manual` (« Avant restauration ») | `POST /collab/documents/:id/restore`, avant la restauration, sans bloquer si elle échoue (`collab-documents.service.ts:274-283`) | « Avant restauration » |
| `idle` | Autosave validé, salle modifiée par un utilisateur, et au moins 10 min depuis l'ouverture de la salle ou depuis la dernière tentative « idle » (`idleVersionIntervalMs`, `lastVersionAt`, `:1253` et `:1349`). Une version manuelle ou de fermeture ne remet pas ce compteur à zéro. | « Sauvegarde automatique » |
| `close` | Dernière connexion fermée, salle modifiée, état valide et dans la limite de taille (`afterUnload`, `:1421-1439`). L'auteur est le dernier utilisateur ayant modifié la salle. | « Fermeture de l'éditeur » |
| `before-import` | Import DOCX dans un document existant, avant le remplacement | « Avant import DOCX » |
| `import` | Import DOCX dans un document existant, après le remplacement | « Import DOCX » |
| Création | Création du document (version 1, `Creation`) : document vide, import DOCX en nouveau document, ou modèle du lot 4c (résumé « Création depuis un modèle ») | « Création du document » |

`createVersion` ne crée pas de version si :

- le document est gelé ou épuré (`:393-397`) ;
- l'état est invalide (`:369-371`) ;
- le contenu est identique à la version courante : même empreinte du `.html` et mêmes commentaires (`isSameContent`, `:418`, `:579-607`). Les octets de l'état Yjs ne sont pas comparés.

La création est sérialisée par document (`KeyedMutex`) et suivie d'un réessai unique en cas de course sur le numéro de version. Les binaires sont écrits avant la bascule de `is_current` ; un échec retire tous les fichiers et annule les lignes (`writeAndActivate`, `:667-695`). Une entrée d'audit `version-created:v<n>` est écrite, sans bloquer la création.

La restauration (`POST /collab/documents/:id/restore`, réponse 201) passe par `DocVersionsService.restore`, qui crée une version dont `restoredFromVersionId` pointe vers la version source (`apps/api/src/modules/doc-versions/doc-versions.service.ts:275`). Le reste de ce module n'a pas été relu pour ce document.

### 7.4 Concurrence

- `KeyedMutex` (`persistence/keyed-mutex.ts`) sérialise, par document, les créations de version, les écritures d'état de travail, les mentions et les opérations REST (restauration, import, sauvegarde manuelle) dans le processus. Ces verrous ne sont pas partagés entre plusieurs instances de l'API (section 14).
- Relais de base : après une version créée depuis une salle vivante, la persistance garde la correspondance « version de base connue de la salle vers dernière version créée » (`rebased`, `:156`). Sans elle, un autosave postérieur à une version serait ignoré au rechargement.

## 8. Commentaires et mentions

### 8.1 Commentaires

- Les commentaires vivent dans le Y.Doc, dans le `Y.Map` `comments` (`COMMENTS_KEY`), jamais en base. L'ancre est une marque `comment` (`commentId`) dans le texte (`schema.ts`, `CommentMark`).
- Fonctions du module `packages/editor/src/comments.ts` : `addComment`, `addReply`, `setCommentResolved`, `listComments`.
- Limites (`EDITOR_LIMITS`, `constants.ts`) : corps 4000 caractères, 2000 commentaires par document, 200 réponses par commentaire, 20 mentions par commentaire ou réponse, extrait d'ancre 300 caractères, noms 200 caractères.
- Dans l'interface (`CommentsPanel.tsx`) : ajouter, répondre, résoudre et rouvrir. Il n'y a pas de suppression. Un commentaire résolu reste dans le document (`resolved` bascule).
- Identité imposée par le serveur : pour toute transaction issue d'une connexion cliente, le serveur réécrit `authorUserGroupId` et `authorName` d'un nouveau commentaire ou d'une réponse, `resolvedByName` lors d'une résolution, et empêche de modifier l'identité d'un commentaire existant (`collab-room-identity.ts`, `installCommentIdentityGuard`). Les mutations serveur (REST, import) ne sont pas réécrites : elles sont tenues pour de confiance.
- Limite déclarée dans le code : un écrivain peut toujours supprimer un commentaire ou en modifier le corps. Seule l'identité est garantie.
- Un utilisateur sans `user_group_id` est enregistré avec l'identifiant 0, lu comme « auteur invalide ».

### 8.2 Mentions

- Une mention est un nœud `mention` dont l'attribut `id` est un `user_group_id` en texte, et dont `label` est le libellé. `extractMentionIds` (`packages/editor/src/content.ts`) collecte les mentions du fragment, des commentaires et des réponses, de façon bornée et sans récursion.
- Attribution : après chaque transaction, `MentionTracker` (`collab-room-identity.ts`) repère les identifiants introduits et les attribue à l'auteur authentifié de cette transaction. Un identifiant réintroduit par un autre auteur lui est réattribué. Le recalcul complet n'a lieu que si la transaction touche un élément ou une mention, pas à chaque caractère.
- Notification : après une sauvegarde réussie (`flushMentions`, `collab-server.service.ts:1552-1571`) ou au déchargement. Seules les mentions encore présentes dans le document sont notifiées, une notification par auteur.
- `notifyMentionsLocked` (`collab-persistence.service.ts:771-826`) :
  - l'auto-mention ne notifie personne ;
  - le destinataire doit déjà avoir accès au document (`recipientHasAccess`, `DocumentsService.canAccess`) : une mention ne donne aucun droit ;
  - un compte désactivé ou inconnu ne reçoit rien ;
  - le registre des identifiants déjà notifiés est écrit avant l'envoi et réduit en cas d'échec d'envoi ;
  - au plus 50 destinataires par passage ; un destinataire refusé n'est réexaminé qu'après 60 s ;
  - plafond de 5000 identifiants par document.
- Texte de notification : « <auteur> vous a mentionné dans le document « <libellé> » ».
- Candidats (`GET /collab/documents/:id/mention-candidates?q=`, `collab-documents.service.ts:411-459`) : recherche à partir de 2 caractères, 60 lignes lues au plus, 10 résultats au plus, uniquement des comptes qui ont déjà accès au document. Les caractères `%`, `_` et `\` sont échappés.
- Côté web : `mention-suggestion.ts` applique un délai de 250 ms et annule la requête précédente. Le texte d'aide affiché indique qu'une mention ne donne pas accès au document.

## 9. Export et import DOCX

### 9.1 Export

- `GET /collab/documents/:id/export.docx` (`collab-documents.service.ts:317-336`) : l'état vivant de la salle s'il est ouvert, sinon l'état persisté. Le document est converti par `exportDocx` (`packages/editor/src/docx-export.ts`) : titre, paragraphes, titres, listes, gras, italique, souligné, liens, tableaux, citations, code. Les commentaires sont ajoutés en annexe « Commentaires » sur une page distincte.
- Auteur des propriétés : nom de la personne qui exporte. Nom du fichier : libellé du document, avec `.docx`.
- Côté web : le téléchargement passe par un blob (le jeton est dans l'en-tête), avec un nom nettoyé (`sanitizeFilename`). Avant l'export, le web attend au plus 4 s la synchronisation (`waitSynced`).
- Les images ne sont pas exportées (le schéma n'en contient pas).

### 9.2 Import

- Deux routes, même conversion (`importDocxToHtml`, `packages/editor/src/docx-import.ts`) :
  - `POST /collab/documents/import` crée un document (`spaceId`, `label` facultatif, sinon le nom du fichier) ;
  - `POST /collab/documents/:id/import` remplace le contenu d'un document existant (niveau >= 3, document ni gelé ni épuré).
- Contrôles, dans l'ordre : droit de contribution sur l'espace (création) ou droit de modification (remplacement) ; extension `.docx` ; signature ZIP `PK\x03\x04` ; taille (10 Mio).
- Conversion : `mammoth` avec une table de styles (titres, citations, code, souligné, barré) ; images ignorées avec avertissement ; HTML assaini par `sanitizeEditorHtml`. Protection contre les archives piégées : archive lisible, 2000 entrées au plus, 20 Mio décompressés au total, 10 Mio pour `word/document.xml`. Un échec de conversion renvoie un message générique (400) et ne laisse aucune trace.
- Avertissements (texte français) renvoyés au client, sans détail technique.
- Remplacement d'un document ouvert (`applyImport`, `:354-407`) :
  - une version `before-import` est créée d'abord (non bloquante) ;
  - si la salle est ouverte, le HTML est appliqué à la salle vivante (`mutateDocument`), donc diffusé à tous les participants, puis une version `import` est créée ;
  - sinon, le contenu persisté est remplacé directement ; si le contenu est identique à la version courante, l'état de travail est rebasé sur la version courante.
  - Si l'état persisté est invalide, l'import repart d'un état vierge (`:374-382`).
- Côté web : une confirmation précède le remplacement, qui concerne toutes les personnes connectées.

## 10. API REST

Préfixe global `api` (`apps/api/src/main.ts:46`), contrôleur `@Controller('collab')`.

| Méthode et route | Rôle | Droit exigé |
| --- | --- | --- |
| `POST /api/collab/documents` | Crée un document texte (version 1) dans un espace | Compte humain avec profil ; contribution sur l'espace (404 si l'espace est invisible, 403 sinon) |
| `POST /api/collab/documents/import` | Crée un document depuis un `.docx` (multipart `file`, `spaceId`, `label`) | Idem |
| `GET /api/collab/documents/:id/session` | Mode (`read` ou `write`), libellé, version courante, `wsPath`, identité | Accès au document (404 sinon) |
| `POST /api/collab/documents/:id/versions` | Enregistre une version manuelle (`changeSummary` facultatif) | Niveau >= 3, non gelé ni épuré |
| `POST /api/collab/documents/:id/restore` | Restaure une version texte (`versionId`, `changeSummary`), réponse 201 | Niveau >= 3 ; 409 si la version n'est pas une version texte |
| `GET /api/collab/documents/:id/export.docx` | Export DOCX | Accès |
| `POST /api/collab/documents/:id/import` | Remplace le contenu par un `.docx` | Niveau >= 3, non gelé ni épuré |
| `GET /api/collab/documents/:id/mention-candidates?q=` | Candidats de mention | Accès ; seuls les comptes ayant accès sont listés |

Règle commune : tout document inaccessible, inexistant ou non texte renvoie le même 404 « Document introuvable », avant tout autre contrôle (`requireTextDocument`, `:471-479`). Le compte de numérisation est refusé sur toutes les routes.

## 11. Écrans web

| Écran | Fichier | Contenu |
| --- | --- | --- |
| `/editeur/[documentId]` | `apps/web/app/editeur/[documentId]/page.tsx` puis `EditorShell.tsx` | Session, connexion temps réel, éditeur, barre d'outils, panneaux commentaires, historique et rédaction (4c), présence des participants, état de synchronisation, enregistrement de version, import et export DOCX, bandeaux d'erreur |
| `/editeur/nouveau` | `apps/web/app/editeur/nouveau/page.tsx` | Choix de l'espace, titre, import DOCX facultatif, modèle (lot 4c, voir `docs/ged-redaction.md`) |
| Entrées | `apps/web/app/documents/[documentId]/page.tsx` : bouton « Ouvrir le document » si la version courante porte un `.ydoc` ; `apps/web/app/espaces/[spaceId]/page.tsx` : « Nouveau document » vers `/editeur/nouveau?spaceId=` | |

Comportements de l'éditeur (`EditorShell.tsx`) :

- Présence : noms et couleurs issus de l'awareness, une entrée par personne (`presenceColor`, couleur stable d'après `userGroupId`).
- État de connexion : connexion, synchronisation, modifications non envoyées. Un avertissement de fermeture de page est affiché tant qu'il reste des modifications non envoyées.
- Lecture seule : barre d'outils et insertion désactivées (`readOnly`, `session.mode`).
- Bandeaux : « Modification incompatible » (structure), « Limite de débit ou de taille atteinte » (compte à rebours), « Connexion interrompue » (abandon après 5 tentatives).
- Historique (`VersionHistoryPanel.tsx`) : liste via `GET /documents/:id/versions` (route générique) ; la restauration passe par la route collab `POST /collab/documents/:id/restore`, pour réinitialiser la salle.
- Le panneau « Rédiger avec l'IA » (`DraftingPanel.tsx`) relève du lot 4c.

## 12. Variables d'environnement

| Variable | Lue par | Rôle |
| --- | --- | --- |
| `JWT_SECRET` | `CollabAccessService` (`getOrThrow`) | Vérification des jetons. Obligatoire au démarrage. |
| `ARCHIVES_PATH` | `CollabPersistenceService` (`getOrThrow`) | Pièces des versions, état de travail (`collab/`), registre des mentions. Obligatoire. |
| `CORS_ORIGIN` | `CollabServerService` (`config.get`, repli sur `process.env`), `main.ts` | Origines autorisées à l'upgrade WebSocket (vide : pas de contrôle), et CORS HTTP. |
| `COLLAB_TRUST_PROXY` | `CollabServerService` | Nombre de proxys de confiance pour `X-Forwarded-For` (0 à 10). Défaut 0. Présente dans `.env.example`. |
| `NEXT_PUBLIC_COLLAB_WS_URL` | Web, `EditorShell.tsx` | URL WebSocket explicite. Valeur figée au build (variable `NEXT_PUBLIC_`). Présente dans `.env.example`. |
| `API_INTERNAL_URL` | Web, `apps/web/next.config.mjs` | Cible des rewrites HTTP `/api` (non spécifique à la collaboration). |

`COLLAB_SERVER_OPTIONS` n'est pas une variable (section 4). Aucune variable ne règle les limites du serveur temps réel.

## 13. Tests et commandes

Exécutés dans le worktree `ged-ia-lot-6`, le 21/11/2026 :

| Commande | Résultat |
| --- | --- |
| `cd apps/api && npx jest src/modules/collab` | 11 suites, 401 tests : tous passés. Inclut `collab-server.service.spec.ts` (72 tests, WebSocket réel en processus, port de persistance factice) et `collab-structure-guard.spec.ts`. |
| `cd packages/editor && npx jest` | 7 suites, 101 tests : tous passés. |
| `cd apps/web && npx tsx --test app/lib/editeur.test.ts` | 10 tests : tous passés. La commande `test` de `apps/web` lance aussi `redaction.test.ts` et `app/gouvernance/gouvernance-api.test.ts`, non exécutés ici. |

Scénarios couverts par `collab-server.service.spec.ts` (regroupés par la spec en (a) à (l)) : contrôle d'accès à la connexion, lecture seule, limites, persistance et restauration, convergence, mises à jour à dépendances manquantes, attribution des mentions, identité des commentaires, limite par IP et proxy de confiance, réévaluation des droits, mutation serveur bornée, structure du contenu, compatibilité du client `@hocuspocus/provider`.

Non couvert : aucun test end-to-end de la collaboration dans `apps/api/test` ; pas de test de navigateur ; pas de test de charge ; pas de test du relais nginx ; pas de test multi-instance.

## 14. Limites connues et points à vérifier

Constats par lecture de code, non reproduits :

1. Relais de l'upgrade : `infra/nginx/docupro-demo.conf:39-51` envoie `/api/collab` à l'upstream web (`:5-6`), alors que les rewrites Next sont HTTP (`apps/web/next.config.mjs:13-16`) et qu'aucun code web ne traite `upgrade`. À vérifier en recette. Si Next ne relaie pas l'upgrade, la collaboration ne s'ouvre pas derrière cette configuration.
2. Passage en lecture seule en cours de session : aucune notification au client (`collab-server.service.ts:846-857`), et le web ne lit pas le mode après l'ouverture (`EditorShell.tsx`, `readOnly` calculé une fois). L'éditeur reste modifiable et les modifications sont ignorées.
3. Comptes désactivés : pas de contrôle de `is_disabled` sur le chemin temps réel ni sur `canAccess`. L'accès dure jusqu'à l'expiration du jeton (1 jour par défaut).
4. Restauration : l'instantané « Avant restauration » est pris avant `resetRoom` (`collab-documents.service.ts:274-293`). Une modification reçue pendant cette fenêtre n'est ni dans l'instantané, ni dans la version restaurée.
5. Routes génériques de versions : `POST /documents/:id/versions/:versionId/restore` (`apps/api/src/modules/doc-versions/doc-versions.controller.ts:50-58`) ne contient aucune garde pour les textes natifs (aucune référence à `collab`, `.ydoc` ou `GED_COLLAB` dans `modules/doc-versions`). L'onglet « Versions » de la page document (`apps/web/app/documents/[documentId]/page.tsx:358-368`, `components/documents/VersionsTab.tsx:103-106`) l'utilise pour tout document, texte natif compris. Une restauration générique ne réinitialise pas une salle ouverte : cette salle garde l'état précédent, et son autosave ou sa version « idle » peut réécrire le contenu restauré.
6. Commentaires du contrat incomplets : `collab.contracts.ts:17-20` (4409 et 4410). Voir section 5.
7. `COLLAB_SERVER_OPTIONS` non fourni par `CollabModule` (`collab.module.ts:21-34`) : limites non réglables en exploitation.
8. `COLLAB_TRUST_PROXY` absent du schéma `apps/api/src/config/env.ts`. Lu brut, validé par `parseTrustProxy`.
9. Mono-instance implicite : `KeyedMutex` est en mémoire (`keyed-mutex.ts:1-5`), les salles Hocuspocus aussi. Aucune contrainte de déploiement mono-instance n'a été trouvée dans `docs/` ni dans `infra/`.
10. Coût du balayage : `revalidateAccess` exécute `canAccess`, le niveau effectif et une lecture du document pour chaque couple (document, utilisateur) connecté, toutes les 15 s (`collab-server.service.ts:780-802`). Non mesuré.
11. Protocole : `Stateless` (type 5) est accepté par `CLIENT_MESSAGE_TYPES` (`collab-protocol.ts`) et aucun hook ne le filtre dans ce service. Le comportement de Hocuspocus pour ce type n'a pas été vérifié.
12. Synchronisation avant export ou enregistrement : `waitSynced` attend au plus 4 s (`EditorShell.tsx`, `waitSynced`). Au-delà, l'action part sans attendre la synchronisation complète.
13. Idle : le premier « idle » ne peut intervenir qu'après 10 min depuis l'ouverture de la salle (`collab-server.service.ts:1253`).
14. Écart de formulation : `GET /collab/documents/:id/session` répond 403 si le compte n'a pas de profil actif (`collab-documents.service.ts:207-209`), alors que la règle affichée en tête de service annonce un 404 uniforme (`:110-113`). Le contrôle d'accès est passé avant, donc sans fuite d'existence.
15. Raison `unsaved` : rejet de `beforeUnload` (`collab-server.service.ts:1408`), absent de `CLOSE_REASON`. Probablement interne à Hocuspocus (déchargement annulé), à confirmer.
16. Garde d'un contexte fermé : `checkStructure` répond 4409 `policy-violation` quand la salle ou la connexion est fermée entre-temps (`:1102-1104`). Le code ne distingue pas ce cas de la violation.

Non vérifié sans navigateur ni base réelle : rendu clair et sombre, focus clavier, comportement en cas de coupure réseau, reconnexion après 4410, avertissement de fermeture de page, insertion et mise en forme dans l'éditeur, relais réel de l'upgrade, fonctionnement sous charge.
