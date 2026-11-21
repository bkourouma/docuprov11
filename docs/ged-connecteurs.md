# Cadre de connecteurs de sources GED (lots 2a, 2b et 2c)

Ce document décrit ce que fait le **code** de la copie de travail `ged-ia-lot-2b` à la date de rédaction (2026-11-20). Il couvre le lot 2a (commité, `9c61224`) et le lot 2b (connecteurs Google Drive et Microsoft 365, modifications non encore commitées, sections 12 à 15). Il ne décrit pas de fonctionnalité prévue. Les écarts constatés entre le code, le schéma, la configuration et le brief de lot sont listés en section 11 (points 34 et suivants pour le lot 2b).

> **Limite connue — décision métier en attente.** Les droits d'origine modifiés ou retirés à la source ne sont pas répercutés sur les permissions du document DocuPro, ni en copie ni en synchronisation (section 11.2, point 16). Une révocation à la source reste donc active dans DocuPro tant qu'elle n'est pas retirée à la main, et un droit ajouté à la source n'est pas accordé. **Décision à prendre :** faut-il une révocation automatique, une alerte aux administrateurs, ou les deux ? Le comportement actuel est volontairement inchangé dans cette copie. La même limite vaut pour les connecteurs du lot 2b (section 13.4).

## 1. Vue d'ensemble

Le cadre permet à la GED de reprendre des documents depuis une source externe (dossier monté, boîte IMAP dédiée) selon trois modes : copie, indexation en place, synchronisation. Il comprend un registre de types de connecteurs, un moteur de synchronisation exécuté par le worker, une ingestion commune aux sources, le chiffrement des identifiants, une garde SSRF, le mapping des droits d'origine et une API d'administration. Le lot 2b ajoute quatre connecteurs autorisés par OAuth 2.0 (Google Drive, OneDrive, SharePoint, Outlook) : voir section 12.

Le code est réparti ainsi :

- `packages/connectors/src/` : contrat (`types.ts`), registre (`registry.ts`, `default-registry.ts`), chiffrement (`crypto.ts`), garde SSRF (`ssrf.ts`), mapping des droits (`rights.ts`, `rights-config.ts`), bornes (`limits.ts`), connecteurs (`connectors/filesystem.ts`, `connectors/imap.ts`) et leurs fournisseurs d'E/S (`connectors/fs-default.ts`, `connectors/imap-default.ts`, `connectors/imap-errors.ts`). Lot 2b : socle OAuth (`oauth-contract.ts`, `oauth.ts`, `oauth-http.ts`, `oauth-session.ts`), connecteurs `connectors/google-drive.ts`, `connectors/microsoft-graph.ts` (socle Graph commun), `connectors/microsoft-onedrive.ts`, `connectors/microsoft-sharepoint.ts` et `connectors/microsoft-outlook.ts`.
- `apps/worker/src/processors/connectors/` : `sync-engine.ts` (moteur, sans dépendance directe à Prisma ni au disque), `sync.processor.ts` (câblage BullMQ, planificateur), `prisma-store.ts` (accès base), `ai-trigger.ts` (enfilage du pipeline IA).
- `apps/worker/src/processors/ingestion.ts` : `ingestExternalFile` (création) et `addVersionFromSource` (nouvelle version), bloc « Lot 2a ».
- `apps/worker/src/index.ts` : démarrage de la file `ged-connector-sync` et du planificateur `tick` (bloc « Lot 2a »).
- `apps/api/src/modules/connectors/` : contrôleur, service, DTO, fournisseur de la file. Lot 2b : `oauth-state.store.ts` (magasin d'état OAuth à usage unique) et `oauth.dto.ts` ; le contrôleur OAuth (`oauth.controller.ts`) et le service (`oauth.service.ts`) sont présents, avec leurs specs (section 12.3). `connectors.module.ts` déclare le contrôleur OAuth avant le contrôleur principal.
- `packages/types/src/ged-connectors.ts` (contrat partagé API, worker, web), `packages/types/src/ged.ts` (énumérations), `packages/db/prisma/models/ged.prisma` (modèles `GedSourceConnector`, `GedSourceSyncRun`, `GedSourceItem`). Les CHECK et index sont dans la migration `20261120120000_add_ged_ia_foundations`.

```
  Source (dossier monté, boîte IMAP)
          │  listChanges · fetchFile · readOriginAcl · findMissing
          ▼
  Connecteur (SourceConnector)           connectors/filesystem.ts · connectors/imap.ts
          │  une instance = un connecteur configuré (ConnectorDefinition.create)
          ▼
  Moteur de synchro (runConnectorSync)   sync-engine.ts
          │  passes · jeton persisté par page · erreurs par élément · quotas · plafond
          ▼
  Ingestion commune                      ingestion.ts : ingestExternalFile / addVersionFromSource
          │
          ▼
  Document + version + fichier (coffre)  + droits de consultation (mappés, ou de repli)
          │
          └─► file BullMQ « ged-ai » (seulement si l'IA est activée, copie et synchro)

  Administrateur ─► /api/ged/connectors (@RequireAdmin)
                  ─► ConnectorsService : validation, chiffrement, audit
                  ─► file « ged-connector-sync » ─► worker (jobs « sync » et « tick »)
```

L'écran d'administration est présent dans `apps/web/app/connecteurs/` : liste des connecteurs (`/connecteurs`), formulaire de création et de modification (`_components/ConnectorFormModal.tsx`), détail (`/connecteurs/[connectorId]`) avec les onglets « Synchronisations » (historique des passes) et « Éléments et provenance ». Ces écrans appellent l'API décrite en section 8. Le lot 2b ajoute le bouton d'autorisation OAuth (`_components/OAuthAuthorization.tsx`) et la page de retour `oauth/callback/page.tsx`, servie à `/connecteurs/oauth/callback` (section 12.3).

## 2. Interface commune et registre

### 2.1 Contrat `SourceConnector`

| Méthode | Rôle |
|---|---|
| `authenticate()` | Vérifie la connexion et les identifiants. Lève `ConnectorAuthError` si refus ou expiration. |
| `listChanges(since, { pageSize })` | Renvoie une page d'éléments nouveaux ou modifiés depuis le jeton `since` (`null` = listage complet), le jeton suivant et `hasMore`. Renvoie aussi `deletedExternalIds`. |
| `fetchFile(item)` | Renvoie le contenu, borné par la taille maximale et le type autorisé. |
| `readOriginAcl(item)` | Renvoie les droits d'origine normalisés, ou `null` si illisibles. |
| `findMissing(ids)` (optionnelle) | Parmi les identifiants connus, renvoie ceux qui n'existent plus à la source. Appelée en fin de passe complète, par lots. |
| `close()` | Libère la connexion éventuelle. |

Les erreurs typées pilotent le moteur :

- `ConnectorAuthError(message, expired)` : passe Échouée, connecteur « En erreur » ou « Autorisation expirée ».
- `ConnectorQuotaError(message, retryAfterMs?)` : passe Partielle et reprise planifiée, sans passer le connecteur en erreur.
- `ConnectorItemRejectedError` : l'élément passe « En erreur », la passe continue.
- Toute autre exception levée pendant un élément met cet élément « En erreur ». Pendant la liste ou l'authentification, elle échoue la passe.

### 2.2 `ConnectorDefinition` et registre

Une `ConnectorDefinition` porte : `type`, `label`, `description`, `supportedModes`, `configFields` et `credentialFields` (descriptions de formulaire, en français), `configSchema` et `credentialsSchema` (schémas zod stricts), `assertConfigSafe(config, deps)` (garde de configuration, asynchrone) et `create(ctx)`. Lot 2b : `oauth` (fournisseur et périmètres) est présent pour les types autorisés par OAuth 2.0 ; `ConnectorDeps` peut alors porter `http`, `oauth` et `onCredentialsChanged` (section 12.3).

- La clé `type` est un texte libre `[a-z0-9_]+`, 40 caractères au plus (`GED_CONNECTOR_TYPE_REGEX`, contrainte `ck_ged_source_connector_type` en base, colonne `varchar(40)`). Ajouter un type n'exige ni énumération ni migration.
- `ConnectorRegistry.register` refuse un type mal formé et un type déjà enregistré.
- `createDefaultRegistry()` enregistre aujourd'hui six types : `filesystem` et `imap` (lot 2a), puis `google_drive`, `microsoft_onedrive`, `microsoft_sharepoint` et `microsoft_outlook` (lot 2b). L'API (`connectors.module.ts`) et le worker (`sync.processor.ts`, en l'absence de registre injecté) construisent chacun ce même registre.
- `validateConnectorInput` contrôle, dans l'ordre : type connu, mode supporté, réglages (schéma strict), droits (`rights`, schéma strict), identifiants (schéma strict, s'ils sont fournis), puis `assertConfigSafe`. Les messages d'erreur ne contiennent jamais une valeur d'identifiant.

### 2.3 Ajouter un connecteur

1. Créer `packages/connectors/src/connectors/<nom>.ts` : une classe qui implémente `SourceConnector`, et un `ConnectorDefinition` exporté, dont `create` instancie la classe.
2. Définir `configSchema` et `credentialsSchema` avec `z.object({...}).strict()`. Les secrets ne vont jamais dans `configSchema`.
3. Implémenter `assertConfigSafe` : garde SSRF pour tout hôte (`assertPublicHost`), contrôle des chemins pour tout dossier (même logique que `assertFilesystemPathSafe`, puis garde sur chemins réels `assertFilesystemRealPathSafe` : `realpath` de la racine, des racines autorisées et d'`ARCHIVES_PATH`), à refaire aussi à chaque passe dans `authenticate`.
4. Ajouter le `register(...)` dans `packages/connectors/src/default-registry.ts`.
5. Si le connecteur lit une variable d'environnement, l'ajouter à `connectorEnv()` dans `apps/worker/src/processors/connectors/sync.processor.ts`. Cette fonction ne transmet au connecteur que `GED_CONNECTOR_FS_ROOTS`, `GED_CONNECTOR_ALLOWED_INTERNAL_HOSTS` et `ARCHIVES_PATH`. Les références `credentials_ref` lisent l'environnement complet et ne sont pas concernées. Pour le lot 2b, `connectorEnv()` transmet aussi `GED_GOOGLE_CLIENT_ID`, `GED_GOOGLE_CLIENT_SECRET`, `GED_MS_CLIENT_ID`, `GED_MS_CLIENT_SECRET` et `GED_MS_TENANT` (section 11, point 34).
6. Tester avec des fournisseurs simulés injectés par `deps` (modèle : `connectors/filesystem.spec.ts`, `connectors/imap.spec.ts`).

Aucune migration n'est nécessaire. `GET /api/ged/connectors/types` expose le nouveau type à partir de ses `configFields` et `credentialFields`.

## 3. Les trois modes

| Mode | Valeur | Ce qui est écrit | Ce qui n'est jamais écrit |
|---|---|---|---|
| Copie | 0 | Un `Document` (libellé : nom sans extension, 500 caractères au plus ; dossier cible ou aucun ; `created_by` NULL ; `is_archived` faux), sa version courante n° 1, son fichier, son empreinte SHA-256 et le scellement (non bloquant) ; les droits de consultation, dans la même écriture. L'élément passe à l'état « Copié » avec `document_id` et `content_hash`. Une modification ultérieure met seulement l'élément à « Modifié à la source ». | Le document existant n'est jamais écrasé : la copie DocuPro reste intacte. |
| Indexation en place | 1 | Rien dans les documents : pas de `Document`, pas de droits, pas de binaire. Pour les extensions `.txt`, `.csv`, `.md`, `.html`, `.htm` et `.pdf`, le fichier est lu, son empreinte calculée et son texte extrait dans `origin_metadata.indexedText` (200 000 caractères au plus, avec `indexedTextTruncated`). Pour les autres extensions, seules les métadonnées sont gardées et l'empreinte reste vide. État « Indexé en place ». | Aucun document, aucun fichier sur le coffre, aucun droit DocuPro, aucun envoi à la file IA. |
| Synchronisation | 2 | Comme la copie, à la création. Ensuite, si l'empreinte a changé, une nouvelle version courante est ajoutée (`addVersionFromSource`, ancienne version marquée non courante). Si l'empreinte est identique, seule la provenance est mise à jour. | Les droits du document ne sont jamais recalculés ni modifiés après sa création. Une version identique n'est pas ajoutée. |

Dans les trois modes, la provenance (dont les droits d'origine) est enregistrée à chaque passage, avant le traitement du contenu. Le moteur ne lit jamais le contenu d'un élément déjà réglé (même version, état final). L'extraction de texte ne concerne que les formats ci-dessus : une image ou un PDF scanné n'a pas de texte (`ocr_text` reste NULL), car aucun OCR n'est lancé sur les sources.

## 4. Provenance, dédoublonnage et suppressions

### 4.1 Élément (`ged_source_item`)

Un élément est identifié par le couple (`connector_id`, `external_id`), unique. `external_id` est l'identifiant stable dans la source (chemin relatif, `uidValidity:uid:partie` pour une pièce jointe IMAP), 500 caractères au plus.

Les colonnes de provenance sont : `name`, `origin_url`, `origin_path`, `mime_type`, `byte_length`, `origin_author`, `origin_created_at`, `origin_modified_at`, `origin_acl` (droits d'origine normalisés, JSON), `origin_metadata` (propre au connecteur, par exemple sujet et expéditeur d'un courriel), `remote_version` (marqueur de changement : taille et date pour le dossier, taille pour l'IMAP), `content_hash`, `document_id`, `duplicate_of_id`, `error_message`, `first_seen_at`, `last_seen_at` et `indexed_at`.

Le marqueur `remote_version` n'est écrit qu'avec l'état final de l'élément. Un plantage au milieu du traitement fait donc rejouer l'élément au passage suivant au lieu de le croire à jour.

### 4.2 États

| Valeur | État | Signification dans le code |
|---|---|---|
| 0 | Découvert | Créé à la découverte. Transitoire : il n'y reste que si le traitement a été interrompu. |
| 1 | Copié | Document créé (copie) ou version à jour (synchro). |
| 2 | Indexé en place | Provenance et éventuel texte indexé ; pas de document. |
| 3 | Modifié à la source | En copie : signalé, copie intacte. En synchro : transitoire, l'élément est resynchronisé dans la même passe. |
| 4 | Supprimé à la source | Constaté absent de la source. Le document est conservé (voir 4.4). |
| 5 | En erreur | Motif dans `error_message`. Rejoué à chaque passe, sans nombre maximal de tentatives. |
| 6 | Doublon | Même contenu qu'un original déjà présent ; `duplicate_of_id` pointe vers lui. Pas de document. |

### 4.3 Dédoublonnage par empreinte SHA-256

- La clé est l'empreinte SHA-256 du contenu lu, en hexadécimal minuscule. Le nom et la taille ne comptent pas.
- La recherche porte sur toutes les sources, pas seulement sur le connecteur courant.
- L'original est le plus ancien élément de même empreinte dans l'état « Copié » ou « Indexé en place » (`first_seen_at`, puis identifiant). Un doublon et un élément supprimé à la source ne peuvent jamais servir d'original.
- Le contrôle a lieu à la création de l'élément (copie ou indexation en place), pas à chaque resynchronisation d'un élément déjà copié.
- Le doublon reçoit l'état 6, `duplicate_of_id` renseigné, pas de document et pas de droits. Le compteur `items_duplicate` de la passe est incrémenté.
- Un doublon n'ajoute aucun droit à l'original. Les personnes qui n'ont accès qu'à la source du doublon ne voient donc pas le document. Les droits de l'original s'appliquent seuls.
- En indexation en place, un type sans extraction (empreinte absente) n'est pas dédoublonné.

### 4.4 Suppression à la source (hypothèse H3)

Un élément constaté absent de la source passe à l'état 4, « Supprimé à la source ». Seul l'état de provenance change : le document, ses versions, ses fichiers et ses droits restent en place, et aucune écriture n'est faite dans DocuPro.

Deux mécanismes peuvent constater une suppression :

- `deletedExternalIds` de la page renvoyée par `listChanges` : aucun connecteur fourni ne le renseigne aujourd'hui (voir section 11) ;
- `findMissing` : pour le dossier, en fin de passe complète uniquement (voir 5.2).

Un élément qui réapparaît sans changement de version revient à son état d'origine, déduit de son historique : « Copié » si un document est rattaché, « Doublon » si `duplicate_of_id` est renseigné, « Indexé en place » si une empreinte existe en mode indexation. Dans les autres cas, ou s'il réapparaît avec une autre version, il est traité normalement.

## 5. Exécution des synchronisations

### 5.1 Jobs et planification

- File `ged-connector-sync`, consommée par le worker avec une concurrence de 2 (`apps/worker/src/index.ts`).
- Deux jobs : `sync` (une passe pour un connecteur, avec `trigger` `manual` ou `schedule` et `requestedBy`) et `tick` (planificateur).
- `tick` est déclaré avec `upsertJobScheduler` au motif `* * * * *` : une fois par minute.
- `runConnectorTick` enfile un `sync` pour chaque connecteur actif, non inactif, avec un intervalle défini, dont la dernière synchronisation (`last_sync_at`) plus l'intervalle est échue, ou qui n'a jamais été synchronisé. Le `jobId` est `ged-sync-<id>` : BullMQ ignore un ajout dont le `jobId` existe encore.
- L'intervalle est un entier de 5 à 10 080 minutes (`syncIntervalMinutes`) ; NULL signifie synchronisation manuelle uniquement.
- Déclenchement manuel (`POST /api/ged/connectors/:id/sync`) : refusé en 409 si le connecteur est inactif ou si une passe est en cours depuis moins de 2 h. Un job déjà en attente avec le même `jobId` n'est pas doublonné ; un job terminé ou en échec est retiré, puis ré-enfilé.

### 5.2 Déroulement d'une passe

1. Anti-concurrence : une passe « En cours » commencée il y a moins de 2 h fait sortir la passe demandée sans rien écrire (`already_running`). Une passe plus ancienne est fermée en « Échouée » (« passe abandonnée »).
2. Création de la ligne de passe, avec `change_token_before`.
3. `authenticate()`.
4. Boucle sur les pages : `listChanges(jeton, pageSize)` avec `pageSize = min(100, restant avant le plafond)`.
   - Chaque élément listé compte dans `items_seen`. Un élément figurant aussi dans les suppressions de la même page est compté mais non traité.
   - Chaque élément est traité par `handleItem` (voir 5.6).
   - Les `deletedExternalIds` de la page sont marqués supprimés par lots de 500.
   - Le jeton n'est persisté qu'une fois la page entièrement traitée (voir 5.3). Les compteurs de la passe sont mis à jour à chaque page.
   - Si la page est la dernière, la boucle s'arrête avec `complete = true`.
   - Si le plafond de 2 000 éléments vus est atteint, la passe s'arrête avec une reprise immédiate.
5. Si la passe est complète et que le connecteur fournit `findMissing`, les éléments en état Copié, Indexé en place ou Modifié à la source sont évalués par lots de 500 (`detectMissing`). Un échec de cette étape compte comme élément en échec et rend la passe Partielle.
6. Bilan : passe « Partielle » si au moins un élément est en échec, « Réussie » sinon. Le connecteur repasse « Actif » et son `last_error` est vidé.
7. Fermeture : `finished_at` est toujours renseigné, puis le connecteur est mis à jour, puis la reprise éventuelle est planifiée.

Erreurs de la passe :

- `ConnectorAuthError` : passe « Échouée » ; connecteur « Autorisation expirée » si `expired`, sinon « En erreur ».
- `ConnectorQuotaError` : passe « Partielle » ; reprise planifiée (5.4) ; le statut du connecteur ne change pas.
- Autre exception : passe « Échouée » ; connecteur « En erreur » avec le message masqué.

### 5.3 Jeton de changement et reprise

- Le jeton est persisté dans `ged_source_connector.change_token` après chaque page entièrement traitée. La passe garde `change_token_before` et `change_token_after`.
- Un plantage au milieu d'une page rejoue cette page seulement. Les éléments déjà traités sont alors simplement vus. La limite de ce mécanisme est décrite en section 11.
- Jeton du dossier : JSON `{"m": mtime en ms, "p": chemin relatif}` ; le tri se fait sur ce couple. Jeton IMAP : `{"v": UIDVALIDITY, "u": dernier UID}`.
- Un jeton illisible fait échouer la passe. Il n'y a pas de relistage silencieux.
- Un jeton qui n'avance plus alors que la page annonce d'autres résultats interrompt la passe.
- Un changement de `rootPath`, `host` ou `mailbox` remet le jeton à NULL : relistage complet.

### 5.4 Quotas, plafond et reprise planifiée

- Quota : la passe s'arrête proprement, son état est « Partielle », et une passe est enfilée après `retryAfterMs`. Ce délai est borné entre 1 minute et 6 heures ; 15 minutes par défaut. Le job porte l'identifiant `ged-sync-resume-<id>-<horodatage>`. Dans la pratique, seul l'IMAP lève ce type d'erreur (voir 6.2).
- Plafond : 2 000 éléments vus par passe (compteur `items_seen`). Au-delà, la passe s'arrête et une reprise est enfilée sans délai.
- Une passe qui échoue ou s'arrête laisse le jeton de la dernière page complète. La suivante repart de là.

### 5.5 Anti-concurrence

- Côté moteur : une passe « En cours » de moins de 2 h bloque toute autre passe du même connecteur (5.2, étape 1).
- Côté API : `POST …/sync` renvoie 409 dans la même situation.
- Après l'écriture de la passe (`createRun`), le moteur relit les passes « En cours » du connecteur : la passe d'identifiant le plus petit continue, les autres se retirent (`SyncStore.deleteRun`). Une fenêtre résiduelle de quelques millisecondes subsiste (voir section 11, point 19).

### 5.6 Erreurs d'un élément

- Une exception sur un élément, autre que l'authentification ou le quota, met l'élément à l'état 5 avec le message masqué (2 000 caractères au plus). Le compteur `items_failed` augmente et la passe continue. Les données de provenance sont mises à jour sans toucher aux droits d'origine déjà enregistrés.
- Les erreurs de mise en route (type inconnu, clé de chiffrement absente, identifiants illisibles, configuration invalide) ne lancent pas de passe. Le connecteur passe « En erreur » avec le motif, et la tâche n'est pas relancée par BullMQ.

### 5.7 Bornes

| Borne | Valeur | Source |
|---|---|---|
| Taille maximale d'un fichier | 50 Mio | `GED_CONNECTOR_LIMITS.maxFileBytes` |
| Éléments par page | 100 | `GED_CONNECTOR_LIMITS.pageSize` |
| Éléments vus par passe | 2 000 | `GED_CONNECTOR_LIMITS.maxItemsPerRun` |
| Texte indexé en place | 200 000 caractères | `GED_CONNECTOR_LIMITS.maxIndexedTextChars` |
| Extensions acceptées | 23 (voir ci-dessous) | `GED_CONNECTOR_ALLOWED_EXTENSIONS` |
| Passe « En cours » considérée vivante | 2 h | `RUN_STALE_AFTER_MS` |
| Délai de reprise après quota | 15 min par défaut, entre 1 min et 6 h | `QUOTA_*_RETRY_MS` |
| Lot de `findMissing` et de suppressions | 500 | `MISSING_BATCH_SIZE` |
| Entrée HTML analysée | 2 Mio (`HTML_MAX_INPUT_CHARS`, tronquée au-delà) | `ingestion.ts` |
| Pages PDF lues pour l'extraction de texte | 500 (`PDF_TEXT_MAX_PAGES`) | `ingestion.ts` |
| Délai maximal d'extraction PDF et de comptage de pages | 30 s (`PDF_PARSE_TIMEOUT_MS`) | `ingestion.ts` |

Comportement aux bornes d'extraction (copie, synchro et indexation en place) : le HTML est converti en texte par un balayage linéaire (pas de regex à retour arrière) sur ses 2 premiers Mio seulement. Un PDF de plus de 500 pages n'est pas parcouru : `ocr_text` reste NULL et `page_count` est renseigné. Si l'extraction dépasse 30 s, le texte est NULL ; si c'est le comptage de pages qui dépasse 30 s, `page_count` est NULL aussi. Dans tous les cas l'objet pdfjs est détruit et le log ne contient aucun extrait du fichier. Le comptage (pdf-lib) ne peut pas être interrompu pendant son parsing synchrone : le délai ne libère que l'attente. Ces constantes sont du code, pas de la configuration : les relever suppose une modification de `ingestion.ts`.

Les extensions acceptées sont : `.pdf`, `.png`, `.jpg`, `.jpeg`, `.tif`, `.tiff`, `.txt`, `.csv`, `.md`, `.html`, `.htm`, `.rtf`, `.doc`, `.docx`, `.xls`, `.xlsx`, `.ppt`, `.pptx`, `.odt`, `.ods`, `.odp`, `.eml`, `.msg`. Un connecteur ne peut que restreindre cette liste. Aucun champ de configuration ne relève ces bornes.

## 6. Connecteurs fournis

Les connecteurs du lot 2a (dossier, IMAP) sont décrits ci-dessous. Les connecteurs OAuth du lot 2b (Google Drive, OneDrive, SharePoint, Outlook) sont décrits en section 13.

### 6.1 Dossier surveillé (`filesystem`, libellé « Dossier surveillé »)

Modes : copie, indexation en place, synchronisation. Pas d'identifiants.

| Réglage | Règle |
|---|---|
| `rootPath` | Chemin absolu sur le serveur, 1 000 caractères au plus, sans segment `..`, dans une racine autorisée (voir ci-dessous). |
| `recursive` | Par défaut vrai : inclut les sous-dossiers. |
| `minAgeSeconds` | Entier de 0 à 86 400, défaut 30. Un fichier modifié depuis moins de ce délai est ignoré (copie probablement en cours). |
| `extensions` | Sous-ensemble facultatif des extensions acceptées (`.ext`, 50 au plus). Il ne peut pas élargir la liste globale. |

Autorisation des dossiers (`assertFilesystemPathSafe`) :

- `GED_CONNECTOR_FS_ROOTS` liste les racines autorisées, séparées par le séparateur de chemins du système (`;` sous Windows, `:` sous Linux). Sans cette variable, aucun dossier n'est accepté.
- Le dossier doit se trouver dans une racine autorisée.
- Le dossier ne doit pas recouvrir `ARCHIVES_PATH` : ni l'inclure, ni être inclus dans le coffre.
- Garde sur chemins RÉELS (`assertFilesystemRealPathSafe`) : un contrôle lexical ne suffit pas, un lien symbolique posé sous une racine autorisée pouvait la contourner. La fonction résout par `realpath` la racine configurée (via son plus proche parent existant, pour voir un lien dans un dossier parent même si le dossier final n'existe pas encore), chaque racine autorisée et `ARCHIVES_PATH`, puis refait « est à l'intérieur de » et l'exclusion du coffre sur ces chemins réels. Une racine configurée dont le dossier est un lien vers l'extérieur des racines, vers le coffre ou vers un dossier qui le contient est refusée. Une racine autorisée non résolvable est ignorée (elle n'autorise rien) ; une erreur de résolution autre que « absent » (ex. droits insuffisants) refuse par précaution. Elle est appelée par `assertConfigSafe` (création, modification, test de connexion), puis à chaque passe par `authenticate`, `listChanges` et `findMissing` (échec = `ConnectorAuthError`), car un lien peut être posé après l'enregistrement. `fetchFile` garde le contrôle lexical plus la comparaison du fichier réel à la racine réelle, sans refaire la résolution de toutes les racines pour chaque fichier.

Comportement :

- Lecture seule : le parcours (`readdir`, `lstat`) et la lecture des fichiers ne modifient rien, ne déplacent rien et ne suppriment rien.
- Les liens symboliques ne sont jamais suivis au parcours. Au moment de la lecture, le chemin réel doit rester sous la racine réelle, et l'ouverture refuse de suivre un lien (`O_NOFOLLOW`, hors Windows).
- Éléments ignorés : noms commençant par `.`, dossiers commençant par `.`, dossiers de service `_envoyes` et `_erreurs` (mêmes conventions que l'agent de numérisation `apps/scan-agent`), fichiers `~$…`, suffixes temporaires (`.tmp`, `.temp`, `.part`, `.partial`, `.crdownload`, `.filepart`), extensions hors liste. Profondeur maximale : 32 niveaux.
- Ordre et jeton : les éléments sont triés par date de modification puis par chemin. Le marqueur de version est `taille:mtime`.
- Détection des suppressions : `findMissing` vérifie, par lots de 20, que chaque chemin connu existe encore sous la racine. Si la racine elle-même est injoignable, la détection lève une erreur au lieu de tout déclarer supprimé.
- Droits d'origine (POSIX) : si le bit de lecture du propriétaire est positionné, une entrée `uid:N` (écriture si le bit d'écriture du propriétaire l'est, lecture sinon) ; si le bit de lecture du groupe l'est, une entrée `gid:N` ; si le bit de lecture « autres » l'est, une entrée `public`. `public` n'est jamais mappé. Sous Windows ou sur un partage SMB sans bits POSIX, aucune ACL n'est lue : le repli s'applique.

### 6.2 Boîte IMAP dédiée (`imap`, libellé « Boîte IMAP dédiée »)

Modes : copie et synchronisation. Seules les pièces jointes sont reprises ; les corps de messages ne sont pas importés. La boîte n'est jamais modifiée : messages et indicateurs restent intacts (sélection en lecture seule).

| Réglage | Règle |
|---|---|
| `host` | Nom ou adresse, 253 caractères au plus, caractères `A-Za-z0-9._:-`. Soumis à la garde SSRF (7.3). |
| `port` | Entier de 1 à 65 535, défaut 993. |
| `secure` | Vrai par défaut : TLS direct. Faux : STARTTLS exigé, sans repli en clair. Le certificat est toujours vérifié. |
| `mailbox` | 200 caractères au plus, défaut `INBOX`. |

Identifiants : `user` et `password`, 500 caractères au plus chacun, obligatoires.

Comportement :

- À chaque connexion, l'hôte est de nouveau résolu et contrôlé par la garde SSRF. La connexion se fait sur l'adresse vérifiée (trois au plus), avec le nom d'origine comme `servername` TLS.
- Listage : les messages d'UID supérieur au dernier UID du jeton sont lus par enveloppe et structure seulement, sans corps. L'extraction écarte les parties multipart, les corps sans nom et les images inline référencées par un `Content-ID`. Au listage, on écarte les images de moins de 10 Ko (signatures et logos) et les extensions non autorisées. Un message attaché (`message/rfc822`) compte comme une seule pièce ; sans nom, il reçoit `message-<partie>.eml`.
- Identifiant d'élément : `uidValidity:uid:partie`. Si UIDVALIDITY change, le listage repart de zéro ; les doublons de contenu sont évités par l'empreinte.
- Récupération : la pièce est téléchargée à la demande, bornée à la taille maximale. Si UIDVALIDITY a changé entre le listage et la récupération, l'élément est rejeté.
- Droits d'origine : une seule entrée, le login du compte, de type utilisateur, en lecture. Le mapping suppose donc un groupe DocuPro rattaché à ce login (`principalMap`).
- Erreurs : les réponses d'authentification refusée ou expirée deviennent `ConnectorAuthError` ; les réponses de limitation de débit deviennent `ConnectorQuotaError` ; le reste devient une erreur dont le texte est masqué et tronqué à 300 caractères.
- Aucune trace protocolaire n'est journalisée (le journal du client est désactivé, car il contiendrait le `LOGIN`).

## 7. Sécurité

### 7.1 Chiffrement des identifiants

- Algorithme : AES-256-GCM, avec un IV aléatoire de 96 bits à chaque chiffrement et un tag de 128 bits.
- Format : base64 standard d'une enveloppe dont l'octet 0 est la version (`1`), suivie de l'IV, du tag, puis du chiffré. Le clair fait 64 Kio au plus.
- Données authentifiées (AAD) : une chaîne de domaine, la version et l'identifiant de clé. Une ligne dont on changerait l'identifiant de clé ne se déchiffre donc plus.
- Trousseau, lu dans l'environnement par `loadKeyRing` :
  - `GED_CONNECTOR_KEY` : clé active, base64 strict de 32 octets exactement ;
  - `GED_CONNECTOR_KEY_ID` : identifiant de la clé active, `[A-Za-z0-9_-]` de 1 à 50 caractères, défaut `k1` ;
  - `GED_CONNECTOR_KEY_PREVIOUS` : anciennes clés `id:base64,id:base64`, utilisées seulement pour déchiffrer. Un identifiant en double est refusé.
- Le chiffrement n'utilise que la clé active. Le déchiffrement utilise la clé indiquée par `credentials_key_id`. Il n'existe aucune clé par défaut : une ligne sans identifiant de clé ne se déchiffre pas.
- Les messages d'erreur de ce module ne contiennent ni clé, ni identifiant, ni fragment de clair. Une clé absente du trousseau donne : « Clé de chiffrement inconnue (rotation ?) : remettez l’ancienne clé dans GED_CONNECTOR_KEY_PREVIOUS ».
- Stockage : `credentials_enc` et `credentials_key_id` dans `ged_source_connector`. La contrainte `ck_ged_source_connector_credentials` interdit d'avoir à la fois un chiffré et une référence.
- Référence de coffre (`credentials_ref`) : au lieu d'un chiffré, le nom d'une variable d'environnement qui contient un objet JSON `nom → chaîne`. Le nom doit correspondre à `GED_CONNECTOR_SECRET_[A-Z0-9][A-Z0-9_]{0,59}` ; toute autre variable est refusée, pour qu'un administrateur ne puisse pas faire lire au connecteur `JWT_SECRET` ou `DATABASE_URL`.
- L'API ne renvoie jamais un identifiant ni son chiffré. La vue expose `hasCredentials` (booléen) et, pour une référence, son nom.
- Masquage : tout message d'erreur qui peut contenir un identifiant passe par `redactSecrets` (valeur brute, forme URL, forme JSON, base64 sans remplissage ; valeurs de 4 caractères au moins) avant d'être journalisé, stocké ou renvoyé.
- Audit : chaque création, modification, activation, désactivation, demande de synchronisation et rotation est tracée (`ged_source_connector:<id>`), avec la nature du changement, jamais sa valeur.

### 7.2 Procédure de rotation

Cette procédure reprend le plan de lot. Elle a été vérifiée sur le code : la route `POST /api/ged/connectors/rotate-keys` existe bien (contrôleur, `@RequireAdmin`). Les valeurs ci-dessous sont des espaces réservés, à ne jamais écrire dans un document ni dans un dépôt.

1. Générer la nouvelle clé : `openssl rand -base64 32`.
2. Déployer sur l'API **et** sur le worker les trois variables `GED_CONNECTOR_KEY=<nouvelle clé>`, `GED_CONNECTOR_KEY_ID=k2`, `GED_CONNECTOR_KEY_PREVIOUS=k1:<ancienne clé>`, puis redémarrer les deux. Le worker doit avoir la nouvelle clé avant que l'API ne crée des lignes sous `k2` : sans elle, ces lignes ne se déchiffrent pas et la passe passe en « En erreur ». Si `GED_CONNECTOR_KEY_ID` n'a jamais été défini, l'ancienne clé porte l'identifiant `k1` par défaut.
3. Appeler `POST /api/ged/connectors/rotate-keys` avec un compte administrateur. La réponse `{ "reencrypted": n }` compte les lignes rechiffrées. Les lignes illisibles sont journalisées (avertissement) et absentes de la réponse. Un chiffré modifié pendant l'appel n'est pas écrasé et n'est pas compté. L'appel peut être relancé sans risque : il ne touche que les lignes encore hors de la clé active. Sans `GED_CONNECTOR_KEY` côté API, la route répond 503.
4. Vérifier qu'aucune ligne ne porte plus l'ancien identifiant : `SELECT count(*) FROM ged_source_connector WHERE credentials_key_id = 'k1';` doit renvoyer 0. Aucune route de l'API n'expose cet identifiant ; le contrôle passe donc par la base.
5. Retirer `k1` de `GED_CONNECTOR_KEY_PREVIOUS` (il ne reste que la clé active, ou la variable est vide), redéployer l'API et le worker, puis détruire l'ancienne clé.
6. Si une clé a été retirée trop tôt, les lignes concernées ne se déchiffrent plus : le worker les passe en « En erreur » avec le message « Clé de chiffrement inconnue (rotation ?) … », et `rotate-keys` les journalise. Remettre l'ancienne clé, avec son identifiant, dans `GED_CONNECTOR_KEY_PREVIOUS`, redéployer, puis reprendre à l'étape 3.

Règles :

- Ne jamais réutiliser un identifiant de clé pour une autre clé. L'identifiant est lié au chiffré (AAD) : une réutilisation rend illisibles les lignes encore sous l'ancienne clé.
- Ne pas détruire l'ancienne clé avant l'étape 4.

### 7.3 Garde SSRF

Menace couverte : un administrateur applicatif saisit une adresse interne (base de données, cache, API interne, métadonnées du cloud) comme serveur IMAP, et se sert du worker comme relais. La garde (`assertPublicHost`) est appliquée à la validation de la configuration (API) et à chaque connexion IMAP (worker). Elle fonctionne ainsi :

- Refus par défaut : tout ce qui ne peut pas être analysé est refusé.
- Forme de l'hôte : ASCII imprimable uniquement, pas d'identifiant (`utilisateur@`), pas de chemin, pas de port, pas d'accents. Un nom sans point (`redis`, `postgres`) est refusé, sauf s'il figure dans la liste blanche : c'est la forme des services voisins dans Docker Compose.
- Adresses IPv4 non canoniques (`2130706433`, `0x7f.1`, `127.1`, zéros de tête) : décodées pour être jugées, puis refusées même si publiques.
- Suffixes refusés : `localhost`, `local`, `internal`, `localdomain`, `home.arpa`, `lan`, `intranet`, `corp`, `home`.
- Adresses bloquées : `0.0.0.0/8`, `10/8`, `100.64/10`, `127/8`, `169.254/16` (dont les métadonnées cloud), `172.16/12`, `192.168/16`, plages de documentation et de test, multicast, réservé et diffusion. Pour IPv6, seule l'unicast globale `2000::/3` est admise, moins `2001::/23` (attributions IETF : Teredo, ORCHID, bancs d'essai), `2001:db8::/32` et `3fff::/20` (documentation). Les adresses IPv4 embarquées (mappées, traduites, NAT64, 6to4) sont jugées sur leur IPv4.
- Toujours refusées, même avec la liste blanche : `0.0.0.0/8`, `169.254.169.254`, multicast, `255.255.255.255`, `::`, `fd00:ec2::254`, `ff00::/8`.
- Une seule adresse interne parmi les adresses résolues suffit à refuser l'hôte.
- Anti DNS-rebinding : l'hôte est résolu, puis la connexion se fait sur l'adresse vérifiée, avec le nom d'origine comme SNI et contrôle du certificat. La résolution a un délai de 5 secondes.
- Liste blanche de l'exploitant (`GED_CONNECTOR_ALLOWED_INTERNAL_HOSTS`, séparée par des virgules) :
  - un nom exact autorise ce nom seulement, pas ses sous-domaines ;
  - une adresse ou un CIDR autorise les adresses couvertes, pour n'importe quel nom. Les préfixes plus larges que `/8` (IPv4) ou `/16` (IPv6) sont ignorés ;
  - une entrée invalide est ignorée : la liste ne peut que restreindre le refus, jamais l'élargir sans le vouloir.

### 7.4 Mapping des droits

Règle impérative : le document créé n'est jamais plus ouvert qu'à la source. Dans DocuPro, un document sans aucune permission est visible par tout utilisateur authentifié. Un document créé sans droit est donc interdit.

Fonctionnement (`mapOriginRights`, réglages dans la clé réservée `rights` de la configuration) :

- Entrées prises en compte : seulement les entrées de type `user` ou `group`, avec un accès `read`, `write` ou `owner`. Les entrées `public` et `unknown` ne donnent rien et n'élargissent rien ; elles sont comptées.
- Correspondance : `principalMap` associe un principal de la source (login, `uid:N`, `gid:N`) à un `user_group_id` DocuPro. La comparaison ignore la casse et les espaces de bord. Deux clés qui se confondent après normalisation, vers des groupes différents, sont ambiguës et ne sont retenues ni l'une ni l'autre.
- Résultat : la Consultation (niveau 2) est posée sur les groupes mappés, et seulement ceux-là. Le niveau 1 (refus) et les niveaux supérieurs ne sont jamais posés.
- Repli : si aucun principal n'est mappé, les groupes de `rights.fallbackUserGroupIds` reçoivent la Consultation. Le repli n'est jamais ajouté à des droits déjà mappés.
- Aucun groupe (ni mappé, ni de repli) : l'élément passe « En erreur » avec le motif « document non créé ». Rien n'est créé.
- Garde-fous juste avant l'écriture : `assertNeverWider` recalcule les droits autorisés sans réutiliser le mapping, et `assertRestricted` refuse un résultat vide. L'ingestion (`ingestExternalFile`) refuse elle aussi tout droit qui ne soit pas la Consultation, et crée les droits dans la même écriture que le document.
- Le document n'a pas de créateur (`created_by` NULL) : un passe-droit de créateur ne pourrait ajouter un lecteur absent de la source. Pas de type ni de confidentialité par défaut, pour la même raison.
- Côté API : `rights.fallbackUserGroupIds` doit être non vide. Si la configuration ne le précise pas, le groupe de l'administrateur qui crée ou modifie le connecteur est posé comme repli. Tous les groupes cités (mappés ou de repli) doivent exister en base, sinon 400.
- Les droits sont fixés à la création du document. Une resynchronisation n'en recalcule pas (voir section 11).

## 8. API d'administration

Préfixe global `/api`. Le contrôleur `ged/connectors` est réservé aux administrateurs : `MenuPermissionGuard` et `@RequireAdmin()` s'appliquent à tout le contrôleur. Les routes statiques (`types`, `rotate-keys`) sont déclarées avant les routes paramétrées.

| Méthode et chemin | Rôle | Réponse |
|---|---|---|
| `GET /api/ged/connectors/types` | Types enregistrés, avec leurs champs de formulaire et leurs modes | Liste de `GedConnectorTypeInfo` |
| `GET /api/ged/connectors` | Liste des connecteurs | Liste de `GedConnectorView` |
| `POST /api/ged/connectors` | Création : validation complète, chiffrement, audit | 201, vue |
| `POST /api/ged/connectors/rotate-keys` | Rechiffrement avec la clé active (section 7.2) | 200, `{ reencrypted }` ; 503 sans clé |
| `GET /api/ged/connectors/:id` | Un connecteur | Vue |
| `PUT /api/ged/connectors/:id` | Mise à jour partielle, validation complète à chaque appel | Vue |
| `POST /api/ged/connectors/:id/activate` | Réactive : statut « Actif », `last_error` vidé | 200, vue |
| `POST /api/ged/connectors/:id/deactivate` | Désactive : statut « Inactif » | 200, vue |
| `POST /api/ged/connectors/:id/test` | Authentification puis lecture d'une page d'un élément, délai de 20 s | 200, `{ ok, message }` ; un échec donne `ok: false`, pas une erreur HTTP |
| `POST /api/ged/connectors/:id/sync` | Met une passe en file | 200, `{ queued: true }` ; 409 si inactif ou en cours |
| `GET /api/ged/connectors/:id/runs?limit` | Historique des passes, 1 à 100, défaut 20 | Liste de `GedSourceSyncRunView` |
| `GET /api/ged/connectors/:id/items?state&q&page&pageSize` | Éléments et provenance, 25 par page par défaut, 100 au plus | `{ items, total, page, pageSize }` |
| `GET /api/ged/connectors/:id/items/:itemId` | Détail d'un élément, avec `duplicateOf` | Vue ; 404 si l'élément appartient à un autre connecteur |
| `POST /api/ged/connectors/:id/oauth/start` (lot 2b) | Démarre l'autorisation OAuth : `{ redirectUri }` contrôlé par la liste blanche, renvoie l'URL du fournisseur (section 12.3) | `{ authorizationUrl, expiresInSeconds: 600 }` |
| `POST /api/ged/connectors/oauth/callback` (lot 2b) | Échange le code et enregistre le jeton chiffré (section 12.3) | `{ connectorId, authorized: true, expiresAt }` |

Précisions :

- `POST` de création : `label`, `connectorType`, `mode` (0, 1 ou 2), `config` (objet), `credentials` (objet de chaînes) **ou** `credentialsRef`, `credentialsExpiresAt`, `syncIntervalMinutes` (5 à 10 080, ou NULL), `targetDossierId`. Le corps est strict : un champ inconnu renvoie 400.
- `PUT` : ne change pas le type. `credentials` remplace l'ensemble ; `null` efface ; absent ne change rien. Le marqueur de jeton n'est remis à zéro que si `rootPath`, `host` ou `mailbox` change.
- `GET items` : filtre `state` (0 à 6), recherche `q` sur le nom, sur le chemin d'origine ou sur le préfixe de l'empreinte. Les métadonnées propres au connecteur (`origin_metadata`) ne figurent pas dans la vue.
- Codes d'erreur : 400 pour une configuration ou des droits invalides, un groupe inexistant, un dossier cible introuvable, une référence hors liste blanche ; 404 pour un connecteur ou un élément inconnu ; 409 pour une passe déjà en cours ou un connecteur inactif ; 503 si `GED_CONNECTOR_KEY` manque ou est invalide alors qu'il faut chiffrer.
- Lot 2b : les deux routes OAuth sont réservées aux administrateurs (garde du contrôleur). Codes HTTP du module, dans l'ordre des contrôles. `oauth/start` : 404 connecteur inconnu ; 400 type non OAuth ou URI hors liste ; 503 `GED_CONNECTOR_KEY` absente ou invalide ; 409 variables du fournisseur absentes ou liste blanche vide (noms seulement). `oauth/callback` : 503 clé absente ou invalide ; 400 `state` invalide, expiré ou altéré (même message), rejeu, enregistrement incohérent, échange refusé ; 403 `state` lié à un autre administrateur (non consommé) ; 404 connecteur introuvable ; 409 configuration du fournisseur.

## 9. Variables d'environnement

Aucune de ces variables n'est déclarée dans `apps/api/src/config/env.ts` ni dans `apps/worker/src/config/env.ts` (voir section 11). Elles sont documentées en commentaire, sans valeur, dans `.env.example`, et lues directement dans l'environnement du processus. Les six variables OAuth du lot 2b suivent la même règle (point 38 de la section 11).

| Variable | Lue par | Rôle |
|---|---|---|
| `GED_CONNECTOR_KEY` | API, worker | Clé active, base64 de 32 octets. Absente : chiffrement refusé (503 côté API), passe mise en erreur côté worker. Dérive aussi la clé de signature des `state` OAuth (lot 2b, section 12.3). |
| `GED_CONNECTOR_KEY_ID` | API, worker | Identifiant de la clé active, défaut `k1`. |
| `GED_CONNECTOR_KEY_PREVIOUS` | API, worker | Anciennes clés `id:base64,id:base64`, en déchiffrement seulement. |
| `GED_CONNECTOR_SECRET_<NOM>` | API, worker | Objet JSON d'identifiants, désigné par `credentials_ref`. Seul ce préfixe est accepté. |
| `GED_CONNECTOR_FS_ROOTS` | API, worker | Racines autorisées pour le dossier surveillé, séparées par le séparateur de chemins du système. Absente : aucun dossier accepté. |
| `GED_CONNECTOR_ALLOWED_INTERNAL_HOSTS` | API, worker | Liste blanche SSRF : noms exacts, adresses, CIDR (7.3). |
| `ARCHIVES_PATH` | API, worker | Coffre des archives. Un dossier surveillé ne doit pas le recouvrir. |
| `REDIS_URL` | API, worker | Connexion de la file `ged-connector-sync`, du planificateur et du magasin d'état OAuth (lot 2b). |
| `GED_GOOGLE_CLIENT_ID` | API, worker | Identifiant client OAuth Google (type « application web »). Absente : `OAuthConfigError`, qui cite le nom de la variable. |
| `GED_GOOGLE_CLIENT_SECRET` | API, worker | Secret client Google. Jamais journalisé, jamais placé dans une URL. |
| `GED_MS_CLIENT_ID` | API, worker | Identifiant d'application (client) Microsoft Entra. |
| `GED_MS_CLIENT_SECRET` | API, worker | Secret client Microsoft. |
| `GED_MS_TENANT` | API, worker | Locataire Microsoft, obligatoire : GUID, nom de domaine, ou `common` / `organizations` / `consumers`. La valeur entre dans le chemin des URL : seule cette forme passe. |
| `GED_OAUTH_REDIRECT_URIS` | API seulement | Liste blanche des URI de retour, séparées par des virgules. Correspondance exacte ; https, ou http pour `localhost` et `127.0.0.1` seulement. Lue à chaque démarrage d'autorisation ; vide = 409. |

## 10. Tests

Commandes, avec les résultats constatés sur la copie de travail le 2026-11-20 :

```
pnpm --filter @archivage/connectors test
pnpm --filter @archivage/worker test -- connectors ingestion-external
pnpm --filter @archivage/api test -- modules/connectors
pnpm --filter @archivage/connectors lint        # non exécutée pour ce document
pnpm --filter @archivage/worker lint            # non exécutée pour ce document
pnpm --filter @archivage/api lint               # non exécutée pour ce document
```

- `packages/connectors` : 6 suites, 391 tests, tous réussis (`crypto.spec.ts`, `ssrf.spec.ts`, `registry.spec.ts`, `rights.spec.ts`, `connectors/filesystem.spec.ts`, `connectors/imap.spec.ts`).
- Worker : 3 suites, 59 tests, tous réussis (`processors/connectors/sync-engine.spec.ts`, `processors/connectors/sync.processor.spec.ts`, `processors/ingestion-external.spec.ts`).
- API : 3 suites, 129 tests, tous réussis (`modules/connectors/connectors.service.spec.ts`, `connectors.controller.spec.ts`, `connectors.dto.spec.ts`).

Les tests du moteur utilisent un magasin, une ingestion, une file d'IA et un connecteur simulés en mémoire, sans réseau ni disque réel. Les tests IMAP et dossier utilisent des fournisseurs simulés injectés par `deps`.

## 11. Écarts et limites connues

### 11.1 Écarts entre le brief de lot et le code

1. Écran d'administration : livré dans `apps/web/app/connecteurs/` (liste `/connecteurs`, formulaire de création et de modification, détail `/connecteurs/[connectorId]` avec les onglets « Synchronisations » et « Éléments et provenance »). Il n'est pas décrit plus avant ici ; l'API reste décrite en section 8.
2. Contrôle de rotation : aucune route ne renvoie `credentials_key_id`. L'étape 4 de la procédure passe donc par une requête SQL (section 7.2). La route `rotate-keys` existe et correspond au plan.
3. Variables d'environnement : `GED_CONNECTOR_KEY`, `GED_CONNECTOR_KEY_ID`, `GED_CONNECTOR_KEY_PREVIOUS`, `GED_CONNECTOR_FS_ROOTS`, `GED_CONNECTOR_ALLOWED_INTERNAL_HOSTS` et `GED_CONNECTOR_SECRET_*` ne figurent pas dans les schémas d'environnement de l'API et du worker. Elles sont documentées en commentaire, sans valeur, dans `.env.example`, mais aucun contrôle au démarrage : une faute de frappe n'apparaît qu'au premier usage.
4. Réinitialisation du jeton : les messages d'erreur du dossier et de l'IMAP demandent de « réinitialiser le jeton ». Aucune route ne le fait. Seul un changement de `rootPath`, `host` ou `mailbox` le remet à NULL.
5. Garde SSRF et environnement injecté : `assertPublicHost` lit `GED_CONNECTOR_ALLOWED_INTERNAL_HOSTS` dans `process.env`, et non dans l'environnement injecté (`deps.env`). En production la valeur est la même ; un test qui fournit un environnement différent ne l'atteint pas.
6. Deux `redactSecrets` : `crypto.ts` (valeurs de 4 caractères au moins, formes URL, JSON et base64) et `imap-errors.ts` (3 caractères au moins, texte brut seulement). Les erreurs IMAP passent par les deux, dans cet ordre.

### 11.2 Limites du code

Sources et détection :

7. **Pas de détection de suppression IMAP.** `deletedExternalIds` est toujours vide. Un message ou une pièce supprimés dans la boîte ne changent rien dans DocuPro.
8. **Suppressions du dossier partielles.** `findMissing` ne s'exécute qu'en fin de passe complète, et ne concerne que les états « Copié », « Indexé en place » et « Modifié à la source ». Un doublon, un élément en erreur ou un élément découvert n'est jamais évalué.
9. **Fichier arrivé avec une date ancienne.** Le jeton du dossier est le couple (date de modification, chemin). Un fichier qui arrive avec une date antérieure au dernier élément rendu n'est jamais repris, car le curseur ne revient pas en arrière. C'est le cas d'une copie qui conserve les dates, ou d'un déplacement depuis un autre dossier. Il n'existe pas de remise à zéro du jeton par l'API (point 4).
10. **Renommage ou déplacement.** Le chemin est l'identifiant : un fichier déplacé devient un nouvel élément, et l'ancien passe « Supprimé à la source » en fin de passe. Le document n'est pas renommé. Le nouvel élément devient un doublon si l'ancien est encore « Copié » au moment où il est traité : c'est l'ordre des opérations qui décide, sans contrôle explicite.
11. **Détection de fin d'écriture.** Elle repose sur la seule date de modification (30 secondes par défaut). Une écriture faite par lots espacés de plus de ce délai peut être lue entre deux lots. Aucun contrôle de taille stable ni de verrou n'est fait.
12. **Parcours complet à chaque page.** Chaque page de 100 éléments refait un parcours complet du dossier. Une passe de 2 000 éléments refait donc jusqu'à 20 parcours : le coût suit la taille de l'arborescence, pas le nombre de nouveautés.
13. **Lecture intégrale en mémoire.** Chaque fichier est chargé en entier dans un `Buffer` (jusqu'à 50 Mio), et deux passes peuvent tourner en parallèle.
14. **Quotas.** Seul l'IMAP lève `ConnectorQuotaError`, par reconnaissance des messages de limitation du serveur. Le dossier n'en lève jamais. Aucun quota n'est configurable par connecteur.

Écritures et atomicité :

15. **Création non atomique, rejeu idempotent.** Le document est créé avec le rattachement de l'élément (`connect` de `ged_source_item`, dans la même écriture) : l'élément porte son `document_id` dès la création. Si le worker s'arrête avant la mise à jour finale de l'élément, le rejeu adopte le document orphelin (élément avec `document_id`, état « Découvert » ou « En erreur ») au lieu d'en recréer un. En synchro, `addVersionFromSource` ne crée pas de version si la version courante porte déjà la même empreinte. Il ne reste que la réécriture idempotente des octets sur le coffre et le nouveau scellement. Si la source a changé entre l'arrêt et le rejeu, une version supplémentaire légitime est créée.
16. **Droits non répercutés.** Ni en copie ni en synchro, les droits d'origine sont mis à jour dans `origin_acl`, mais les permissions du document ne le sont pas. Un droit retiré à la source reste donc actif dans DocuPro, et un droit ajouté n'est pas accordé. C'est le point le plus sensible de ce lot. **Décision métier en attente** (encadré en tête de document) : révocation automatique ou alerte, à trancher. Le comportement actuel est volontairement inchangé.
17. **`granted_by`.** Les droits créés par l'ingestion portent comme `granted_by` l'identifiant du groupe bénéficiaire. La convention de `grant-permission.ts` met l'auteur de l'octroi. La trace d'audit des droits est donc inexacte.
18. **Changement de mode.** Aucun élément déjà traité n'est converti. Un élément copié, modifié, puis traité en indexation en place perd son `document_id`, alors que le document reste dans DocuPro.
19. **Anti-concurrence quasi atomique.** Après `createRun`, le moteur relit les passes « En cours » du connecteur : la passe d'identifiant le plus petit continue, les autres sont retirées par `SyncStore.deleteRun`. Il subsiste une fenêtre de quelques millisecondes (deux insertions validées dans l'ordre inverse de leurs identifiants, chacune relisant avant la validation de l'autre) où deux passes peuvent coexister. Les conséquences sont bornées : rejeu idempotent (point 15), jeton avancé seulement après une page entière. Un vrai verrou demanderait une colonne ou un verrou consultatif PostgreSQL, hors périmètre sans changement de schéma. La reprise planifiée (identifiant horodaté) ne partage pas d'identifiant avec le `tick` ni avec la passe manuelle.
20. **Connecteur en échec répété.** Un connecteur en erreur ou en autorisation expirée reste planifié à sa cadence. Il n'y a ni recul progressif, ni limite d'éléments en erreur : chaque passe rejoue tous les éléments en erreur.
21. **Doublons entre sources.** Le doublon n'ajoute aucun droit à l'original (4.3). Une personne qui n'a accès qu'à la seconde source ne voit pas le document, sans signal côté DocuPro.
22. **Clé sans identifiant.** Une ligne avec `credentials_enc` renseigné et `credentials_key_id` NULL ne se déchiffre jamais, car il n'existe pas de clé par défaut. Le worker la passe en erreur, et `rotate-keys` la journalise. Une correction manuelle en base est nécessaire.
23. **Clé par défaut `k1`.** Si `GED_CONNECTOR_KEY_ID` n'a jamais été défini, la clé porte l'identifiant `k1`. La rotation doit alors mettre `k1` dans `GED_CONNECTOR_KEY_PREVIOUS`.

Indexation en place et texte :

24. **Texte indexé hors de la recherche.** Le texte est dans `origin_metadata.indexedText`, et jamais dans `ged_document_chunk` ni dans `DocumentFile.ocrText`. Il est donc hors de la recherche documentaire et du pipeline IA. Il n'est pas exposé par l'API (la vue n'inclut pas `origin_metadata`), mais aucun droit DocuPro ne le protège encore : la recherche de ce texte est à traiter avec le lot suivant.
25. **Extraction limitée.** Seuls `.txt`, `.csv`, `.md`, `.html`, `.htm` et `.pdf` (couche texte, sans OCR) donnent un texte. Une image ou un PDF scanné reçoit `ocr_text` NULL, et le pipeline IA le constate comme `no_text`. Cette limite vaut aussi en copie et en synchro. Bornes d'extraction : voir 5.7 (HTML tronqué à 2 Mio, PDF au-delà de 500 pages ou au-delà de 30 s : texte NULL).
26. **Doublons en indexation.** Un élément indexé en place identique à une copie devient un doublon, sans texte indexé. Les types non extractibles ne sont pas dédoublonnés.

IMAP :

27. **Principal unique.** Le seul principal est le login du compte, avec un droit de lecture. Le mapping suppose donc un groupe DocuPro rattaché à ce login ; sinon, le repli s'applique.
28. **Pièces ignorées sans trace.** Les images de moins de 10 Ko, les images inline et les pièces dont l'extension n'est pas autorisée sont ignorées au listage sans être comptées ni journalisées.
29. **Pas d'OCR sur les pièces.** Une pièce jointe numérisée reçoit `ocr_text` NULL, comme au point 25.

Dossier, ACL :

30. **Pas d'ACL sous Windows.** Sans bits POSIX (Windows, SMB sans mapping), aucune ACL n'est lue : seuls les groupes de repli s'appliquent.
31. **Lecteurs « autres » ignorés.** Un fichier lisible par tous à la source n'est restreint qu'aux groupes mappés ; l'entrée `public` ne donne aucun droit et n'en retire aucun.

Exploitation :

32. **Jeton illisible bloquant.** Un jeton lu comme illisible fait échouer la passe à chaque tick, jusqu'à intervention manuelle. Il n'existe pas de remise à zéro directe ; seul un changement de réglage identitaire (point 4) remet le jeton à NULL.
33. **Documentation d'exploitation.** Les variables de la section 9 ne sont déclarées dans aucun schéma d'environnement ; `.env.example` les documente seulement en commentaire, sans contrôle au démarrage. La procédure de rotation (section 7.2) est la seule description complète.

Lot 2b : câblage et écarts avec le brief

34. **Worker : variables OAuth.** `connectorEnv()` transmet désormais `GED_GOOGLE_CLIENT_ID`, `GED_GOOGLE_CLIENT_SECRET`, `GED_MS_CLIENT_ID`, `GED_MS_CLIENT_SECRET` et `GED_MS_TENANT` au connecteur, et seulement elles en plus des trois variables d'origine (pas de `JWT_SECRET`). Testé dans `sync.processor.spec.ts`.
35. **Worker : rotation du jeton Microsoft persistée.** Le worker fournit `deps.onCredentialsChanged` : le nouveau jeton de rafraîchissement est chiffré avec la clé active et écrit par `updateMany` gardé sur l'ancien chiffré (une édition concurrente n'est pas écrasée). Identifiants par référence : rien n'est réécrit. Le comportement réel de Microsoft après rotation reste à confirmer avec un compte réel.
36. **Module API OAuth : écarts avec le brief.** Le module est présent (`oauth.service.ts`, `oauth.controller.ts`, `oauth-state.store.ts`, `oauth.dto.ts`) et couvert par des specs (section 15). Le brief ne fixait pas les codes HTTP : ceux de la section 8 sont ceux du code. Le brief ne prévoyait pas non plus le contrôle de `isActive` ni le refus de `credentials` pour les types OAuth (points 57 et 58).
37. **Magasin d'état : pas de GETDEL.** Le brief prévoit `GETDEL`. Le code lit et supprime l'état par un script Lua (`GET` puis `DEL`, atomique), pour ne pas dépendre de Redis 6.2 ou plus. L'usage unique est le même.
38. **Variables OAuth absentes des schémas d'environnement.** Comme le point 33, les six variables du lot 2b ne figurent dans aucun schéma d'environnement ; `.env.example` les documente en commentaire seulement.
39. **Messages « réinitialisez le jeton ».** Les messages Google Drive (jeton de changement illisible, réponse 400) et Microsoft Graph (jeton expiré, 410) demandent de réinitialiser le jeton. Aucune route ne le fait (même cause que le point 4).

Lot 2b : sources, détection et périmètre

40. **Outlook : suppressions en mémoire de la passe.** Les messages marqués `@removed` sont retenus dans la mémoire de l'instance du connecteur, et `findMissing` ne répond que pour cette instance. `deletedExternalIds` est toujours vide. Si la passe s'interrompt après que le jeton a avancé, la suppression est perdue (limite notée en tête de `microsoft-outlook.ts`).
41. **Outlook : messages déplacés et identifiants.** Un message déplacé hors du dossier suivi est vu comme supprimé. Les identifiants Graph des messages ne sont pas immuables : un message déplacé peut changer d'identifiant. Les doublons de contenu sont alors écartés par empreinte côté moteur (limite notée en tête de `microsoft-outlook.ts`).
42. **Outlook : pièces jointes et pagination.** Une page peut produire plus d'éléments que `pageSize`, car la pagination porte sur les messages. Au-delà de 5 pages de pièces jointes pour un même message, les suivantes sont ignorées sans erreur (`MAX_ATTACHMENT_PAGES`). Un message disparu entre le delta et la lecture (404) est ignoré sans trace.
43. **Outlook : pièces écartées sans trace.** Les pièces jointes non fichier (messages joints, liens), les images incorporées (tant que `includeInlineImages` est faux), les images de moins de 10 Ko et les extensions hors liste sont écartées au listage sans être comptées.
44. **Sortie du périmètre non signalée.** Un élément déplacé hors du dossier suivi (`folderId` pour Google Drive, `folderPath` pour OneDrive et SharePoint, `folder` pour Outlook) n'est ni repris ni signalé supprimé. Il reste dans son état précédent (« Copié », etc.).
45. **Google Drive : coût de la restriction à un dossier.** Pour chaque fichier listé, les parents sont remontés par des appels `files.get` non mis en cache, jusqu'à 20 niveaux. Le cache de parents compte 5 000 entrées au plus et est vidé à saturation. Le coût n'a pas été mesuré.
46. **SharePoint : recherche de bibliothèque.** Une bibliothèque nommée (`libraryName`) est cherchée sur 5 pages de bibliothèques au plus. Au-delà, le connecteur répond « introuvable », même si la bibliothèque existe sur une page non lue.
47. **Google : export et taille.** Le code affiche la limite de 10 Mo imposée par Google pour les exports (réponse 403 `exportSizeLimitExceeded`). Cette valeur n'est pas vérifiée contre la documentation Google. Un export est chargé en mémoire ; les fichiers natifs n'ont pas de taille connue au listage, donc la borne de 50 Mio n'est appliquée qu'après téléchargement.
48. **Droits : repli plus ouvert que la source.** Le repli (`rights.fallbackUserGroupIds`) s'applique aussi lorsque l'ACL est lisible mais qu'aucun de ses principaux n'est mappé : le groupe de repli reçoit alors la Consultation. Le document peut donc être ouvert à plus de personnes que dans la source, ce qui contredit la règle « jamais plus ouvert qu'à la source » de la section 7.4. Le cas est traité dans `rights.ts`, mais la règle de la section 7.4 n'est pas tenue. À trancher avec la décision du point 16.
49. **Droits : principal Outlook non vérifié.** Le principal des droits d'origine est l'adresse `mailboxAddress` saisie. Elle n'est pas comparée au compte qui a autorisé l'accès, qui est celui dont la boîte est lue (`/me`).

Lot 2b : jetons, OAuth et tests (non vérifiable sans compte réel)

50. **Consentement granulaire Google.** Une case décochée est détectée à l'échange : le code refuse l'autorisation (« autorisation incomplète »). Ce comportement n'a pas été confronté à Google.
51. **Expiration des jetons Google en mode test.** Le brief et le guide de la section 12.2 indiquent une validité de 7 jours en mode test. Le code ne fixe une échéance que si la réponse contient `refresh_token_expires_in`. La durée réelle n'est pas vérifiée.
52. **Microsoft : rotation et échéance.** Le code ne calcule aucune échéance pour Microsoft, et la durée de validité du jeton de rafraîchissement (inactivité, rotation) n'est pas modélisée. La rotation EST persistée par le worker (point 35) et par le test de connexion de l'API ; un échec d'enregistrement donne un seul avertissement sans détail. Rien de cela n'a été vérifié contre un locataire réel.
53. **Redirection de téléchargement Graph.** Les hôtes de téléchargement réellement renvoyés par Graph (SharePoint, OneDrive) ne sont pas vérifiés. La liste de suffixes admis (`OAUTH_DOWNLOAD_HOST_SUFFIXES`) suit la documentation, et l'exception est décrite en section 14.
54. **Réponses simulées.** Les tests des connecteurs et du socle OAuth s'appuient sur des réponses simulées d'après la documentation de Drive v3, de Graph v1.0 et du point de jeton OAuth. Aucun test n'a été lancé contre Google ou Microsoft : aucun compte réel n'était disponible.
55. **Tests web non lancés.** Le script `test` du paquet `apps/web` affiche « no tests yet ». `apps/web/app/connecteurs/_tests/oauth.test.ts` n'est lancé par aucune commande du paquet à la date de rédaction (à vérifier avec le chef de lot).
56. **Tests du lot 2b côté worker.** `sync.processor.spec.ts` couvre le câblage de `connectorEnv()` (variables OAuth transmises, `JWT_SECRET` non transmis) et la persistance chiffrée de la rotation du jeton (point 35). Les connecteurs OAuth eux-mêmes sont testés dans `packages/connectors` (section 15) ; les specs du module API passent.
57. **Connecteur désactivé ré-autorisé.** Le callback conserve l'état : un connecteur inactif reste « Inactif » après autorisation (le moteur l'ignore de toute façon). Ni `oauth/start` ni `oauth/callback` ne vérifient `isActive`.
58. **Jeton saisi à la main : refusé.** `POST` et `PUT` des connecteurs répondent 400 si `credentials` ou `credentialsRef` sont fournis pour un type qui porte `oauth` (`google_drive`, `microsoft_*`) : seul le flux `oauth/start` puis `oauth/callback` pose le jeton. `credentials: null` (effacer l'autorisation) reste permis. Les identifiants par référence ne servent donc pas aux types OAuth.
59. **Longueur du jeton de rafraîchissement.** `credentialsSchema` des quatre connecteurs OAuth accepte un `refreshToken` de 1 à 16 384 caractères, aligné sur `MAX_REFRESH_TOKEN_LENGTH` de l'échange (16 Kio). Le test de connexion de l'API enregistre lui aussi un jeton tourné (chiffré, garde optimiste).

## 12. Connecteurs OAuth 2.0 (lot 2b)

Le lot 2b ajoute quatre connecteurs dont l'accès à la source passe par une autorisation OAuth 2.0 (code et PKCE) au lieu d'identifiants saisis : Google Drive, Microsoft OneDrive, Microsoft SharePoint et Microsoft Outlook (pièces jointes). Ils partagent le socle `oauth-contract.ts`, `oauth.ts`, `oauth-http.ts` et `oauth-session.ts`, et, pour Microsoft, le module `connectors/microsoft-graph.ts`. Tous sont en lecture seule : toutes les requêtes d'API sont des `GET` ; seul le point de jeton reçoit des `POST`.

### 12.1 Types ajoutés

| Type | Libellé | Modes | Périmètres demandés | Fichier |
|---|---|---|---|---|
| `google_drive` | Google Drive | 0, 1, 2 | `https://www.googleapis.com/auth/drive.readonly` | `connectors/google-drive.ts` |
| `microsoft_onedrive` | Microsoft OneDrive | 0, 1, 2 | `offline_access`, `Files.Read` | `connectors/microsoft-onedrive.ts` |
| `microsoft_sharepoint` | Microsoft SharePoint | 0, 1, 2 | `offline_access`, `Sites.Read.All` | `connectors/microsoft-sharepoint.ts` |
| `microsoft_outlook` | Microsoft Outlook (pièces jointes) | 0, 2 | `offline_access`, `Mail.Read` | `connectors/microsoft-outlook.ts` |

Modes : 0 Copie, 1 Indexation en place, 2 Synchronisation (section 3). L'indexation en place est refusée pour Outlook. Les quatre types n'ont aucun champ d'identifiants saisi (`credentialFields` vide) : le bouton d'autorisation renseigne `credentials` (jeton de rafraîchissement et périmètre accordé). `GET /api/ged/connectors/types` expose le fournisseur et les périmètres dans `oauth` (`GedConnectorTypeInfo`).

### 12.2 Enregistrer l'application OAuth (administrateur du client)

Cette opération se fait une fois, par l'administrateur du client (propriétaire du projet Google Cloud ou administrateur de l'annuaire Microsoft Entra). Les valeurs produites vont dans l'environnement de l'API et du worker (section 9), jamais dans le dépôt ni dans un document. L'URI de retour se présente sous la forme `https://<hôte-de-la-GED>/connecteurs/oauth/callback` (espace réservé).

**Google Cloud** (console Google Cloud, projet réservé à la GED)

1. Créer ou choisir un projet Google Cloud réservé à la GED.
2. Activer l'API Google Drive pour ce projet. Le code appelle `https://www.googleapis.com/drive/v3`.
3. Configurer l'écran de consentement OAuth. Type d'utilisateur « Interne » si le client est un Google Workspace et que seuls ses comptes autorisent la GED, « Externe » sinon. Ajouter le périmètre `https://www.googleapis.com/auth/drive.readonly`, et lui seul.
4. Créer un identifiant client OAuth de type « Application Web » (l'URI de retour est une page web). Ajouter comme URI de redirection autorisée l'URI de la page de retour, identique à une entrée de `GED_OAUTH_REDIRECT_URIS` : même schéma, même hôte, même chemin `/connecteurs/oauth/callback`.
5. Renseigner `GED_GOOGLE_CLIENT_ID` et `GED_GOOGLE_CLIENT_SECRET` dans l'environnement de l'API, et du worker une fois le point 34 corrigé.
6. Points à confirmer dans la documentation Google à la mise en service. Le code ne les vérifie pas et aucun test n'a été fait contre Google (points 50 et 51) :
   - en mode test, les jetons de rafraîchissement expirent au bout de 7 jours, et seuls les comptes déclarés « utilisateurs test » peuvent autoriser l'application ;
   - `drive.readonly` est un périmètre dit « sensible » : une application externe ouverte à plusieurs organisations exige en principe une vérification Google avant publication. Une application interne à un Workspace n'est pas concernée ;
   - le consentement de Google est granulaire : l'utilisateur peut décocher un périmètre. Le code refuse alors l'autorisation (section 12.3, étape 6).

**Microsoft Entra** (centre d'administration Entra, inscription d'application dédiée)

1. Inscriptions d'applications, puis Nouvelle inscription. Type de compte : « Comptes de cet annuaire uniquement » (locataire unique). Le code accepte aussi les alias `common`, `organizations` et `consumers`, mais ils ne sont pas testés.
2. Authentification, puis Ajouter une plateforme, « Web ». L'URI de redirection doit être identique à une entrée de `GED_OAUTH_REDIRECT_URIS`.
3. Certificats et secrets, puis Nouveau secret client. La valeur n'est affichée qu'une fois : la copier dans `GED_MS_CLIENT_SECRET`. Noter la date d'expiration du secret : à son échéance, les passes Microsoft échouent avec « Identifiants de l'application Microsoft refusés (invalid_client) », et le connecteur passe « En erreur » (section 13.6).
4. Autorisations d'API, puis Ajouter une autorisation, Microsoft Graph, Autorisations déléguées : `Files.Read` (OneDrive), `Sites.Read.All` (SharePoint), `Mail.Read` (Outlook) et `offline_access`. Ces périmètres minimaux sont déduits de la documentation de Microsoft Graph : à confirmer avec un vrai locataire (en particulier la lecture des permissions d'éléments et du delta avec `Files.Read` seul, et celle d'une bibliothèque SharePoint avec `Sites.Read.All` seul). Ne déclarer que les permissions des types réellement utilisés. Le code ajoute `offline_access` à la demande s'il manque.
5. Selon la politique du locataire, ces permissions peuvent exiger le consentement d'un administrateur (« Accorder le consentement administrateur »). Sans ce consentement, l'autorisation d'un compte peut échouer côté Microsoft. Le message renvoyé par Microsoft n'est pas vérifié par le code.
6. Renseigner `GED_MS_CLIENT_ID` (identifiant d'application), `GED_MS_CLIENT_SECRET` et `GED_MS_TENANT` (identifiant de l'annuaire, GUID, ou nom de domaine). Sans `GED_MS_TENANT`, la configuration Microsoft est refusée, et le message cite le nom de la variable.
7. Choisir le compte qui autorise, selon le connecteur. OneDrive et Outlook appellent `/me` : c'est le OneDrive du compte, ou la boîte du compte, qui est lu. SharePoint n'appelle pas `/me` : le compte voit ce qu'il a le droit de voir sur le site. Pour Outlook, l'adresse `mailboxAddress` n'est pas comparée au compte qui autorise (point 49).

### 12.3 Flux d'autorisation pas à pas

Le flux est entièrement dans le code à la date de rédaction : la page web et le socle OAuth (`oauth.ts`, `oauth-http.ts`, `oauth-session.ts`), et le module API (`apps/api/src/modules/connectors/oauth.service.ts`, `oauth.controller.ts`, magasin d'état `oauth-state.store.ts`). Les étapes 1, 3, 4 et 8 se passent dans la page web et le navigateur ; les étapes 2, 5, 6 et 7 dans le module API.

1. **Point de départ.** Le connecteur existe, son type est OAuth (`GedConnectorTypeInfo.oauth`) et il n'a pas d'identifiants (`hasCredentials` faux, statut « Non autorisé »). L'administrateur clique sur « Autoriser avec Google » ou « Autoriser avec Microsoft » (`_components/OAuthAuthorization.tsx`). Le libellé devient « Autoriser de nouveau » si une autorisation existe ou a expiré.
2. **Démarrage** (`POST /api/ged/connectors/:id/oauth/start`, corps `{ redirectUri }`, validé en mode strict). Le navigateur envoie l'origine de la GED suivie de `/connecteurs/oauth/callback`. Contrôles, dans l'ordre : connecteur existant (404) ; type OAuth (400) ; `GED_CONNECTOR_KEY` présente et valide (503) ; configuration du fournisseur (409, noms des variables manquantes seulement) ; liste blanche `GED_OAUTH_REDIRECT_URIS` non vide (409) ; URI présente à l'identique dans la liste (400). Le service crée alors un nonce de 256 bits, un couple PKCE S256 et un `state` signé en HMAC-SHA256, qui contient `n` (le nonce), `exp` (maintenant plus 600 secondes), `uid` (l'administrateur), `cid` (le connecteur) et `provider`. Il écrit dans Redis, sous le nonce, avec un TTL de 600 secondes : l'administrateur, le connecteur, le fournisseur, l'URI de retour et le vérificateur PKCE chiffré (AES-GCM, identifiant de clé enregistré). Une écriture sur un nonce déjà présent est refusée. Si la construction de l'URL échoue, l'enregistrement est retiré. Un événement d'audit `oauth-start` est écrit, sans URL ni `state`. La réponse contient `authorizationUrl` et `expiresInSeconds: 600`.
3. **Navigateur vers le fournisseur.** La page fait `window.location.assign(authorizationUrl)`. L'URL ne contient ni secret client ni jeton : `client_id`, `redirect_uri`, `scope`, `state`, `code_challenge` et `code_challenge_method=S256`. Google reçoit en plus `access_type=offline`, `prompt=consent` et `include_granted_scopes=false`. Microsoft reçoit `response_mode=query` et `prompt=select_account`, et `offline_access` est ajouté aux périmètres s'il manque.
4. **Retour sur la page web** (`oauth/callback/page.tsx`). Le fournisseur renvoie vers l'URI de retour avec `code` et `state`, ou avec `error`. `consumeOAuthReturn` lit les paramètres puis **efface l'URL** (`history.replaceState`) avant tout appel réseau. Si `error` est présent, la page affiche un refus, sans appel. Si `code` ou `state` manque, elle affiche un retour incomplet, sans appel. Sinon, un seul appel `POST /api/ged/connectors/oauth/callback` avec `{ code, state }` part, avec le jeton de l'administrateur ; une garde `started` évite le second appel du mode strict de React.
5. **Contrôle du `state`** (`callback`, côté API). Ordre : clé de chiffrement présente (503) ; signature HMAC-SHA256 vérifiée à temps constant, forme stricte, expiration. Toute erreur sur le `state` (altéré, mal formé ou expiré) donne 400 « Autorisation invalide ou expirée : recommencez ». Puis, avant toute consommation, l'identifiant de l'administrateur de la charge utile doit être celui de l'appelant : sinon 403, et le nonce n'est pas consommé. Le nonce est ensuite lu et supprimé en une seule opération (`take`) ; un rejeu ou une absence donne 400 « Autorisation déjà utilisée ou expirée ». Enfin, l'administrateur, le connecteur et le fournisseur de l'enregistrement doivent correspondre à la charge utile (400), et le connecteur doit exister (404) et être de type OAuth (400).
6. **Échange du code.** Le vérificateur PKCE est déchiffré avec la clé indiquée par `verifierKeyId` (échec : 400). `exchangeAuthorizationCode` envoie un POST au point de jeton officiel (`oauth2.googleapis.com/token` pour Google ; `login.microsoftonline.com/<locataire>/oauth2/v2.0/token` pour Microsoft). Le corps du formulaire porte `grant_type=authorization_code`, `code`, `redirect_uri`, `client_id`, `client_secret` et `code_verifier` ; Microsoft reçoit aussi `scope`. La réponse est lue dans la limite de 64 Kio, sans redirection. L'URI utilisée est celle de l'enregistrement, contrôlée au démarrage et non recontrôlée au retour. Une erreur de configuration donne 409. Toute autre erreur d'échange (refus du fournisseur, `invalid_grant` pour un code expiré ou déjà utilisé, réponse sans `refresh_token`, périmètre absent de la réponse, erreur réseau) donne 400 « Le fournisseur a refusé l'autorisation », sans détail fournisseur. Le service écrit alors un seul avertissement de journal, avec l'identifiant du connecteur et le code d'erreur interne. Le nonce a déjà été consommé à l'étape 5.
7. **Enregistrement.** Le jeton de rafraîchissement et le périmètre accordé sont chiffrés (AES-GCM, section 7.1) dans `credentials_enc`, avec `credentials_key_id` ; `credentials_ref` est remis à NULL. Le connecteur reçoit l'échéance `credentialsExpiresAt` (fournie par le fournisseur, sinon NULL), le statut « Actif », `lastError` vidé, et un jeton de changement remis à NULL pour un relistage complet à la passe suivante (section 13.2). `isActive` n'est pas modifié (point 57). Un événement d'audit `oauth-authorized` est écrit. La réponse est `{ connectorId, authorized: true, expiresAt }`, sans aucun jeton.
8. **Affichage.** La page affiche « Compte autorisé », avec l'échéance si elle est connue, puis revient à la fiche du connecteur après 1,5 seconde. En cas d'échec, elle affiche le message d'erreur, sans code, sans `state` et sans jeton.

Mesures anti-CSRF et anti-rejeu, telles que le code les pose :

- Le `state` est lié à l'administrateur, au connecteur, au fournisseur, à l'URI de retour et à un nonce à usage unique.
- Il est signé en HMAC-SHA256 avec une clé dérivée en HKDF-SHA256 de la clé active `GED_CONNECTOR_KEY` (étiquette `ged-oauth-state-v1`). La clé brute n'est jamais utilisée pour signer. Une rotation de la clé active rend invalides les `state` en cours.
- Expiration à 600 secondes, avec le même TTL côté Redis.
- Usage unique : la lecture et la suppression du nonce sont atomiques (script Lua). Un second essai ne trouve rien.
- PKCE S256 : le vérificateur (256 bits) n'est jamais stocké en clair, et l'échange le présente au fournisseur.
- URI de redirection : correspondance exacte avec la liste blanche, et la même URI est utilisée à l'autorisation et à l'échange.
- Le secret client n'apparaît que dans le corps POST de l'échange, jamais dans une URL. Les messages d'erreur sont génériques et ne citent ni code, ni state, ni vérificateur, ni jeton.
- La page nettoie l'URL avant tout appel et n'appelle l'API qu'une fois.

## 13. Connecteurs OAuth : fonctionnement

### 13.1 Réglages des types

Les schémas sont stricts : un champ inconnu fait échouer la validation. Les identifiants de drive, de dossier et de fichier sont validés par motif avant tout appel.

| Type | Réglage | Règle |
|---|---|---|
| `google_drive` | `driveId` | Identifiant de drive partagé, `[A-Za-z0-9_-]` de 5 à 128 caractères. Vide = « Mon Drive ». |
| `google_drive` | `includeSharedDrives` | Booléen, faux par défaut. Sans `driveId`, inclut les drives partagés accessibles (corpus `allDrives`). |
| `google_drive` | `folderId` | Identifiant de dossier, même forme que `driveId`. Restreint à sa descendance (20 niveaux au plus). |
| `google_drive` | `exportFormat` | `pdf` (défaut) ou `office` (docx, xlsx, pptx). Le formulaire le saisit en texte libre ; le schéma refuse toute autre valeur. Les dessins restent en PDF. |
| `google_drive` | `extensions` | 50 au plus, `.ext` en minuscules de 1 à 10 caractères alphanumériques. Ne peut que restreindre la liste commune. |
| `microsoft_onedrive` | `folderPath` | 500 caractères au plus, sans caractère de contrôle. Vide = tout le OneDrive. Filtre client insensible à la casse, sur frontière de segment. |
| `microsoft_onedrive` | `extensions` | 1 à 30 entrées, avec ou sans point, 1 à 10 caractères alphanumériques. |
| `microsoft_sharepoint` | `hostname` | Requis. Doit se terminer par `.sharepoint.com` (253 caractères au plus). Jamais appelé directement. |
| `microsoft_sharepoint` | `sitePath` | Requis. `/sites/<nom>` ou `/teams/<nom>`, nom de 1 à 128 caractères `[A-Za-z0-9._~-]`. |
| `microsoft_sharepoint` | `libraryName` | Facultatif. Vide = bibliothèque par défaut du site. Recherche insensible à la casse sur 5 pages de bibliothèques au plus (point 46). |
| `microsoft_sharepoint` | `folderPath`, `extensions` | Comme pour OneDrive. |
| `microsoft_outlook` | `mailboxAddress` | Requis. Adresse e-mail de 3 à 320 caractères. Principal des droits d'origine (13.4, point 49). |
| `microsoft_outlook` | `folder` | Défaut `inbox`. Nom connu ou identifiant de dossier, `[A-Za-z0-9_=-]`, 300 caractères au plus. |
| `microsoft_outlook` | `includeInlineImages` | Faux par défaut. Les images de moins de 10 Ko restent écartées dans tous les cas. |
| `microsoft_outlook` | `extensions` | Comme pour OneDrive. |

Identifiants : Google Drive accepte `refreshToken` (1 à 16 384 caractères) et `scope` facultatif (2 000 au plus). Les trois types Microsoft acceptent `refreshToken` (1 à 16 384 caractères) et `scope` facultatif (4 096 au plus). Aucun ne lit de jeton d'accès.

### 13.2 Jetons de changement

Google Drive. Le jeton est un JSON à deux formes :

- pendant le listage complet, il porte la page suivante (`t`) et le jeton de départ (`s`), pris avant le premier appel `files.list` (`changes/startPageToken`) ; le listage trie sur `modifiedTime` et exclut les fichiers à la corbeille (`q=trashed=false`) ;
- ensuite, il porte le jeton de `changes.list` (`p: chg`) ; `includeRemoved=true` ; `restrictToMyDrive` n'est envoyé que si aucun drive partagé n'est visé. Le dernier `newStartPageToken` devient le jeton suivant.

Microsoft Graph (OneDrive, SharePoint, Outlook). Le jeton est un JSON `{ k, u }` : `k` vaut `next` (page suivante du parcours en cours, à partir du `@odata.nextLink`) ou `delta` (parcours terminé, base du prochain, à partir du `@odata.deltaLink`), et `u` est l'URL. Toute URL relue est exigée sous `https://graph.microsoft.com/v1.0/`. Les premiers appels sont :

- OneDrive : `/me/drive/root/delta` ;
- SharePoint : `/drives/{id}/root/delta` (le lecteur est résolu avant le listage) ;
- Outlook : `/me/mailFolders/{dossier}/messages/delta` avec `$select` limité aux champs utiles.

Le nombre d'éléments par page est transmis par l'en-tête `Prefer: odata.maxpagesize`.

Un jeton illisible fait échouer la passe, sans relistage silencieux. Un jeton accepté par le code mais refusé par Graph en 410 donne un message de « resynchronisation complète demandée », sans relistage automatique. Une nouvelle autorisation remet le jeton à NULL (`oauth.service.ts`) : la passe suivante relista la source. Les éléments déjà connus ne sont pas relus si leur version n'a pas changé (section 3).

### 13.3 Contenu des éléments

- **Google Drive, fichiers natifs.** Les Docs, Sheets, Slides et dessins sont exportés. Le format est `pdf` par défaut, ou `office` (docx, xlsx, pptx ; les dessins restent en PDF). L'extension est ajoutée au nom si elle manque, et l'élément est écarté si cette extension n'est pas retenue. La version est `modifiedTime:version`. Les autres types natifs (dossiers, raccourcis, formulaires, sites) sont ignorés au listage. Le téléchargement passe par `files/{id}/export?mimeType=…`, dont le type est contrôlé contre la table d'export avant l'appel.
- **Google Drive, fichiers binaires.** Téléchargement par `alt=media` avec `supportsAllDrives=true`. La version est `md5Checksum`, à défaut `headRevisionId`, à défaut `v<version>:<modifiedTime>`.
- **OneDrive et SharePoint.** Téléchargement par `…/items/{id}/content`, avec suivi de la redirection de téléchargement (exception décrite en section 14). La version est `sha256Hash`, à défaut `sha1Hash`, `quickXorHash`, `cTag` ou `eTag`.
- **Outlook.** Téléchargement de la pièce jointe par `…/attachments/{id}/$value`, sans redirection. La version est la taille en octets.
- **Bornes.** La taille maximale est `maxFileBytes` (50 Mio). Un fichier de taille connue au-delà de la borne est listé, puis refusé à la récupération sans téléchargement. Les extensions hors de la liste commune ne sont jamais listées.

### 13.4 Droits d'origine et mapping

Les droits sont lus à chaque passe par `readOriginAcl`. Le mapping suit la section 7.4 : seules les entrées `user` ou `group` lisibles (`read`, `write`, `owner`) sont mappées ; `public` et `unknown` ne donnent rien et n'élargissent rien.

- **Google Drive** (`permissions.list`, 100 par page, 10 pages au plus). Les permissions supprimées sont ignorées. `user` et `group` donnent le courriel en minuscules, à défaut l'identifiant de la permission (`unknown`). `domain` et `anyone` donnent `public`. Rôles : `owner` donne `owner` ; `writer`, `fileOrganizer` et `organizer` donnent `write` ; `reader` et `commenter` donnent `read` ; les autres sont `unknown`.
- **Microsoft Graph** (`permissions` de l'élément, 10 pages au plus). Un lien `anonymous` ou `organization` donne `public`, jamais mappé. Les identités donnent des utilisateurs (courriel en minuscules, à défaut identifiant d'objet) et des groupes (courriel, identifiant, puis nom affiché). Les entrées `application` et `device` sont ignorées. Rôles : `owner` ; `write`, `edit`, `contribute`, `sp.full control`, `sp.edit`, `sp.contribute` donnent `write` ; `read`, `view`, `sp.read`, `sp.view only` donnent `read`.
- **Outlook.** Une seule entrée : l'adresse de la boîte en minuscules, de type utilisateur, en lecture (point 49).

Une ACL illisible ou incomplète donne `null` : Google Drive et Graph le font après plus de 10 pages, sur une réponse 403 ou 404, et sur toute autre erreur (les autorisations et quotas se propagent). Le repli de la section 7.4 s'applique alors. Il s'applique aussi lorsque l'ACL est lisible mais sans principal mappé (point 48).

### 13.5 Suppressions à la source

- **Google Drive.** Un `removed` ou un `trashed` dans `changes.list` donne une suppression. En listage complet, un fichier à la corbeille est aussi signalé supprimé. Il n'y a pas de `findMissing`.
- **OneDrive et SharePoint.** La facette `deleted` du delta donne `deletedExternalIds`.
- **Outlook.** Les messages `@removed` sont retenus pendant la passe, et `findMissing` répond sans appel réseau, pour la même instance seulement (point 40). `deletedExternalIds` est vide.
- **Sortie du périmètre.** Un élément sorti du dossier suivi n'est pas signalé supprimé (point 44).

### 13.6 Quotas et erreurs

- **Google.** Les réponses 429, 503 et 504 sont des quotas, comme un 403 dont la raison est `rateLimitExceeded`, `userRateLimitExceeded`, `sharingRateLimitExceeded`, `quotaExceeded` ou `dailyLimitExceeded`. Les autres 403 sont des erreurs d'API ; à la récupération, le code en tire « Accès refusé à ce fichier » (élément rejeté).
- **Microsoft.** Les réponses 429, 503 et 504 sont des quotas.
- **Retry-After.** Le délai est lu en secondes ou en date HTTP (IMF-fixdate). Absent ou illisible, il vaut 60 secondes. Le client le borne entre 1 seconde et 6 heures. Le moteur ne reprend pas avant 1 minute ni après 6 heures, et utilise 15 minutes si rien n'est fourni (section 5.4). Une passe interrompue par un quota est « Partielle » et le statut du connecteur ne change pas.
- **401.** Un rafraîchissement forcé, puis un seul nouvel essai. Un second 401 donne « Accès refusé malgré un jeton neuf » (autorisation non expirée, connecteur « En erreur »).
- **Rafraîchissement refusé.** `invalid_grant`, `interaction_required`, `consent_required`, `login_required` et `invalid_scope` donnent « Autorisation expirée ou révoquée » : statut « Autorisation expirée ». `invalid_client` et `unauthorized_client` donnent « Identifiants de l'application … refusés » en citant seulement le nom des variables à vérifier : statut « En erreur ». Une autre réponse donne une erreur d'API.
- **Absence de jeton de rafraîchissement.** « Connecteur non autorisé » : statut « Autorisation expirée », sans appel réseau.
- **Google Drive, listage.** 400 donne un message de jeton périmé ou de configuration invalide ; 404 donne « Drive partagé ou dossier introuvable, ou inaccessible avec cette autorisation ».
- **Récupération.** 404 et 410 donnent « n'existe plus à la source » (élément rejeté).

### 13.7 Jeton d'accès pendant une passe

Le jeton d'accès n'est gardé qu'en mémoire. Il est réutilisé jusqu'à 60 secondes avant son expiration ; sans `expires_in`, la durée retenue est de 300 secondes. Un seul rafraîchissement est en vol à la fois : les appels concurrents l'attendent. Chaque passe construit une nouvelle instance de connecteur (`buildConnector` dans `sync.processor.ts`), donc un rafraîchissement au moins par passe. Le jeton de rafraîchissement enregistré n'est réécrit qu'en cas de rotation, et seulement si le worker fournit `onCredentialsChanged` (point 35).

## 14. Sécurité du lot 2b

- **Hôtes officiels.** Les appels ne vont qu'aux hôtes de `OAUTH_API_HOSTS`, en correspondance exacte : `www.googleapis.com`, `oauth2.googleapis.com` et `accounts.google.com` pour Google ; `graph.microsoft.com` et `login.microsoftonline.com` pour Microsoft. `accounts.google.com` ne reçoit aucun appel serveur : l'URL d'autorisation part dans le navigateur. Une URL d'API doit être en https, sur le port 443, sans identifiant, sans adresse IP littérale, sans barre oblique inversée ni caractère hors ASCII imprimable, et au plus 8 192 caractères. La vérification a lieu avant tout appel, y compris pour les `nextLink` et les URL relues en base.
- **Résolution et connexion.** L'hôte est résolu et chaque adresse est contrôlée par la garde SSRF, sans la liste blanche de l'exploitant (`GED_CONNECTOR_ALLOWED_INTERNAL_HOSTS` ne s'applique pas ici). La connexion va à l'adresse vérifiée, avec le nom officiel comme SNI et contrôle du certificat, en TLS 1.2 au minimum. Aucun agent de connexion n'est partagé. Le délai global est de 60 secondes par défaut (30 minutes au plus).
- **Redirections.** Par défaut, toute redirection est refusée. Seul le téléchargement OneDrive et SharePoint suit une redirection (point suivant).
- **Exception documentée : téléchargement Graph.** Graph répond à `…/content` par un 302 vers une URL pré-authentifiée. Le client suit cette redirection seulement si elle pointe vers `*.sharepoint.com`, `*.files.1drv.com` ou `*.1drv.com` (`OAUTH_DOWNLOAD_HOST_SUFFIXES`), avec au moins un libellé devant le suffixe. Au plus 3 sauts, en GET seulement. Les en-têtes `Authorization`, `Cookie`, `Proxy-Authorization`, ainsi que `content-length` et `content-type`, ne sont pas transmis après la redirection. La garde DNS s'applique à chaque saut. Aucun autre appel ne suit de redirection. Outlook télécharge sans redirection.
- **Jetons.** Le jeton d'accès est en mémoire seulement. Le jeton de rafraîchissement est chiffré en AES-GCM (section 7.1). Le vérificateur PKCE est chiffré dans Redis. Aucun jeton ni secret n'apparaît dans un journal, une URL ou une réponse d'API : la réponse du callback ne contient que `connectorId`, `authorized` et `expiresAt`. Les messages et les piles d'erreur sont masqués avec toutes les valeurs sensibles vues pendant la session, y compris les jetons successifs. Les modules du socle OAuth n'écrivent aucun journal. Le service API n'écrit qu'un avertissement, lorsqu'un échange est refusé : identifiant du connecteur et code d'erreur interne, jamais de détail fournisseur. Les messages réseau ne citent que le nom d'hôte et un code système filtré.
- **En-têtes.** Les en-têtes fournis par l'appelant ne peuvent ni contenir de retour ligne ni porter `Authorization`, `Cookie` ou `Proxy-Authorization` : ces en-têtes sont écartés ou refusés.
- **Bornes de taille.** Réponse de jeton : 64 Kio. Réponse JSON d'API : 25 Mio. Fichier : `maxFileBytes`, soit 50 Mio. Jeton d'accès et jeton de rafraîchissement : 16 Kio. Code d'autorisation : 4 096 caractères. `state` et URI de retour : 2 048 caractères chacun.
- **Identifiants d'objets.** Les identifiants sont validés par motif avant d'être placés dans une URL, et les segments sont encodés : Drive `[A-Za-z0-9_-]{5,128}` ; Graph `[A-Za-z0-9!_.-]{1,200}` ; Outlook `[A-Za-z0-9_=+/-]{1,400}`. Les jetons de pagination Drive sont passés en paramètres, jamais comme URL.
- **Locataire.** `GED_MS_TENANT` entre dans le chemin des URL d'autorisation et de jeton. Seuls un GUID, un nom de domaine DNS dont le dernier libellé est alphabétique, ou `common`, `organizations`, `consumers` sont acceptés.

## 15. Tests du lot 2b

| Fichier | Périmètre |
|---|---|
| `packages/connectors/src/oauth.spec.ts` | Configuration des fournisseurs (noms des variables seulement), PKCE (vecteur de la RFC 7636, annexe B), URL d'autorisation Google et Microsoft, liste blanche des URI, `state` signé (aller-retour, altérations, expiration), échange du code (succès, refus, consentement incomplet, réponses non JSON, erreurs réseau masquées). |
| `packages/connectors/src/oauth-http.spec.ts` | Client gardé : hôtes, adresses vérifiées, liste blanche de l'exploitant non appliquée, en-têtes, redirections (3 sauts admis, le quatrième refusé ; mode téléchargement), lecture bornée, délai, annulation, erreurs de transport. |
| `packages/connectors/src/oauth-session.spec.ts` | Jeton d'accès (cache, rafraîchissement unique en vol, rotation Microsoft), appels d'API (Bearer, 401, quotas, 403 Google), validation des URL, `getBytes`, session et client gardé (redirection vers SharePoint). |
| `packages/connectors/src/connectors/google-drive.spec.ts` | Définition et configuration, listage complet puis changements, drive partagé, dossier, extensions, exports natifs, téléchargement binaire, droits d'origine. |
| `packages/connectors/src/connectors/microsoft-graph.spec.ts` | Jeton de delta, `fetchDeltaPage`, chemins et extensions, `mapDriveItem`, droits (`mapGraphPermissions`, `readDriveItemAcl`). |
| `packages/connectors/src/connectors/microsoft-onedrive.spec.ts` | Définition, authentification, listage et suppressions, téléchargement, droits. |
| `packages/connectors/src/connectors/microsoft-sharepoint.spec.ts` | Résolution du site et de la bibliothèque, listage, fichiers, droits. |
| `packages/connectors/src/connectors/microsoft-outlook.spec.ts` | Listage des messages, pièces jointes, suppressions (y compris la limite de mémoire entre instances), téléchargement, droits. |
| `apps/api/src/modules/connectors/oauth.service.spec.ts` | Démarrage (URL avec `state`, PKCE S256, périmètres minimaux, TTL de 600 s, liste blanche, configuration, clé, type non OAuth), callback (autorisation et chiffrement, `expiresAt` nul, rejeu, `state` expiré ou altéré, administrateur différent sans consommation, enregistrement incohérent, connecteur supprimé, échec d'échange sans fuite), magasin d'état (usage unique, TTL), `listTypes` (expose `oauth`). |
| `apps/api/src/modules/connectors/oauth.controller.spec.ts` | Garde administrateur sur les deux routes, ordre des routes (`oauth/callback` avant `:id`), délégation au service, validation stricte des corps. |
| `apps/web/app/connecteurs/_tests/oauth.test.ts` | Statut et libellés d'autorisation, `consumeOAuthReturn` (URL effacée avant l'appel, appel unique, refus, retour incomplet, échec d'API). Non lancé par le script de test du paquet (point 55). |

Les tests des connecteurs injectent un client OAuth simulé (`deps.oauth`) ou un transport simulé (`deps.http`). Aucun ne fait d'appel réseau réel. Aucun test du worker ne couvre encore le lot 2b (point 56). Les specs du module API sont listées ci-dessus et lancées par la commande API.

Commandes :

```
pnpm --filter @archivage/connectors test
pnpm --filter @archivage/worker test -- connectors ingestion-external
pnpm --filter @archivage/api test -- modules/connectors
```

Résultats constatés le 2026-11-20 sur la copie de travail : `packages/connectors` 15 suites, 790 tests réussis (dont `oauth.spec.ts`, `oauth-http.spec.ts`, `oauth-session.spec.ts`, les specs Google Drive et Microsoft, et `connectors/oauth-integration.spec.ts`, qui exerce les connecteurs avec le vrai client OAuth sur un transport simulé) ; `apps/api` `modules/connectors` 5 suites, 160 tests réussis ; `apps/worker` `processors/connectors` 2 suites, 57 tests réussis. La suite complète du worker contient en plus `test/acquisition-live.spec.ts`, qui exige une base PostgreSQL vivante et échoue sans elle (préexistant, hors lot). Aucun test n'appelle un fournisseur réel.

## 16. Connecteur WhatsApp Business (lot 2c)

Ce connecteur (`whatsapp`, libellé « WhatsApp Business », mode copie uniquement) reçoit des documents envoyés à un numéro WhatsApp Business de l'organisation (API WhatsApp Cloud de Meta). C'est un connecteur à événements : `listChanges` renvoie toujours une page vide, aucune synchronisation périodique n'est utile.

### 16.1 Chemin d'un message

```
  Meta ─POST─► /api/ged/webhooks/whatsapp/:connectorId   (public, @Public : seule exception au « authentifié par défaut »)
                 │ 1. limite par IP  2. corps brut borné (256 Kio)  3. connecteur + secrets déchiffrés
                 │ 4. signature X-Hub-Signature-256 (HMAC-SHA256 du corps brut, temps constant)  ◄── rejet 401 ici, avant tout traitement
                 │ 5. analyse du JSON  6. fenêtre anti-rejeu  7. limite par expéditeur  8. liste blanche
                 │ 9. ged_source_item (external_id = identifiant de message : idempotence)  10. job « inbound »  → 200
                 ▼
  File « ged-whatsapp-inbound » ─► worker : whatsapp.processor.ts
                 │ liste blanche relue · Graph : URL du média (hôte officiel Meta seulement) · téléchargement borné
                 │ validation type/taille/signature binaire/empreinte · dédoublonnage SHA-256 · droits · ingestExternalFile
                 ▼
  Document (copie) + accusé « Document reçu. Référence : WA-<id> » à l'expéditeur
```

Fichiers : `packages/connectors/src/whatsapp-{webhook,graph,media,messages,senders,config,phone}.ts` et `connectors/whatsapp.ts` ; API `apps/api/src/modules/connectors/whatsapp-{webhook.controller,webhook.service,queue.provider,raw-body}.ts` ; worker `apps/worker/src/processors/connectors/whatsapp.processor.ts` et `whatsapp-rate-limit.ts` ; web `apps/web/app/connecteurs/_components/Whatsapp*.tsx`. Contrat partagé : bloc « Lot 2c » de `packages/types/src/ged-connectors.ts`.

### 16.2 Configuration

- `config` : `phoneNumberId` (identifiant du numéro chez Meta), `graphApiVersion` (défaut `v21.0`), `senders` (liste blanche : numéros internationaux en chiffres, libellé facultatif, 500 au plus, doublons refusés), `maxFileBytes` (resserre seulement le plafond de 50 Mio), `ackEnabled` (défaut oui), `refuseUnknownSenders` (défaut non : silence). Aucun champ d'hôte ou d'URL : la surface SSRF de la configuration est nulle.
- Groupe d'un expéditeur : `rights.principalMap` avec la clé `wa:<chiffres>` (mécanisme existant, section 7.4). Un expéditeur sans entrée reçoit `rights.fallbackUserGroupIds`, jamais vide. Le formulaire web construit ces clés ; par l'API, une clé `wa:` non canonique (par exemple `wa:+221…`) ne correspond à aucun expéditeur, qui retombe alors sur le repli (le plus restrictif).
- Identifiants (chiffrés au repos comme en 7.1, via `credentials_enc` et `GED_CONNECTOR_KEY`, ou `credentials_ref`) : `accessToken` (jeton d'utilisateur système recommandé), `appSecret` (secret de l'application, sert à la signature), `verifyToken` (jeton du challenge GET). `verifyToken` doit différer d'`appSecret` et d'`accessToken`. L'API ne les renvoie jamais ; la page web affiche seulement « secrets enregistrés » ; le remplacement se fait en une fois (les trois valeurs).
- URL à déclarer dans la console Meta : `https://<adresse publique de l'API>/api/ged/webhooks/whatsapp/<id du connecteur>` (affichée sur la page du connecteur), avec le Verify token et l'abonnement au champ `messages`.

### 16.3 Sécurité du webhook

- Signature obligatoire : un corps sans signature valide est rejeté en 401 avant tout `JSON.parse`, tout accès en écriture, toute mise en file. Les 401 sont identiques pour un connecteur inconnu, inactif, au secret illisible ou à la signature fausse (pas d'énumération). Le corps est lu en octets (middleware dédié `whatsapp-raw-body.ts`, branché dans `main.ts`), 256 Kio au plus (413) ; un `Content-Encoding` autre que l'identité est refusé (415).
- Challenge GET : mode `subscribe`, jeton comparé à temps constant, valeur du challenge restreinte à `[A-Za-z0-9_-]{1,200}` (réponse `text/plain`).
- Anti-rejeu : fenêtre sur l'horodatage du message (1 h par défaut, 5 min d'avance tolérée) et idempotence par identifiant de message (unicité `(connector_id, external_id)`). Le rejeu d'un message encore « Découvert » est ré-enfilé (job perdu), sinon ignoré.
- Limites de débit : par IP (300/min) et par expéditeur (60 par 10 min) côté API ; côté worker, 10 accusés/heure/expéditeur, 60 envois/min/connecteur, 1 refus/heure/expéditeur (Redis si disponible, sinon mémoire).
- Média : l'URL renvoyée par Graph doit être en `https`, port 443, sans identifiants, hôte exact ou sous-domaine strict de `graph.facebook.com`, `*.fbsbx.com`, `*.fbcdn.net`, `*.whatsapp.net`, `*.whatsapp.com`, `*.facebook.com` (liste non extensible par l'exploitant). Redirections suivies à la main (2 au plus), chaque `Location` revalidée ; le jeton d'accès n'est envoyé qu'à `graph.facebook.com` et `lookaside.fbsbx.com` (retiré sur les autres hôtes officiels, par exemple les CDN) et n'est jamais dans une URL. L'hôte est résolu et contrôlé par la garde SSRF (7.3), puis la connexion se fait sur l'adresse vérifiée ; la liste blanche `GED_CONNECTOR_ALLOWED_INTERNAL_HOSTS` ne s'applique pas ici.
- Contenu : extension dans la liste globale privée de `.html` et `.htm` pour les dépôts WhatsApp (contenu actif potentiel ; `WHATSAPP_EXCLUDED_EXTENSIONS`), cohérence mime/extension, signature binaire (PDF, PNG, JPEG, TIFF, OOXML/ODF, OLE, RTF), pas d'octet NUL pour les formats texte, empreinte annoncée par Meta comparée à l'empreinte calculée, taille bornée en flux. Les droits sont évalués avant tout téléchargement. Aucun contenu n'est exécuté ni rendu ; les légendes et textes ne sont jamais lus. Noms de fichiers assainis (chemins, caractères de contrôle et bidi, noms réservés Windows, extensions intermédiaires neutralisées).
- Journaux : seuls l'identifiant de connecteur, le pseudonyme de l'expéditeur (HMAC-SHA256 tronqué, clé = secret de l'application), l'identifiant de message et des décisions. Jamais de numéro en clair, de corps, de signature, de secret, d'URL signée ni de nom de fichier brut. Côté journal HTTP (`apps/api/src/common/log-sanitize.ts`, branché dans `app.module.ts`) : pino-http crée `req.log` avant le contrôle `autoLogging.ignore`, donc tout log émis pendant une requête embarque `req`. Le sérialiseur `req` retire donc `req.query`, supprime toute la query des URL de `/api/ged/webhooks/` (le verify token du GET y figure) et masque ailleurs la valeur des paramètres dont le nom contient token, secret, signature, key ou password ; `authorization`, `cookie`, `x-hub-signature-256` et `x-api-key` sont masqués partout, et le journal de fin de requête est désactivé pour `/api/ged/webhooks/`. Un test monte un vrai `LoggerModule` et vérifie l'absence du verify token et de la signature dans la sortie.
- Droits : Consultation sur le groupe de l'expéditeur seulement (`resolveWhatsappGrants` : `mapOriginRights`, `assertNeverWider`, `assertRestricted`), jamais plus ouverts ; sans groupe applicable, l'élément passe « En erreur » et le document n'est pas créé. Un doublon n'ajoute aucun droit à l'original (4.3).

### 16.4 Variables d'environnement

`GED_WHATSAPP_TRUST_PROXY`, `GED_WHATSAPP_REPLAY_WINDOW_SECONDS` (60 à 604 800 s), `GED_WHATSAPP_IP_RATE_LIMIT`, `GED_WHATSAPP_SENDER_RATE_LIMIT` (API) ; `GED_CONNECTOR_KEY*` et `GED_CONNECTOR_SECRET_*` comme en section 9. Documentées en commentaire, sans valeur, dans `.env.example`.

### 16.5 Limites connues et points non vérifiables sans compte Meta réel

- Non vérifié contre l'API réelle de Meta (tests à fournisseurs simulés uniquement) : forme exacte de l'URL du média (hôte `lookaside.fbsbx.com` supposé) et présence de redirections ; présence de `Content-Length` (sinon seule la borne en flux s'applique) ; format réel de `sha256` (hex ou base64 acceptés, tout autre format fait refuser le média) ; codes d'erreur Graph (190, 100, 131047…) ; acceptation du paramètre `phone_number_id` sur le GET du média ; délai de réponse attendu par Meta pour les webhooks ; signature calculée par Meta sur les octets exacts (supposée conforme à la documentation).
- Modèles de messages WhatsApp et fenêtre de service de 24 h : hors périmètre. Un accusé envoyé hors fenêtre peut être refusé par Meta ; l'échec est journalisé sans faire échouer l'ingestion.
- Limiteurs de l'API en mémoire, par instance (non partagés, remis à zéro au redémarrage). Sans `GED_WHATSAPP_TRUST_PROXY=1` derrière un proxy, toutes les requêtes partagent l'IP du proxy : le quota par IP (300/min) est alors partagé par tous les appelants, et un flot de requêtes (même non signées) peut le saturer et faire refuser (429) les livraisons légitimes de Meta. Avec la variable, seule la dernière entrée de `X-Forwarded-For` est retenue (un seul proxy de confiance). Le limiteur compte par adresse exacte : un client IPv6 qui dispose d'un préfixe /64 peut changer d'adresse à volonté et contourner le quota par IP (il n'évite ni la signature, ni le quota par expéditeur).
- Après une panne de l'API de plus d'une heure, les messages ré-émis par Meta sont comptés comme périmés et perdus (réponse 200). Un expéditeur qui dépasse sa limite voit ses messages excédentaires ignorés avec un 200.
- Les messages d'expéditeurs inconnus, non pris en charge ou limités ne créent pas d'élément : ils n'apparaissent pas dans « Messages reçus » (seulement dans les journaux, pseudonymisés).
- Une erreur d'authentification Graph (jeton expiré) marque l'élément « En erreur » définitivement et le connecteur « En erreur » ou « Autorisation expirée » : le message devra être renvoyé après correction du jeton.
- Le numéro de l'expéditeur est stocké en clair dans `origin_metadata` (nécessaire pour répondre) et dans la clé `wa:` de `rights.principalMap` (nécessaire au mapping des droits, visible des administrateurs dans la configuration). Il n'est écrit ni dans `origin_acl` (laissé vide pour WhatsApp), ni dans `origin_author` (pseudonyme), ni dans les journaux ; l'API des éléments renvoie `originAcl` et `originPath` à `null` pour ce type. Le job de refus porte le numéro dans Redis jusqu'à son exécution.
- Plusieurs numéros sous la même application Meta partagent le même secret d'application ; l'isolation entre connecteurs repose sur `phone_number_id`.
- Les images reçues n'ont pas d'OCR (même limite qu'en 11.2, point 25).
