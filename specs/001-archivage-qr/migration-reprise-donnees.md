# Plan de reprise des données — DocuPro V7 (SQL Server) → Archivage QR (PostgreSQL/Prisma)

**Feature** : `001-archivage-qr`
**Date** : 2026-06-16
**Source** : `db_DocuPro_Aconda` — Microsoft SQL Server (serveur `DEVMICK`), 190 tables, intégrité référentielle gérée *par le code applicatif* (peu de FK déclarées).
**Cible** : PostgreSQL + Prisma — modèle à **21 tables** décrit dans [data-model.md](data-model.md).
**Contrainte clé** : **conserver les mêmes identifiants** (IDs) pour toutes les entités reprises.

---

## 0. Principes directeurs

1. **Identifiants préservés** — Les `INT IDENTITY` legacy sont réinsérés *avec leur valeur d'origine* dans les colonnes `autoincrement` Prisma, puis les séquences PostgreSQL sont recalées (`setval`) au-dessus du max. Trois espaces d'ID indépendants à respecter : `userId` (→ `app_user`), `groupId` (→ `app_group`), `users_groupId` (→ `app_user_group`). Dans le legacy, la plupart des colonnes `Utilisateur_id` pointent vers `tbl_Users_Groups.users_groupId` — ce qui correspond **exactement** à l'acteur de toutes les FK de la cible (`app_user_group.user_group_id`). La reprise est donc directe.
2. **Reprise par chargement de masse + transformation SQL**, pas via le client Prisma (mauvais pour le bulk, les IDs explicites et le recalage de séquences). Prisma sert uniquement à *créer le schéma* (`prisma db push`), puis on exécute des scripts SQL.
3. **Idempotence** — chaque étape est rejouable (TRUNCATE/`ON CONFLICT DO NOTHING` ou `MERGE`) pour permettre des répétitions de rodage avant la bascule.
4. **Sortie des binaires en dehors de la base** — les `VARBINARY(MAX)` legacy (fichiers stockés *dans* SQL Server) sont **extraits sur disque** au format `{file_id}{extension}` sous `ARCHIVES` (décision D-16). C'est l'opération la plus lourde (~93 000 fichiers).
5. **Deny-by-default assumé** — le modèle cible masque tout document sans habilitation explicite. La reprise doit **reconstituer les habilitations** sinon ~42 000 documents deviennent invisibles (cf. §6.6, risque majeur).
6. **Périmètre = 21 tables** — tout le reste du legacy (RH/Évaluation, GED espaces collaboratifs, Mail, Workflow, Alertes, Indexation/métadonnées, Folksonomie/Taxonomie, Cycle de vie/DUA…) n'a **pas de cible v1** (cf. §9).

---

## 1. Cartographie source → cible (vue d'ensemble)

| Cible (21 tables) | Catégorie | Source(s) legacy principale(s) | Lignes approx. source |
|---|---|---|---|
| `app_user` | Sécurité | `tbl_Users` | 41 |
| `app_group` | Sécurité | `tbl_Groups` | 19 |
| `app_user_group` | Sécurité | `tbl_Users_Groups` | 33 |
| `permission_level` | Sécurité | `TBL_COMMON_DOCUMENT_TYPE_SECURITE_CATEGORIES` (5) + seed | 5 |
| `document_type_permission` | Sécurité | `…TYPE_DOCUMENT_SECURITY_PROFILS` + `…TYPE_DOCUMENT_SECURITY_UTILISATEUR` | 228 + 387 |
| `document_permission` | Sécurité | `TBL_COMMON_DOCUMENT_SECURITY` (+ back-fill créateurs) | 9 |
| `document_type` | Référentiel | `TBL_COMMON_DOCUMENT_TYPE_DOCUMENT` | 112 |
| `classification_plan` | Référentiel | `TBL_COMMON_DOCUMENT_PLAN` | 843 |
| `location` | Référentiel | `TBL_COMMON_DOCUMENT_LOCALISATION` | 698 |
| `dossier_category` | Référentiel | `TBL_COMMON_DOSSIER_CATEGORIE` | 46 |
| `dossier` | Référentiel | `TBL_COMMON_DOSSIER` | 347 |
| `dossier_exit_motive` | Référentiel | `TBL_COMMON_DOSSIER_SORTIES_MOTIFS` | 4 |
| `file_type` | Référentiel | `TBL_COMMON_DOCUMENT_FILE_TYPES` (dédup par extension) | 52 |
| `intercalaire_category` | Référentiel | **seed uniquement** (pas de source) | — |
| `acquisition_batch` | Cœur | **synthétisé** depuis `TBL_COMMON_DOCUMENT.strGUID` (+ AQ) | ~ distincts |
| `document` | Cœur | `TBL_COMMON_DOCUMENT` ⊕ `TBL_ARCHIVES_DOCUMENT_ASSURANCE_QUALITE` | 41 953 |
| `document_version` | Cœur | `TBL_COMMON_DOCUMENT_VERSION` | 41 953 |
| `document_file` | Cœur | `TBL_COMMON_DOCUMENT_VERSION_FILES` (+ **BLOB→disque**) | 93 429 |
| `audit_action` | Audit | `TBL_COMMON_SEC_AUDIT_DESCRIPTION` | 7 |
| `navigation_audit` | Audit | `TBL_COMMON_AUDIT_NAVIGATION` (+ option `…DOCUMENT_ACCESS`) | 285 637 |
| `data_change_audit` | Audit | `TBL_COMMON_SEC_AUDIT` | 78 201 |

> **« Aucune cible v1 »** pour, entre autres : `TBL_COMMON_INDEXATION_*` (métadonnées, folksonomie, taxonomie), `TBL_ARCHIVES_DOCUMENT_CYCLE_VIE*` (DUA / sort final), `TBL_COMMON_DOCUMENT_CONFIDENTIALITE`, `…_COMMENTAIRES`, `…_PARAPH`, `TBL_COMMON_DOSSIER_PERSO*`, `…_RESERVATIONS`, `…_SORTIES`, `TBL_COMMON_ALERTE*`, menus, dashboards, tout `TBL_GED_*`, `TBL_MAIL*`, `TBL_WF*`/`tbl_Workflow*`, `TBL_EVALUATION_*`. → §9.

---

## 2. Architecture technique de l'ETL

Pipeline en 4 temps, avec une **base de transit (`schema legacy`)** dans le PostgreSQL cible :

```
SQL Server (db_DocuPro_Aconda)
        │
        ├─(A) Relationnel ─────────►  PostgreSQL : schéma «legacy.*» (miroir brut, texte, sans contraintes)
        │     pgloader  OU  Node (mssql → COPY)
        │
        └─(B) Binaires VARBINARY ──►  Disque : {ARCHIVES}/{file_id}{extension}
              Job Node «mssql» en streaming par lots (jamais tout en RAM)
                          │
                          ▼
       Transformation SQL set-based : legacy.* ──► public.* (les 21 tables Prisma)
                          │
                          ▼
       Post-traitement : path/depth des arbres, tsvector/GIN, setval séquences, ANALYZE
                          │
                          ▼
       Validation & réconciliation (comptes, checksums, contrôles d'intégrité, P3)
```

**Pourquoi un schéma de transit plutôt que des `INSERT` Prisma directs ?**
- Transformations **ensemblistes** (volumétrie : 93 k fichiers, 285 k logs) et **rejouables**.
- Logique d'**arbres** (CTE récursives) et de **synthèse de lots** infaisable proprement ligne à ligne côté ORM.
- **IDs explicites + recalage de séquences** maîtrisés en SQL pur.
- Découplé de l'application → la reprise tourne sans démarrer l'API.

**Outils recommandés**
- Canal (A) : **`pgloader`** (connecteur MSSQL→PG natif, gère casts de types et conversion d'encodage UTF-16→UTF-8) ; *ou* un exporteur **Node** (`mssql` en streaming → `pg` `COPY FROM STDIN`) si l'on veut tout en TypeScript dans le monorepo (`packages/db` ou un `apps/migration`).
- Canal (B) : **obligatoirement** un job Node dédié (`mssql` request *stream* sur `File_Id, File_Type_id, File_name_string, File_bytes`), écrit chaque BLOB sur disque, par paquets (p. ex. 200 lignes), avec reprise sur incident (curseur sur `File_Id`).
- Transformation : scripts **SQL** versionnés (`packages/db/migrations-reprise/`), lancés via `psql` dans l'ordre FK.

---

## 3. Préservation des identifiants

Prisma génère les PK `@default(autoincrement())` adossées à une séquence (`DEFAULT nextval(...)`). On peut donc insérer une valeur explicite, puis recaler la séquence :

```sql
-- 1) Insertion AVEC l'id legacy (la valeur explicite l'emporte sur le default)
INSERT INTO app_group (group_id, name, is_active)
SELECT "groupId", "groupName", true FROM legacy.tbl_groups;

-- 2) Recalage de la séquence au-dessus du max repris
SELECT setval(
  pg_get_serial_sequence('app_group','group_id'),
  (SELECT COALESCE(MAX(group_id),0) FROM app_group)
);
```

À faire pour **toutes** les tables dont la cible reprend des IDs legacy : `app_user`, `app_group`, `app_user_group`, `permission_level`, `document_type`, `classification_plan`, `location`, `dossier_category`, `dossier`, `dossier_exit_motive`, `document`, `document_version`, `document_file`, `audit_action`, `navigation_audit`, `data_change_audit`.

**IDs *non* préservés (nouvelles valeurs)** — entités sans équivalent 1:1 :
- `acquisition_batch` (synthétisée). On garde la traçabilité via `batch_guid` = `strGUID` legacy.
- `document_type_permission`, `document_permission` : la PK est une nouvelle valeur (ces lignes ne sont référencées par aucune FK ailleurs). On conserve en revanche les **clés métier** (`document_type_id`/`document_id`, bénéficiaire, niveau).
- `file_type` : ID conservé **sauf** sur les extensions dédupliquées (cf. §6.7).

---

## 4. Correspondance détaillée — Sécurité

### `app_user` ← `tbl_Users`
| Cible | Source | Transformation |
|---|---|---|
| `user_id` | `userId` | **identité** |
| `username` | `userName` | NN + **UNIQUE** : nettoyer (legacy nullable) ; à défaut, dériver de `Email`/`numero_matricul` ; dédoublonner |
| `first_name` / `last_name` | `FirstName` / `LastName` | direct |
| `full_name` | — | **colonne générée** (ignorer `FullName` legacy) |
| `email` | `Email` (fallback `Email1`) | — |
| `phone` | `Phone1` | — |
| `password_hash` | `Password` (NVARCHAR 50) | **non repris tel quel** → §6.8 (re-hash bcrypt si clair, sinon placeholder + `must_change_pwd`) |
| `must_change_pwd` | `ChangedPwd` | `true` si reset forcé (recommandé) |
| `service_id` | `ServiceId` | int simple (pas de FK dans la cible) |
| `matricule` | `numero_matricul` | — |
| `is_disabled` | `desactiver` | `BIT`→`boolean` |
| `is_admin` | — | **pas de source fiable** → dériver de l'appartenance à un groupe « Administrateurs » ou liste manuelle (§10) |
| `created_at` | `last_update_date` | sinon `now()` |

> `tbl_users_civility`, `est_evaluer`, `superviseur`, `reset_code`, `Photo` : **non repris** (hors modèle cible).

### `app_group` ← `tbl_Groups`
`group_id ← groupId`, `name ← groupName`, `is_active ← true`.

### `app_user_group` ← `tbl_Users_Groups`
`user_group_id ← users_groupId`, `user_id ← userId`, `group_id ← groupId`, `is_default ← groupIdDefault`. (Respecte `@@unique(user_id, group_id)` — déjà unique côté legacy.)

### `permission_level` ← `TBL_COMMON_DOCUMENT_TYPE_SECURITE_CATEGORIES` + seed
Le seed cible est fixe (`1 Consultation, 2 Création, 3 Modification, 4 Validation/Publication, 5 Prêts/Communication`). Les 5 catégories legacy doivent être **mises en correspondance** :
- Si `Security_Categorie_id` 1→5 correspond déjà sémantiquement → IDs conservés.
- Sinon construire une **table de correspondance** `legacy.sec_cat_id → permission_level_id` et l'appliquer partout où `Security_Categorie_id` est repris (cf. tables ACL ci-dessous). **À vérifier sur les libellés** (§10).

### `document_type_permission` ← UNION des deux tables legacy
- `…TYPE_DOCUMENT_SECURITY_PROFILS` → `document_type_id ← Type_Document_Id`, `permission_level_id ← map(Security_Categorie_id)`, **`group_id ← Profils_id`**, `user_group_id = NULL`.
- `…TYPE_DOCUMENT_SECURITY_UTILISATEUR` → `document_type_id`, `permission_level_id ← map(...)`, **`user_group_id ← Utilisateur_id`** (= `users_groupId`), `group_id = NULL`.
- Respecte le `CHECK` « bénéficiaire exclusif » par construction. PK = nouvelle valeur.
- ⚠️ Hypothèse à confirmer : **`Profils_id` == `groupId`** (profil ≡ groupe). Si « profil » est une notion distincte, prévoir une correspondance (§10).

### `document_permission` ← `TBL_COMMON_DOCUMENT_SECURITY` (9 lignes)
`document_id ← Document_Id`, `permission_level_id ← map(Security_Categorie_id)`, `user_group_id ← Utilisateur_id`, `granted_by ← last_modify_user_id`. Respecte `@@unique(document_id, user_group_id, permission_level_id)`.
> **Back-fill indispensable** : 9 lignes ne couvrent pas 42 000 documents → cf. §6.6.

---

## 5. Correspondance détaillée — Référentiels & Cœur

### `document_type` ← `TBL_COMMON_DOCUMENT_TYPE_DOCUMENT`
`document_type_id ← Type_Document_Id`, `label ← Type_Document_Libelle`, `code = NULL`, `is_active = true`.
**Unicité partielle** `label WHERE is_active` : en cas de doublon de libellé, garder un actif et passer les autres à `is_active=false` → **IDs et FK préservés** (cf. §6.7).

### `classification_plan` ← `TBL_COMMON_DOCUMENT_PLAN` (arbre)
`plan_id ← Plan_id`, `parent_id ← PARENT_ID`, `label ← LIBELLE`, `code ← CODE`, `is_public ← PUBLIQUE`, `is_active = true`. `depth`/`path` **recalculés** (§6.3). `BG`/`BD`/`NIVEAU` (nested-set legacy) abandonnés au profit de `path`.

### `location` ← `TBL_COMMON_DOCUMENT_LOCALISATION` (arbre)
`location_id ← Localisation_Id`, `parent_id ← PARENT_ID`, `label ← LIBELLE`, `code ← CODE`. `depth`/`path` recalculés.

### `dossier_category` ← `TBL_COMMON_DOSSIER_CATEGORIE`
`dossier_category_id ← Dossier_categorie_id`, `label ← Dossier_categorie_libelle`, `is_active = true`.

### `dossier` ← `TBL_COMMON_DOSSIER` (arbre)
`dossier_id ← Dossier_Id`, `parent_id ← PARENT_ID` (**sentinelle legacy `PARENT_ID=1` → `NULL`**, cf. data-model), `label ← Dossier_libelle`, `code ← Dossier_code`, `dossier_category_id ← Dossier_categorie_id`, `location_id ← Localisation_Id`, `service_code_suffix ← surfixe_code_service`, `is_active = true`, `created_at = now()`. `depth`/`path` recalculés. Unicité partielle `label WHERE is_active` (§6.7).

### `dossier_exit_motive` ← `TBL_COMMON_DOSSIER_SORTIES_MOTIFS`
`exit_motive_id ← SORTIE_MOTIF_ID`, `label ← SORTIE_MOTIF_LIBELLE`, `is_active = true`. (Sous-système « sorties » hors périmètre, mais le référentiel est repris.)

### `file_type` ← `TBL_COMMON_DOCUMENT_FILE_TYPES` (dédup par extension)
`file_type_id ← File_Type_id` (TINYINT→int), `extension ← File_Type_extension`, `friendly_name ← File_Type_friendly_name`, `max_size_bytes ← File_Type_max_size_allowed`, `icon ← File_Type_img`, `is_media ← File_Type_Is_media`, `is_active = true`.
⚠️ Contrainte `@@unique(extension)` **non partielle** → les extensions en doublon **doivent être fusionnées** : choisir un id canonique par extension, bâtir `legacy.file_type_id → canonical_id`, et **réécrire `document_file.file_type_id`** lors de la reprise (§6.7).

### `intercalaire_category` — **seed**
Aucune source legacy. Insérer les 5 lignes de référence (TYPE_DOCUMENT, PLAN, LOCALISATION, DOSSIER, BLANK) du data-model.

### `acquisition_batch` — **synthétisé** (§6.1)
Un lot par `strGUID` distinct ; `batch_guid ← strGUID` (cast/validation UUID), `scanned_by`/`scan_date` depuis `TBL_ARCHIVES_DOCUMENT_ASSURANCE_QUALITE` (`Scanned_by`/`Date_scan`) quand disponible, compteurs `file_count`/`document_count` recalculés, `status = 1` (terminé, données historiques).

### `document` ← `TBL_COMMON_DOCUMENT` ⊕ `TBL_ARCHIVES_DOCUMENT_ASSURANCE_QUALITE`
| Cible | Source | Transformation |
|---|---|---|
| `document_id` | `Document_Id` | **identité** |
| `label` | `Document_Libelle` | NN (défaut si vide) ; `NVARCHAR(MAX)`→`varchar(500)` **tronqué** |
| `document_type_id` | `Type_Document_Id` | — |
| `plan_id` | `Plan_id` | — |
| `location_id` | — | **NULL** (legacy n'a pas de localisation au niveau document ; option : dériver de `dossier.location_id`) |
| `dossier_id` | `Dossier_id` | — |
| `batch_id` | (jointure `strGUID`) | renseigné depuis `acquisition_batch` (§6.1) |
| `cote` | `Cote` | — |
| `document_date` | — | **NULL** (pas de date métier fiable ; option : `Date_Document` du cycle de vie, 8 lignes seulement) |
| `archive_year` | `annee_id` → `TBL_COMMON_ANNEE.annee_valeur` | résoudre la valeur d'année |
| `is_archived` | `Archive` | `Archive <> 0` |
| `is_frozen` | `geler` | `BIT`→`boolean` |
| `overview` | `arbitrary_overview` | — |
| `validated_by` / `validated_at` | AQ : `Utilisateur_id` / `Date_valide` | dernière ligne AQ valide par `Document_Id` |
| `workflow_instance_id` / `workflow_task_id` | `workflow_InstanceId` / `taskId` | réservés |
| `created_by` / `created_at` | `Utilisateur_id` / `date_ajout` (ou `Document_datetime`) | — |
| `modified_by` / `modified_at` | `Utilisateur_id_last_modify` / — | — |

### `document_version` ← `TBL_COMMON_DOCUMENT_VERSION`
`document_version_id ← Document_Version_id`, `document_id ← Document_Id`, `comment ← Document_Version_commentaire`, `is_validated ← (Document_Version_valide <> 0)`, `created_by ← Utilisateur_id`, `created_at ← Document_Version_date`.
- `version_number` : **calculé** par `ROW_NUMBER() OVER (PARTITION BY Document_Id ORDER BY Document_Version_date, Document_Version_id)`.
- `is_current` : **une seule** par document → la plus récente (dernière `version_number`). Respecte l'index unique partiel `WHERE is_current` (§6.4).

### `document_file` ← `TBL_COMMON_DOCUMENT_VERSION_FILES` (+ BLOB→disque)
| Cible | Source | Transformation |
|---|---|---|
| `file_id` | `File_Id` | **identité** ; nom disque = `{file_id}{extension}` |
| `document_version_id` | `Document_Version_id` | — |
| `file_type_id` | `File_Type_id` | via correspondance dédup (§6.7) |
| `original_name` | `File_name_string` | — |
| `file_extension` | dérivé de `File_name_string` (sinon `file_type.extension`) | normaliser (minuscule, point) |
| `byte_length` | `File_length` | `int`→`bigint` |
| `page_count` | — | NULL (absent legacy ; recalcul possible plus tard sur PDF) |
| `ocr_text` | `File_ocr_text` | `TEXT` → alimente le tsvector/GIN |
| `redaction` / `pdf_owner` / `pdf_password` | `Redaction` / `Owner` / `Pwd` | — |
| `sort_order` | — | 0 (ou ordre `File_Id` au sein de la version) |
| `created_at` | — | `now()` ou date de version |
| **`File_bytes`** | **`File_bytes`** | **extrait sur disque** `{ARCHIVES}/{file_id}{extension}` — pas stocké en base (§6.2) |

---

## 6. Points de transformation délicats

### 6.1 Synthèse des lots d'acquisition (`acquisition_batch`)
Le legacy n'a pas d'entité « lot » : on la matérialise depuis `strGUID` (D5).
```sql
INSERT INTO acquisition_batch (batch_guid, scanned_by, scan_date, document_count, status, created_at)
SELECT
  -- batch_guid : strGUID si UUID valide, sinon uuid généré (conserver le strGUID dans source_label)
  CASE WHEN d."strGUID" ~* '^[0-9a-f-]{36}$' THEN d."strGUID"::uuid ELSE gen_random_uuid() END,
  MAX(aq."Scanned_by"), MAX(aq."Date_scan"),
  COUNT(DISTINCT d."Document_Id"), 1, now()
FROM legacy.tbl_common_document d
LEFT JOIN legacy.tbl_archives_document_assurance_qualite aq ON aq."Document_Id" = d."Document_Id"
WHERE d."strGUID" IS NOT NULL
GROUP BY d."strGUID";
```
Puis back-fill `document.batch_id` par jointure sur `strGUID`. Documents **sans `strGUID`** → `batch_id = NULL` (acceptable).

### 6.2 Extraction des binaires `VARBINARY(MAX)` → disque (le gros morceau)
~93 429 fichiers stockés dans la base SQL Server. Job Node **en streaming**, jamais tout en mémoire :
- Requête paginée triée sur `File_Id` (curseur reprenable).
- Pour chaque ligne : déterminer l'extension (depuis `File_name_string` / `File_Type_id`), écrire `{ARCHIVES}/{file_id}{extension}`.
- Journaliser (id, taille, sha256) pour la réconciliation ; comparer `byte_length` ↔ taille fichier écrite.
- Exécutable **en parallèle** du chargement relationnel ; ne dépend que de `document_file.file_id` (préservé).
- Prévoir l'espace disque (somme des `File_length`) et la stratégie d'arborescence (éventuel sharding par tranche d'id si un dossier plat de 93 k fichiers pose souci côté FS).

### 6.3 Arbres nested-set/`PARENT_ID` → `path` + `depth`
`classification_plan`, `location`, `dossier` : abandonner `BG/BD/NIVEAU`, recalculer `path`/`depth` via CTE récursive après reprise des `parent_id` :
```sql
WITH RECURSIVE t AS (
  SELECT dossier_id, parent_id, 0 AS depth,
         lpad(dossier_id::text, 10, '0') AS path
  FROM dossier WHERE parent_id IS NULL
  UNION ALL
  SELECT c.dossier_id, c.parent_id, t.depth + 1,
         t.path || '.' || lpad(c.dossier_id::text, 10, '0')
  FROM dossier c JOIN t ON c.parent_id = t.dossier_id
)
UPDATE dossier d SET depth = t.depth, path = t.path FROM t WHERE t.dossier_id = d.dossier_id;
```
Attention : **normaliser la sentinelle `PARENT_ID = 1` → `NULL`** (racine) **avant** la récursion, et détecter d'éventuels cycles/orphelins legacy (intégrité applicative non garantie).

### 6.4 `version_number` / `is_current`
Calculés par fenêtre (cf. §5). Garantir l'invariant « exactement une `is_current=true` par document » avant de poser l'index unique partiel ; vérifier les documents sans aucune version (en créer une par défaut si besoin pour que P3 résolve des fichiers).

### 6.5 Conversions de types
| Legacy (SQL Server) | Cible | Règle |
|---|---|---|
| `NVARCHAR` (UTF-16) | `varchar`/`text` (UTF-8) | conversion d'encodage (pgloader/Node) ; accents FR préservés |
| `NVARCHAR(MAX)` borné cible (`label varchar(500)`) | `varchar(n)` | **troncature contrôlée** + log des valeurs tronquées |
| `DATETIME` (sans TZ) | `timestamptz` (UTC) | `AT TIME ZONE '<tz source>'` (§10 — Abidjan = UTC+0 ; à confirmer) |
| `BIT` | `boolean` | 0/1 → false/true |
| `TINYINT`/`INT` IDENTITY | `int`/`smallint`/`bigint` | `file_type_id` TINYINT→int ; audits → bigint |
| `VARBINARY(MAX)` | (disque) | §6.2 |

### 6.6 Habilitations & deny-by-default (RISQUE MAJEUR)
Règle cible P3 : un document est visible **ssi** une `document_permission` *ou* une `document_type_permission` (sur son type, pour un groupe de l'utilisateur) l'autorise, *ou* `is_admin`. Conséquence de la reprise brute :
- `TBL_COMMON_DOCUMENT_SECURITY` = **9 lignes** seulement → quasi aucun document couvert au niveau instance.
- Les **615 lignes** de permissions par type (`PROFILS` + `UTILISATEUR`) couvrent les documents dont le `document_type_id` est renseigné et habilité — mais **pas** les documents sans type, ni les types non couverts.

**Sans back-fill, la majorité des ~42 000 documents devient invisible.** Définir une **politique de reprise des droits** (à trancher, §10), p. ex. :
1. **Recommandé** : pour chaque document, auto-`document_permission` *Consultation* au **groupe créateur** (dérivé de `created_by` → `app_user_group.group_id`) — aligné sur FR-029.
2. Compléter les `document_type_permission` manquants par une règle par défaut (p. ex. consultation au service propriétaire), ou
3. Politique transitoire large (consultation à tous les groupes) puis resserrage — **déconseillé** sur données sensibles.

> Remarque : le legacy gérait aussi la sensibilité via `TBL_COMMON_DOCUMENT_CONFIDENTIALITE` / `TBL_COMMON_SEC_CONFIDENTIALITE` (non repris). Si ces niveaux conditionnaient l'accès, en tenir compte dans la politique de back-fill.

### 6.7 Doublons vs contraintes d'unicité (tension avec « mêmes identifiants »)
- **Uniques *partielles*** (`document_type.label`, `dossier.label`, `WHERE is_active`) : conserver **tous** les IDs et FK, ne garder qu'**un actif** par libellé, passer les doublons à `is_active = false`. → identifiants intacts. ✅
- **Unique *totale*** `file_type.extension` : impossible de garder deux IDs pour la même extension → **fusion** : un id canonique par extension + réécriture de `document_file.file_type_id` via table de correspondance. C'est le **seul** endroit où des IDs legacy sont remappés. Documenter la table de correspondance.

### 6.8 Mots de passe
`tbl_Users.Password` = `NVARCHAR(50)` (vraisemblablement en clair ou hash faible ; aucune table ASP.NET Membership réelle — `AspNet_SqlCacheTablesForChangeNotification` n'est qu'un cache). La cible exige **bcrypt** (FR-034). Options :
1. **Reset forcé** (recommandé, sûr) : `password_hash` = hash bcrypt d'un secret aléatoire, `must_change_pwd = true`, parcours « mot de passe oublié » à la 1ʳᵉ connexion.
2. **Re-hash transparent** : *si et seulement si* `Password` est en clair, le bcrypt-er pendant la reprise → les utilisateurs conservent leur mot de passe. À valider (format/échantillon).

### 6.9 Intégrité référentielle orpheline
Le legacy gère les FK en code → présence probable d'orphelins (`Document_Id`, `Utilisateur_id`, `Type_Document_Id` pointant vers des lignes absentes). Avant d'activer les FK **contraintes** de la cible : exécuter des **contrôles anti-orphelins** (§8) et décider, par cas, entre *nullifier* la référence ou *écarter* la ligne (journalisé).

---

## 7. Ordre d'exécution (respect des FK contraintes)

1. **Schéma cible** : `prisma db push` + migrations SQL brut (uniques partiels, CHECK, colonne générée `full_name`, tsvector/GIN) — cf. data-model §« Contraintes en SQL brut ».
2. **Chargement `legacy.*`** (miroir brut) — canal (A).
3. **Extraction binaires** — canal (B), en parallèle.
4. **Sécurité & référentiels** : `app_user` → `app_group` → `app_user_group` ; `permission_level`, `document_type`, `classification_plan`, `location`, `dossier_category` → `dossier`, `dossier_exit_motive`, `file_type`, `intercalaire_category`, `audit_action`.
5. **Cœur** : `acquisition_batch` → `document` → `document_version` → `document_file`.
6. **ACL & audit** : `document_type_permission`, `document_permission` (+ back-fill §6.6), `navigation_audit`, `data_change_audit`.
7. **Post-traitement** : recalcul `path`/`depth` (§6.3), `is_current` (§6.4), alimentation tsvector/GIN, **`setval` de toutes les séquences** (§3), `ANALYZE`.
8. **Validation** (§8). Puis bascule.

---

## 8. Validation & réconciliation

- **Comptes** : `COUNT(*)` source vs cible par table (en tenant compte des exclusions/dédoublonnages, chiffrés).
- **Sommes de contrôle** : `SUM(File_length)` legacy ↔ somme des tailles de fichiers écrits sur disque ; nombre de fichiers attendus (93 429) vs présents ; échantillon de sha256.
- **Intégrité FK** : zéro orphelin après reprise (`document.dossier_id`, `document_file.document_version_id`, etc.) — sinon les FK contraintes échoueraient.
- **Invariants** : exactement une `document_version.is_current=true` par document ; `acquisition_batch.status ∈ {0,1,2}` ; bénéficiaire exclusif des `document_type_permission` ; libellés uniques parmi les actifs.
- **Arbres** : pas de cycle, profondeur cohérente, `path` trié = rendu attendu.
- **Bout-en-bout P3** : sur un échantillon, vérifier qu'un utilisateur **voit** ses documents (validation du back-fill d'habilitations §6.6), que la recherche plein-texte (OCR) remonte des résultats, et qu'un fichier s'**ouvre** depuis le disque.
- **Audit** : `id_audit`/`AUDIT_ID` max ↔ séquences recalées ; horodatages cohérents après conversion UTC.

---

## 9. Tables **non reprises** en v1 (à parquer / décider)

Aucune cible dans le modèle 21 tables. Recommandation : **archiver le dump SQL Server** et garder le schéma `legacy.*` quelque temps pour reprise ultérieure éventuelle. À acter explicitement (perte fonctionnelle assumée) :

| Domaine legacy | Tables (extrait) | Statut v1 |
|---|---|---|
| Indexation / métadonnées | `TBL_COMMON_INDEXATION_META*`, `…_FOLKSONOMY*`, `…_TAXONOMY*`, `…_TYPE_DESCRIPTION*` | Non repris (pas de cible) |
| Cycle de vie / DUA | `TBL_ARCHIVES_DOCUMENT_CYCLE_VIE*`, `…_MODE_DESTRUCTION`, `…_SORT_FINAL`, `…_TYPE_DOCUMENT_CYCLE_VIE` | Non repris |
| Confidentialité | `TBL_COMMON_DOCUMENT_CONFIDENTIALITE`, `TBL_COMMON_SEC_CONFIDENTIALITE` | Non repris (mais à considérer pour la politique de droits §6.6) |
| Commentaires / paraphes | `TBL_COMMON_DOCUMENT_COMMENTAIRES`, `…_PARAPH` | Non repris |
| Dossiers perso / prêts | `TBL_COMMON_DOSSIER_PERSO*`, `…_RESERVATIONS`, `…_SORTIES*` | Non repris (référentiel motifs repris) |
| Log d'accès document | `TBL_COMMON_DOCUMENT_ACCESS` (33 202) | **Option** : verser dans `navigation_audit` (sinon non repris) |
| Alertes / notifications | `TBL_COMMON_ALERTE*` (211 k) | Non repris |
| Menus / dashboards | `tbl_Common_Menu*`, `TBL_COMMON_DASHBOARD_*` | Non repris (gérés par la nouvelle app) |
| GED espaces | tout `TBL_GED_*` | Non repris |
| Mail | tout `TBL_MAIL*` | Non repris |
| Workflow | `tbl_Workflow*`, `TBL_WF_*` | Non repris (champs `workflow_*` réservés sur `document`) |
| RH / Évaluation | `TBL_EVALUATION_*` | Non repris |
| Divers/techniques | `AspNet_*`, `sysdiagrams`, `AA_TEST_*`, `zz_*`, `tesmp_*` | Ignorés |

---

## 10. Décisions ouvertes (à trancher avant la bascule)

1. **Fuseau source** des `DATETIME` → UTC : confirmer (Abidjan/Aconda = UTC+0 ⇒ conversion neutre ; sinon `AT TIME ZONE` adapté).
2. **Mots de passe** : reset forcé (§6.8 option 1) **ou** re-hash transparent si stockage en clair (option 2) ?
3. **Politique d'habilitation** de reprise (§6.6) : auto-grant créateur + complément par type ? Niveau de confidentialité legacy à réintroduire ?
4. **`is_admin`** : source de vérité (groupe « Administrateurs » ? liste manuelle ?).
5. **`Profils_id` ≡ `groupId`** ? (mapping des `document_type_permission` par profil).
6. **Correspondance `Security_Categorie_id` → `permission_level_id`** : vérifier l'alignement des 5 libellés.
7. **`TBL_COMMON_DOCUMENT_ACCESS`** : verser dans `navigation_audit` ou abandonner ?
8. **Outil canal (A)** : `pgloader` vs exporteur Node maison (cohérence monorepo TS).
9. **Volume audit** (285 k + 78 k) : tout reprendre ou tronquer à une fenêtre (p. ex. 2 ans) ?
10. **`location_id`/`document_date` au niveau document** : laisser NULL ou dériver (du dossier / du cycle de vie) ?

---

## 11. Livrables & jalons de mise en œuvre

| Jalon | Livrable | Sortie |
|---|---|---|
| J1 — Profilage | Script d'inventaire (counts, nulls, doublons, orphelins, validité UUID `strGUID`, format `Password`) | rapport de qualité |
| J2 — Schéma cible | `prisma db push` + migrations SQL brut appliquées | base cible vide conforme |
| J3 — Staging | Chargement `legacy.*` (pgloader/Node) | miroir brut chargé |
| J4 — Binaires | Job d'extraction VARBINARY→disque + manifeste sha256 | `{ARCHIVES}` peuplé |
| J5 — Transform | Scripts SQL ordonnés (réf → cœur → ACL/audit) + correspondances (file_type, sec_cat) | 21 tables peuplées, séquences recalées |
| J6 — Post-traitement | path/depth, is_current, tsvector/GIN, back-fill droits | invariants posés |
| J7 — Validation | Réconciliation + tests P3 bout-en-bout | go/no-go bascule |

> Suggestion d'emplacement des scripts : `packages/db/migrations-reprise/` (SQL ordonnés) + `apps/migration/` (jobs Node : export relationnel optionnel & extraction binaires).
