# Socle IA de la GED (lot 1)

Ce document décrit ce que fait le **code** de la copie de travail `ged-ia-lot-1` à la date de rédaction (modifications de lot non encore commitées). Il ne décrit pas de fonctionnalité prévue. Les écarts constatés entre le code et sa documentation de schéma, ou entre le chemin API et le chemin worker, sont listés en section 12.

## 1. Vue d'ensemble

Le socle IA donne à la GED un point d'appel unique vers un modèle d'IA, dans l'un des trois modes : désactivée, locale ou cloud. Il comprend la configuration (une ligne), le masquage des données avant tout envoi cloud, un journal de chaque décision, une file `ged-ai` et un pipeline asynchrone lecture → classement → extraction.

Le code est réparti ainsi :

- `packages/db/prisma/models/ged.prisma` : tables `ged_ai_setting`, `ged_ai_masking_rule`, `ged_ai_decision` ; les contraintes CHECK sont dans `packages/db/prisma/sql/ged.sql`.
- `packages/types/src/ged.ts` (section « Socle IA ») : constantes, règles de masquage, seuil d'application automatique, extrait et empreinte du journal, schémas de sortie. Ce fichier est partagé par l'API et le worker et n'a pas de dépendance d'exécution (hors zod).
- `apps/api/src/modules/ai/` : configuration, fournisseurs, `AiService` (point d'entrée des appelants), journal, administration.
- `apps/worker/src/processors/ai-*.ts` : pipeline de la file `ged-ai`.
- `apps/api/src/modules/courriers/mail-ai-extraction.service.ts` et `mail-text-extractor.ts` : extraction des courriers (§ 9), premier appelant de `AiService`.

```
  Administrateur                          Extraction des courriers
  (web, administrateurs seuls)            (MailAiExtractionService + MailTextExtractor)
          │                                        │
          ▼                                        ▼
   AiController  /api/ged/ai/*           AiService.run / embed   ◄── point d'entrée unique (API)
    │        │                             │             │
    │        ▼                             │             └─► AiDecisionService ─► ged_ai_decision
    │   AiSettingsService                  ▼
    │   ─► ged_ai_setting          AiMaskingService ─► ged_ai_masking_rule
    │                              createProvider (selon le mode)
    │                                 ├─ mode 1 : OpenAiCompatibleProvider
    │                                 └─ mode 2 : OpenAiCloudProvider
    ▼ analyze
  file BullMQ « ged-ai » (Redis)
          │
          ▼
  Worker « ged-ai » (concurrence 1) : runAiPipeline
  lecture ─► classement ─► extraction      (ai-config, ai-masking, ai-providers, ai-decision-log)
  écrit ged_ai_decision et renseigne le document (champs vides seulement)
```

Deux chemins coexistent. Ils partagent les types de `packages/types` mais chacun a sa propre lecture de configuration, son propre fournisseur et son propre journal :

- le chemin API (`AiService`) sert à l'extraction des courriers et à `embed()` ;
- le chemin worker (`runAiPipeline`) sert à la file `ged-ai`, pour un document de la GED.

Aucun SDK OpenAI n'est utilisé : API et worker appellent les fournisseurs en HTTP natif (`fetch`). Le paquet `openai` n'est plus une dépendance de `apps/api`.

## 2. Modes et sélection du fournisseur

| Mode | Valeur | Effet |
|---|---|---|
| Désactivée | 0 | Aucune donnée ne sort, aucun appel, aucun journal. Réponse « IA désactivée ». C'est aussi l'état d'une ligne absente. |
| Locale | 1 | Modèle hébergé chez le client, serveur compatible OpenAI (Ollama, vLLM…). Masquage selon `masking_enabled`. |
| Cloud | 2 | Fournisseur externe, OpenAI par défaut. Masquage obligatoire. |

**Sélection.** Le mode choisit l'implémentation, le libellé `provider` ne la choisit pas :

- Mode 1 (`OpenAiCompatibleProvider`) : Chat Completions avec `response_format: json_schema`, embeddings sur `/embeddings`, images en data URI, PDF refusé avant tout appel réseau. Le modèle est obligatoire (erreur sinon).
- Mode 2 (`OpenAiCloudProvider`) : Responses API (`/responses`), PDF et images en pièces jointes, embeddings avec `dimensions` = 1024. Le fournisseur sait envoyer des binaires, mais `AiService` ne le fait jamais en cloud (§ 4).
- `provider` est un libellé libre (50 caractères au plus). Il apparaît dans le journal. Il ne sert à la résolution de clé que pour la règle « cloud OpenAI » (§ 3.3).
- Endpoint : celui de la configuration. En mode 1, à défaut `GED_AI_LOCAL_ENDPOINT` ; le worker ajoute le repli `http://localhost:11434/v1`. En mode 2, à défaut `https://api.openai.com/v1`.
- Valeurs cloud par défaut : provider `openai`, modèle `gpt-5.6-terra`, embeddings `text-embedding-3-large`. Ces valeurs sont complétées à l'enregistrement si elles sont vides.
- Côté worker, `loadAiConfig` suit la même logique de mode et d'endpoint. `createAiProvider` ne fait que du Chat Completions en texte seul, sans pièce jointe.

**Pas de repli.** Une ligne absente, un mode 0 ou un mode inconnu désactivent l'IA, même si `OPENAI_API_KEY` est définie. Aucune variable d'environnement ne choisit un mode, et aucune clé n'est résolue en mode 0.

**IA désactivée, sans erreur.**

- `AiService.run` et `AiService.embed` renvoient `{ disabled: true, message: 'IA désactivée' }`.
- `GET /status` renvoie `enabled: false` avec ce message.
- `POST …/analyze` répond `{ disabled: true, message }` et ne met rien en file.
- Le worker termine le job avec `{ disabled: true, message }` : ni lecture, ni appel, ni journal.
- L'extraction des courriers masque la fonctionnalité (`isEnabled()` vaut `false`). Si l'appel arrive quand même, la lecture locale s'exécute, puis la réponse est 503 « L'IA est désactivée… ». Cette conversion est propre au courrier, pas au socle.
- `DisabledProvider` lève `AiDisabledError`. C'est un filet de sécurité que `AiService` ne laisse jamais atteindre.

## 3. Configuration

### 3.1 Table `ged_ai_setting` (ligne unique, id = 1)

| Colonne | Type | Défaut | Règle |
|---|---|---|---|
| `ged_ai_setting_id` | int | 1 | CHECK = 1 (ligne unique) |
| `mode` | smallint | 0 | CHECK dans (0, 1, 2) |
| `provider` | varchar(50) | NULL | libellé libre |
| `model` | varchar(200) | NULL | modèle génératif |
| `embedding_model` | varchar(200) | NULL | modèle d'embedding |
| `embedding_dimension` | int | 1024 | CHECK > 0 ; l'API impose 1024 |
| `endpoint` | varchar(500) | NULL | URL http(s) |
| `api_key_ref` | varchar(200) | NULL | nom d'une variable d'environnement, jamais la clé |
| `masking_enabled` | boolean | true | CHECK : mode ≠ 2 OU masquage actif |
| `auto_apply_threshold` | decimal(4,3) | NULL | CHECK NULL ou entre 0 et 1 ; NULL = jamais d'application auto |
| `timeout_seconds` | int | 60 | CHECK > 0 ; l'API impose 1 à 600 |
| `updated_at`, `updated_by` | timestamptz(0), int | now(), NULL | trace d'édition, sans FK |

La migration insère la ligne 1 en mode 0. Une base sans cette ligne reste désactivée (§ 2).

Les autres CHECK du socle : `ck_ged_ai_masking_rule_kind` (0 à 2), `ck_ged_ai_decision_task` (0 à 7), `ck_ged_ai_decision_mode` (1 ou 2), `ck_ged_ai_decision_status` (0 à 4), `ck_ged_ai_decision_confidence` (NULL ou 0 à 1), `ck_ged_ai_decision_validation` (validé par ⇒ validé le), `ck_ged_ai_decision_input_hash` (64 hexadécimaux ou NULL).

### 3.2 Validation de `PUT /api/ged/ai/settings`

Le DTO `updateAiSettingsSchema` est strict : un champ inconnu renvoie 400. Il borne la forme : `mode` ∈ {0, 1, 2} ; `timeoutSeconds` entier de 1 à 600 ; `autoApplyThreshold` entre 0 et 1, ou `null` ; `embeddingDimension` entier positif ; `apiKeyRef` soumis à la liste blanche (§ 3.3) ; une chaîne vide devient `null` pour les textes. Un champ absent n'est pas modifié.

`AiSettingsService.update` vérifie ensuite l'état résultant (ligne existante + requête) et renvoie 400 à la première règle violée :

- cloud avec masquage désactivé : refusé ;
- `api_key_ref` : `null`, `OPENAI_API_KEY`, ou `GED_AI_` suivi de majuscules, chiffres ou `_` (60 caractères au plus après le préfixe, premier caractère alphanumérique) ;
- `embedding_dimension` : doit valoir 1024 ;
- `auto_apply_threshold` : `null` ou entre 0 et 1 ;
- `timeout_seconds` : entre 1 et 600 ;
- endpoint : URL http ou https valide ; en cloud, https obligatoire sauf sur localhost, 127.0.0.1 ou [::1] ; mode 1 sans endpoint : refusé.

L'écriture est un upsert sur la ligne 1, avec `updated_by` = `userGroupId` de l'administrateur. La réponse est la vue des réglages, sans valeur de clé.

### 3.3 Clés d'API

- Aucune clé n'est stockée en base, ni journalisée, ni renvoyée. `api_key_ref` ne contient que le NOM d'une variable d'environnement. Les noms acceptés sont `OPENAI_API_KEY` et `GED_AI_[A-Z0-9][A-Z0-9_]{0,59}` (liste blanche `GED_AI_API_KEY_REF_REGEX`) ; tout autre nom est refusé, pour qu'une référence libre ne puisse pas exfiltrer `JWT_SECRET` ou `DATABASE_URL`.
- Une référence `GED_AI_*` est valable dans tous les modes et chez tous les fournisseurs.
- `OPENAI_API_KEY` n'est lue que pour le **cloud OpenAI** : mode 2, fournisseur `openai`, endpoint sur l'hôte `api.openai.com` (en https côté API). Partout ailleurs (local, autre fournisseur, autre hôte), elle n'est ni lue ni transmise.

**API** (`resolveApiKey`, `ai-provider.factory.ts`, à chaque création de fournisseur) :

- référence hors liste blanche, ou `OPENAI_API_KEY` hors cloud OpenAI : `AiConfigurationError`, aucun appel, aucune décision journalisée ;
- référence renseignée : la variable qu'elle nomme si elle est non vide ; sinon `GED_AI_API_KEY` ; sinon `OPENAI_API_KEY` en cloud OpenAI ;
- référence vide : `GED_AI_API_KEY`, puis `OPENAI_API_KEY` en cloud OpenAI ; sinon aucune clé, sans erreur ;
- cloud sans clé : `AiConfigurationError` ; local sans clé : appel sans en-tête d'autorisation.

**Worker** (`resolveAiApiKey`, `ai-config.ts`, à chaque job en mode 1 ou 2) :

- Erreur (`AiConfigurationError`) : le job échoue sans lecture, appel ni décision. C'est le cas d'une référence hors liste blanche, et d'une référence `OPENAI_API_KEY` hors cloud OpenAI (y compris en local).
- Ignoré sans erreur : `OPENAI_API_KEY` implicite (référence vide) hors cloud OpenAI. Une référence `GED_AI_*` vide donne `GED_AI_API_KEY` si elle est définie, sinon aucune clé ; le worker ne retombe pas alors sur `OPENAI_API_KEY` (§ 12).
- Cloud sans clé : le job n'échoue pas pour autant ; chaque étape écrit une décision `Erreur` (erreur levée par `createAiProvider`).
- L'https n'est pas contrôlé par `ai-config.ts` mais par `createAiProvider` : un endpoint http hors boucle locale est refusé avant tout appel, donc sans clé envoyée.
- Mode 0 : aucune clé n'est résolue, donc aucune erreur de référence.

**Messages d'erreur fournisseur.** L'API ne reprend que le code HTTP (« Fournisseur IA <nom> : HTTP <code> »), jamais le corps de la réponse. Une défaillance réseau passe par `redactSecrets` (clé, `Bearer …` et `sk-…` remplacés). Le worker utilise des textes fixes ; il ne reprend pas le détail d'une exception réseau.

**`apiKeyConfigured`** (`GET /api/ged/ai/settings`) : vrai si la référence désigne une variable non vide, ou si `GED_AI_API_KEY` est définie, ou si `OPENAI_API_KEY` est définie en cloud OpenAI. Hors `OPENAI_API_KEY`, ce champ ne dépend pas du mode.

### 3.4 Variables d'environnement

| Variable | Lue par | Rôle |
|---|---|---|
| `OPENAI_API_KEY` | API, worker | Lue seulement pour le cloud OpenAI (§ 3.3), soit par repli implicite, soit parce que `api_key_ref` la désigne. Ailleurs : ignorée, ou erreur si elle est référencée. |
| `OPENAI_MODEL` | API (schéma seulement) | Déclarée dans `apps/api/src/config/env.ts` avec le défaut `gpt-5.6-terra`, mais aucun code du socle ne la lit. Le modèle vient de `ged_ai_setting.model`. |
| `GED_AI_API_KEY` | API, worker | Clé de repli quand la référence est vide ou désigne une variable vide. |
| `GED_AI_LOCAL_ENDPOINT` | API, worker | Endpoint du mode 1 quand la base n'en porte pas. Le worker a en plus le repli `http://localhost:11434/v1`, que l'API n'a pas. |
| `REDIS_URL` | API, worker | Connexion de la file `ged-ai` (déjà requise par le socle). |

Une variable vide vaut « absente ». Hors ces variables, un nom `GED_AI_*` n'est lu que lorsqu'une `api_key_ref` le désigne.

## 4. Masquage

Le masquage ne porte que sur le texte. La consigne système n'est jamais masquée.

**Quand il s'applique.**

- Cloud : toujours. Règles actives plus toutes les entités par défaut. Si `masking_enabled` vaut false, l'envoi est refusé avant tout appel.
- Local : seulement si `masking_enabled` (défaut true). Ce sont alors les règles actives qui s'appliquent, sans les entités par défaut.

**Ordre.** Les règles de `ged_ai_masking_rule` (par `sort_order`, puis id), puis, en cloud, les entités par défaut dans cet ordre : e-mail, IBAN, montants, téléphone international, NIR, carte bancaire, téléphones nationaux, téléphones libellés, filet de nombres longs, identités. Marqueurs : `[EMAIL]`, `[IBAN]`, `[MONTANT]`, `[TÉLÉPHONE]`, `[NIR]`, `[CARTE]`, `[IDENTITÉ]`, `[NUMÉRO]` (filet : 9 chiffres ou plus, ou 8 chiffres collés).

**Règles (`ged_ai_masking_rule`).** `kind` 0 : expression régulière ; 1 : texte exact, insensible à la casse, aux accents, aux espaces, aux apostrophes et aux tirets ; 2 : entité prédéfinie, dont le `pattern` est un code parmi `email`, `phone`, `amount`, `iban`, `card`, `nir`, `identity`. Le remplacement par défaut est `[MASQUÉ]` (ou le marqueur de l'entité). Une règle regex est refusée si elle contient une rétro-référence, une répétition illimitée (`*`, `+`, `{n,}`), une borne supérieure à 100, des quantificateurs imbriqués ou des alternatives répétées, un coût de retour arrière supérieur à 1000, un motif de plus de 500 caractères ou un motif pouvant correspondre à un texte vide. L'API n'expose aujourd'hui qu'une lecture (`GET /masking-rules`) : il n'existe pas encore de route de création ou de modification.

**Normalisation.** Le texte est normalisé en NFKC avant masquage. Le texte envoyé est donc cette forme normalisée.

**Échec fermé.** Règle invalide, texte de plus de 200 000 caractères après normalisation, ou correspondance vide : une erreur est levée et rien n'est envoyé. Le worker journalise alors une décision `Erreur` sans texte envoyé (`input_excerpt` et `input_hash` NULL). L'API lève l'erreur avant tout journal (§ 6).

**Binaires.** Un binaire n'est jamais envoyé au cloud, et un binaire ne peut pas être masqué.

- Cloud : `AiService.run` refuse toute pièce jointe (`AiMaskingRequiredError`), sans option ni exception.
- Local : `AiService.run` refuse la pièce jointe si `masking_enabled` est vrai, sauf si l'appelant passe `allowLocalAttachments: true`. Si le masquage est coupé, la pièce jointe part sans option. Dans les deux cas le binaire n'est pas masqué, et `inputMasked` vaut faux. Le fournisseur local refuse les PDF avant tout appel réseau. Aucun appelant ne passe `allowLocalAttachments` aujourd'hui.
- Le worker n'envoie que du texte.

**Limites connues** (documentées dans `packages/types/src/ged.ts`) :

- un nom propre sans civilité ni libellé n'est pas détecté, pas plus qu'un nom en minuscules après une civilité ;
- les montants écrits en lettres, ou sans devise ni libellé, ne sont pas détectés (sauf le filet à partir de 9 chiffres) ;
- e-mails obfusqués, adresses postales, dates de naissance et identifiants de moins de 8 chiffres ne sont pas détectés ;
- sur-masquage assumé : références de 9 chiffres ou plus, « Client : … » jusqu'en fin de ligne, mots en capitales après une civilité.

## 5. Pipeline worker (file `ged-ai`)

La file `GED_AI_QUEUE` reçoit `{ documentId, sourceItemId?, requestedBy? }`. Le seul producteur est `POST /api/ged/ai/documents/:documentId/analyze`, qui ne vérifie que le mode (§ 7) avant de mettre en file. Le worker traite un job à la fois. L'API retient les jobs terminés ou en échec (1 000 chaque) ; aucune option de relance n'est passée, donc BullMQ applique son défaut, une seule tentative.

1. **Configuration.** Mode 0 : `{ disabled: true }`, fin, sans lecture ni journal. Une `AiConfigurationError` (§ 3.3) fait échouer le job immédiatement, sans lecture, appel ni décision.
2. **Lecture.** Textes OCR (`DocumentFile.ocrText`) des fichiers de la version courante, dans l'ordre `sort_order`, séparés par une ligne vide, rognés et plafonnés à 20 000 caractères. Document absent : `skipped: 'document_not_found'`. Aucun texte : `skipped: 'no_text'`, sans appel. Le pipeline ne fait pas d'OCR.
3. **Classement** (seulement s'il existe au moins un type de document actif). La liste `id: libellé` est dans la requête. `documentTypeId` hors liste devient `null`.
4. **Extraction.** Le type retenu en 3 est donné en contexte. Sortie : titre, date, référence, résumé, confiance.
   - Un échec de classement (fournisseur, réponse non conforme) n'arrête pas le pipeline : l'extraction tourne sans type.
   - Un échec de masquage à l'étape 3 arrête le pipeline.

**Score et statut.**

- La confiance renvoyée par le modèle passe par `clampConfidence` : hors de [0, 1] (par exemple 85 pour « 85 % ») elle devient `null`, sinon elle est tronquée au millième.
- Une décision est `Appliquée auto` (3) seulement si `auto_apply_threshold` n'est pas NULL, que la confiance existe, qu'elle atteint le seuil et que le patch n'est pas vide. Sinon elle est `Proposée` (0).
- Seuil NULL (valeur par défaut) : aucune application automatique. Toute décision attend une validation humaine.

**Application.** Seuls les champs vides sont remplis, par un `UPDATE … WHERE champ IS NULL` :

- classement : type de document (`documentTypeId`) ;
- extraction : date (`documentDate`, date réelle au format AAAA-MM-JJ, année entre 1000 et 2100) et résumé (`overview`, 4 000 caractères au plus, caractères de contrôle retirés).

Le titre et la référence sont journalisés mais jamais écrits sur le document. Si l'application échoue, la décision repasse en `Proposée` avec un message.

**Erreurs.** Erreur fournisseur, sortie non conforme au schéma, masquage refusé, ou clé absente en cloud : une décision `Erreur` (4) est écrite pour l'étape concernée, avec un message fixe sans clé ni contenu de document.

**Résultat du job** : `{ disabled, documentId, skipped?, decisions: [{ task, decisionId, status, confidence }] }`.

## 6. Journal `ged_ai_decision`

Une ligne par appel réussi (`Proposée` ou `Appliquée auto`) et par échec d'appel ou de réponse (`Erreur`, sortie nulle). Côté API, les échecs de masquage et de configuration ne sont pas journalisés ; côté worker, les échecs de masquage le sont (§ 12).

| Colonne | Contenu |
|---|---|
| `document_id` | Document concerné ; mis à NULL si le document disparaît. NULL pour une extraction de courrier. |
| `source_item_id` | Élément source, s'il y en a un. |
| `task` | 0 classement, 1 extraction, 2 résumé, 3 type, 4 question, 5 similarité, 6 correction OCR, 7 autre. Seuls 0 et 1 sont produits aujourd'hui. |
| `mode` | 1 ou 2, figé à l'appel. |
| `provider`, `model`, `prompt_version` | Fournisseur, modèle, gabarit : `ged-pipeline-v1` (pipeline) ou `mail-extraction-v2` (courrier). |
| `input_excerpt` | Texte masqué réellement envoyé, tronqué à 2 000 caractères suivis de « … ». Le caractère NUL devient U+FFFD. NULL si aucun texte n'est parti (worker, masquage refusé). |
| `input_hash` | SHA-256 hexadécimal (64 caractères). Côté API, il couvre le texte et les empreintes des binaires joints ; côté worker, le texte seul. NULL si aucun texte n'est parti. |
| `input_masked` | Vrai si le texte envoyé a été masqué. Côté API, il est faux dès qu'une pièce jointe part, car le binaire n'est jamais masqué. |
| `output` | Sortie JSON validée ; NULL en cas d'erreur. |
| `confidence` | Entre 0 et 1, ou NULL. |
| `status` | 0 proposée, 1 validée, 2 rejetée, 3 appliquée auto, 4 erreur. |
| `validated_by`, `validated_at` | Renseignés par la revue. |
| `requested_by`, `prompt_tokens`, `completion_tokens`, `duration_ms`, `error_message` | Auteur de la demande (NULL pour une extraction de courrier, qui ne le transmet pas), consommation, durée, message d'erreur (500 caractères au plus côté API). |

**Revue.** Seules les décisions `Proposée` peuvent être validées ou rejetées. La transition est conditionnée par `status = Proposée` dans l'écriture elle-même : une revue concurrente obtient 409. La validation applique le patch du document, au même titre que l'application automatique (champs vides seulement). Le rejet ne touche pas au document.

**Écarts d'implémentation** : voir § 12, points 2 et 3.

## 7. Endpoints d'administration

Préfixe global `/api`. Le contrôleur `ged/ai` est réservé aux administrateurs : `MenuPermissionGuard` et `@RequireAdmin()` s'appliquent à tout le contrôleur.

| Méthode et chemin | Rôle | Réponse |
|---|---|---|
| `GET /api/ged/ai/settings` | Réglages, sans valeur de clé | Vue des réglages (`apiKeyConfigured`, `apiKeyRef`, `updatedAt`…) |
| `PUT /api/ged/ai/settings` | Mise à jour partielle, validée (§ 3.2) | Vue mise à jour |
| `GET /api/ged/ai/status` | Activation et mode effectifs | `{ enabled, mode, message? }` |
| `GET /api/ged/ai/masking-rules` | Toutes les règles, actives et inactives (lecture seule) | Liste triée |
| `GET /api/ged/ai/decisions` | Journal paginé. Filtres : `status` (0 à 4), `task` (0 à 7), `documentId`, `page`, `pageSize` (défaut 25, maximum 100) | `{ items, total, page, pageSize }` |
| `GET /api/ged/ai/decisions/:id` | Une décision | Vue de la décision |
| `POST /api/ged/ai/decisions/:id/validate` | Valide une décision proposée et remplit les champs vides du document | Vue de la décision (200) |
| `POST /api/ged/ai/decisions/:id/reject` | Rejette une décision proposée, sans toucher au document | Vue de la décision (200) |
| `POST /api/ged/ai/documents/:documentId/analyze` | Met le document en file `ged-ai`. IA désactivée : rien n'est mis en file | `{ queued: true }` ou `{ disabled: true, message }` (200) |

Erreurs : 404 si la décision n'existe pas ; 409 si elle n'est pas `Proposée` ou si une revue concurrente l'a déjà traitée ; 400 si les réglages, un identifiant de route ou un filtre sont invalides. Pour `analyze`, le `documentId` est un entier de 1 à 2 147 483 647 (int4). La route ne vérifie pas l'existence du document : le worker le constate et répond `document_not_found`. Elle ne vérifie que le mode : une configuration cloud sans clé est mise en file et échoue côté worker (§ 3.3).

## 8. Embeddings : `AiService.embed(texts)`

- Mode 0 : `{ disabled: true, message }`.
- Chaque texte est masqué (en cloud, masquage complet ; en local, selon `masking_enabled`).
- Le fournisseur renvoie un vecteur par texte. Chaque vecteur doit compter exactement `GED_EMBEDDING_DIMENSION` = **1024** composantes, sinon `AiProviderError`.
- Retour : `{ disabled: false, vectors, model, dimension: 1024 }`.
- Modèle : `embedding_model` si renseigné ; sinon `bge-m3` en mode 1, `text-embedding-3-large` en mode 2 (requête avec `dimensions: 1024`).
- **Non indexé.** Rien n'écrit dans `ged_document_chunk` (table et index HNSW `vector(1024)` posés au lot 0). Aucune ligne de journal, aucune route. Aucun code n'appelle `embed()` à ce stade. L'indexation relève du lot 3.

## 9. Extraction des courriers via l'abstraction

`MailAiExtractionService` (`apps/api/src/modules/courriers/mail-ai-extraction.service.ts`) passe par `AiService.run`, sans jamais toucher à un fournisseur directement. Le binaire n'est jamais envoyé à un fournisseur : il est lu localement par `MailTextExtractor` (`mail-text-extractor.ts`), puis seul le texte part, masqué selon § 4.

- **Disponibilité** : `GET /api/courriers/extraction-ia/disponibilite` renvoie `enabled = isEnabled()`, soit l'IA activée (mode ≠ 0) ET la lecture locale utilisable. La lecture est utilisable si `TESSERACT_DATA_PATH` est vide ou désigne un dossier existant.
- **Entrée** : `POST /api/courriers/extraction-ia` avec un fichier `.pdf`, `.jpg`, `.jpeg`, `.png`, `.gif` ou `.webp`, de 10 Mo au plus. Autre format ou taille : 400.
- **Lecture locale** (`MailTextExtractor`) : PDF : couche texte de chaque page, puis OCR Tesseract (`@archivage/ocr`) pour les pages sans texte. Image : OCR direct ; GIF et WebP sont convertis en PNG (canvas `@napi-rs/canvas`). 10 pages au plus, 20 000 caractères au plus, espaces de fin de ligne et lignes vides en excès retirés. Aucun texte lisible, PDF corrompu ou protégé, image illisible, données OCR introuvables : 400.
- **Texte envoyé** : la liste des correspondants (`id — libellé`) et celle des rôles destinataires, puis le texte du courrier encadré par `<<<DEBUT_COURRIER>>>` et `<<<FIN_COURRIER>>>`, puis la consigne. Aucune pièce jointe.
- **Options** : tâche `ExtractionMetadonnees`, gabarit `mail-extraction-v2`, `autoApply: false` (la décision reste toujours `Proposée`), `minTimeoutSeconds: 180` (délai effectif = max(délai configuré, 180 s)).
- **Sortie stricte** à sept champs : `title`, `date`, `reference`, `externalEntityId`, `externalEntityLabel`, `destinataireRoleId`, `description`. Un identifiant absent des listes envoyées est ramené à `null`, à la fois par le modèle (consigne) et par le service (contrôle de sortie).
- Aucune écriture en base : l'agent relit le formulaire pré-rempli avant d'enregistrer.
- **Erreurs** :
  - 400 avant toute lecture : format ou taille ;
  - 400 pendant la lecture locale : données OCR introuvables, aucun texte lisible, PDF corrompu ou protégé, image illisible ;
  - 503 après la lecture locale : IA désactivée ; cloud avec masquage désactivé ; échec fournisseur ou configuration invalide (dont `AiConfigurationError`, journalisée seulement dans les logs) ; réponse inexploitable ; toute autre erreur de masquage ou d'appel. Dans tous ces cas, la saisie manuelle reste possible.
- **Journal** : une ligne de `ged_ai_decision` avec `document_id` NULL. La valider n'applique rien, puisqu'il n'y a pas de document.
- **Libellés et texte** : les libellés des correspondants et des rôles, et le texte OCR du courrier, font partie du texte envoyé. En cloud, ils ne sont masqués que si une règle ou une entité par défaut les couvre ; la détection de noms libres ne s'applique pas (§ 4, § 12).

## 10. Ajouter un fournisseur

1. Choisir le mode. Un serveur compatible OpenAI en Chat Completions relève déjà du mode 1 ou 2. Un autre protocole demande un nouveau fichier.
2. API : créer `apps/api/src/modules/ai/providers/<nom>.provider.ts`, qui implémente `AiModelProvider` (`kind`, `name`, `model`, `complete()`, `embed()`). Le transport peut réutiliser `postJson` et `parseEmbeddings` de `openai-compatible.provider.ts` : délai, erreurs assainies.
3. API : brancher le provider dans `createProvider` (`ai-provider.factory.ts`). Garder les règles existantes : https hors boucle locale en cloud ; clé via `resolveApiKey`, jamais dans un message ; `OPENAI_API_KEY` non transmise hors du cloud OpenAI.
4. Worker : `apps/worker/src/processors/ai-providers.ts` a son propre `AiProvider` et son propre `createAiProvider` (texte seul). Il faut l'adapter en parallèle. `ai-config.ts` lit la configuration pour ce chemin.
5. Dimension : les embeddings doivent produire 1024 composantes. Une autre dimension exige une migration (ce n'est pas un réglage).
6. Tests : `providers.spec.ts` (API) et `ai-providers.spec.ts` (worker). Le transport se simule via `fetchImpl` et l'environnement via `providerDeps` ou son équivalent.
7. Pas de registre à mettre à jour : `provider` est une chaîne libre.

## 11. Tests et commandes

```
pnpm --filter @archivage/api test -- modules/ai          # socle IA (API)
pnpm --filter @archivage/api test -- mail-ai-extraction  # extraction des courriers
pnpm --filter @archivage/api test -- mail-text-extractor # lecture locale des courriers
pnpm --filter @archivage/worker test                     # pipeline ged-ai
pnpm --filter @archivage/api lint
pnpm --filter @archivage/worker lint
pnpm test                                                # tous les paquets (Turborepo)
```

- `apps/api/src/modules/ai/` : `ai-core.spec.ts` (masquage cloud, règles de table, échec fermé, `decideAiStatus`, `clampConfidence`, `buildInputExcerpt`, `buildDocumentPatch`, regex de clé, schémas), `ai.service.spec.ts`, `ai-settings.service.spec.ts`, `ai-settings.dto.spec.ts`, `ai-decision.service.spec.ts`, `ai-decision.dto.spec.ts`, `ai-masking.service.spec.ts`, `ai-provider.factory.spec.ts`, `ai.controller.spec.ts`, `providers/providers.spec.ts`.
- `apps/api/src/modules/courriers/` : `mail-ai-extraction.service.spec.ts`, `mail-text-extractor.spec.ts`.
- `apps/worker/src/processors/` : `ai-config.spec.ts`, `ai-pipeline.spec.ts`, `ai-pipeline.processor.spec.ts`, `ai-providers.spec.ts`, `ai-masking.spec.ts`, `ai-decision-log.spec.ts`.
- `packages/types` : pas de tests propres (`echo`). La logique de masquage est testée depuis l'API.
- Pas de test e2e du socle IA.

## 12. Écarts et points d'attention

1. **Configuration et clés lues deux fois.** `AiModelProvider`, `resolveApiKey` et la lecture de configuration existent côté API (`ai-provider.factory.ts`, `ai-settings.service.ts`) et côté worker (`ai-config.ts`, `ai-providers.ts`). Ils divergent sur quatre points :
   - référence `GED_AI_*` vide : l'API retombe sur `OPENAI_API_KEY` en cloud OpenAI, le worker non ;
   - https de l'endpoint OpenAI : contrôlé par l'API à la création du fournisseur, par le worker seulement dans `createAiProvider` ;
   - cloud sans clé : `AiConfigurationError` levée côté API (aucune décision), décision `Erreur` par étape côté worker ;
   - endpoint local vide : repli `http://localhost:11434/v1` côté worker seulement.
2. **Journal côté API incomplet.** Un échec de masquage ou de configuration n'y laisse aucune trace ; le worker journalise les échecs de masquage. L'empreinte d'entrée n'est pas comparable entre les deux chemins (§ 6).
3. **Journal dit « append-only ».** Le schéma et le commentaire de `ai-decision.service.ts` disent le journal append-only ; la revue modifie `status`, `validated_by` et `validated_at`.
4. **Commentaires du schéma.** `provider` est dit « validé par l'API » : l'API ne contrôle que la longueur. `api_key_ref` évoque un « identifiant de coffre » : non implémenté, seul un nom de variable est accepté. `ck_ged_ai_setting_dimension` ne vérifie que > 0 : c'est l'API qui impose 1024.
5. **`OPENAI_MODEL` déclarée sans lecteur.** `apps/api/src/config/env.ts` la déclare avec un défaut, mais aucun code ne la lit. Le modèle vient de `ged_ai_setting.model`.
6. **Pas de relance.** Un échec fournisseur reste une décision `Erreur`. Une nouvelle tentative suppose un nouvel appel à `analyze`.
7. **Extraction des courriers : OCR avant contrôle.** `POST /api/courriers/extraction-ia` ne vérifie pas `isEnabled()` avant la lecture locale : avec l'IA désactivée, l'OCR tourne, puis la réponse est 503.
8. **Noms libres non détectés.** Ni le pipeline ni l'extraction des courriers ne détectent les noms libres : les libellés de correspondants ou de types de document, et le texte OCR d'un courrier, envoyés au cloud, ne sont masqués que par les règles configurées et les entités par défaut (§ 4).
9. **Documentation d'exploitation hors de ce document.** `.env.example` indique encore « sans clé, la case n'apparaît pas » : la disponibilité de la saisie automatique est désormais IA activée ET lecture locale utilisable (§ 9).

## 13. Durcissements réseau et clés (dernier passage)

- `OPENAI_API_KEY` n'est honorée que pour cloud + provider `openai` + `https://api.openai.com` (https exigé, sans identifiants dans l'URL), sur l'API comme sur le worker.
- Les appels `fetch` des fournisseurs (API et worker) utilisent `redirect: 'error'` : l'en-tête `Authorization` ne suit jamais une redirection.
- Un endpoint contenant `user:pass@` est refusé (configuration API, fabriques API et worker, cloud et local).
- Une erreur réseau n'est pas recopiée dans le message journalisé (`injoignable (erreur réseau)`).
- `apiKeyConfigured` suit exactement la résolution réelle (une configuration qui lèverait `AiConfigurationError` donne `false`).
- L'extraction courrier teste `ai.status()` avant l'OCR local : IA coupée, aucun OCR n'est lancé.

## 14. Docu-Flow (agents de workflow)

Les agents de workflow passent par ce socle (`AiService.run`). Vue d'ensemble, agents et garde-fous : [`workflow.md`](workflow.md).
