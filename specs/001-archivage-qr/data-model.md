# Phase 1 — Data Model

**Feature**: Reprise « Archivage par QR » (`001-archivage-qr`)
**Date**: 2026-06-11
**Source**: spec.md (Key Entities, FR-030→037) + PRD §7 (modèle de référence).
**Cible**: **PostgreSQL** via **Prisma** (schéma multi-fichiers).

**21 tables** en 4 catégories. Toutes les FK sont **contraintes** (D3). Horodatages **UTC** (`timestamptz`, D-19). Le modèle reprend le PRD §7 ; les types sont exprimés pour PostgreSQL/Prisma.

> Le schéma Prisma vit dans `packages/db/prisma/models/{core,referentials,security,audit}.prisma`. Les contraintes **non couvertes nativement par Prisma** sont ajoutées en **SQL brut** dans les migrations (cf. §« Contraintes en SQL brut »).

## Correspondance de types (SQL Server PRD → PostgreSQL/Prisma)

| PRD (SQL Server) | PostgreSQL | Prisma |
|---|---|---|
| `INT IDENTITY` | `int GENERATED … AS IDENTITY` | `Int @id @default(autoincrement())` |
| `BIGINT IDENTITY` | `bigint … IDENTITY` | `BigInt @id @default(autoincrement())` |
| `UNIQUEIDENTIFIER` | `uuid` (`gen_random_uuid()`) | `String @db.Uuid @default(dbgenerated("gen_random_uuid()"))` |
| `NVARCHAR(n)` | `varchar(n)` | `String @db.VarChar(n)` |
| `NVARCHAR(MAX)` | `text` | `String @db.Text` |
| `DATETIME2(0)` | `timestamptz(0)` (UTC) | `DateTime @db.Timestamptz(0)` |
| `DATE` | `date` | `DateTime @db.Date` |
| `BIT` | `boolean` | `Boolean` |
| `TINYINT` (statut) | `smallint` + CHECK | `Int @db.SmallInt` |
| `BIGINT` | `bigint` | `BigInt` |

---

## 1. Cœur métier (4) — `models/core.prisma`

### `acquisition_batch` — Lot d'acquisition
Session de numérisation (matérialise le `StrGuid` legacy, D5). Entité de 1er rang.

| Champ | Type | Règles |
|---|---|---|
| `batch_id` (PK) | autoincrement | — |
| `batch_guid` | uuid | **UNIQUE**, défaut `gen_random_uuid()` |
| `dossier_id` | int? → `dossier` | dossier cible (auto-créé si besoin) |
| `scanned_by` | int? → `app_user_group` | opérateur |
| `scan_date` | timestamptz | défaut now() UTC |
| `source_label` | varchar(255)? | nom dossier/scanner |
| `file_count` | int | défaut 0 ; MAJ fin de traitement |
| `document_count` | int | défaut 0 ; MAJ fin de traitement |
| `status` | smallint | **CHECK ∈ {0,1,2}** ; voir *États* |
| `created_at` | timestamptz | défaut now() UTC |

- **Relations** : 1 lot → N `document`. FK dossier, FK user.
- **Règles** : FR-011 (1 lot par session) ; FR-019 (compteurs/statut MAJ en fin) ; CA-P2-c.
- **États** (`status`) : `0 ouvert` → `1 terminé` / `2 échec`. Piloté par le worker BullMQ (D-05). Idempotence : un lot rejoué reprend sans dupliquer.

### `document` — Document
Unité documentaire archivée. Fusionne l'AQ legacy (`is_archived`, `validated_*`).

| Champ | Type | Règles |
|---|---|---|
| `document_id` (PK) | autoincrement | — |
| `label` | varchar(500) | **NOT NULL** |
| `document_type_id` | int? → `document_type` | attribut (intercalaire type) |
| `plan_id` | int? → `classification_plan` | attribut (intercalaire plan) |
| `location_id` | int? → `location` | attribut (intercalaire localisation) |
| `dossier_id` | int? → `dossier` | rattachement (intercalaire dossier **prévaut**, FR-016) |
| `batch_id` | int? → `acquisition_batch` | lot d'origine |
| `cote` | varchar(50)? | référence d'archivage |
| `document_date` | date? | **date métier** (affichée P3, FR-036) |
| `archive_year` | int? | année d'archivage |
| `is_archived` | boolean | défaut false ; voir *États* |
| `is_frozen` | boolean | défaut false (gel/legal hold) |
| `overview` | text? | aperçu |
| `validated_by` / `validated_at` | int? → `app_user_group` / timestamptz? | QA (hors périmètre v1, prévu) |
| `workflow_instance_id` / `workflow_task_id` | int? | réservés |
| `created_by` / `created_at` | int? → `app_user_group` / timestamptz | créateur = opérateur (FR-018) |
| `modified_by` / `modified_at` | int? / timestamptz? | — |

- **Relations** : N→1 type/plan/location/dossier/batch/créateur ; 1→N `document_version` ; 1→N `document_permission`.
- **Index** : couvrants par dossier, type, date, plan, location, batch, `(is_archived,is_frozen)`.
- **États** (`is_archived`) : `false en attente QA` (acquisition) → `true validé/archivé` (validation QA renseigne `validated_by`/`validated_at`). `is_frozen` orthogonal.

### `document_version` — Version de document
| Champ | Type | Règles |
|---|---|---|
| `document_version_id` (PK) | autoincrement | — |
| `document_id` | int → `document` | **onDelete: Cascade** |
| `version_number` | int | défaut 1 ; **@@unique(document_id, version_number)** |
| `is_current` | boolean | défaut true ; **une seule courante** (index unique partiel `WHERE is_current`) |
| `is_validated` | boolean | défaut false |
| `comment` | text? | — |
| `created_by` / `created_at` | int? / timestamptz | — |

- **Règles** : FR-024 (P3 résout la **version courante** → fichiers). Invariant : exactement une `is_current=true` par document.

### `document_file` — Fichier de document
| Champ | Type | Règles |
|---|---|---|
| `file_id` (PK) | autoincrement | nom disque = `{file_id}{file_extension}` (D-16) |
| `document_version_id` | int → `document_version` | **onDelete: Cascade** |
| `file_type_id` | int → `file_type` | int (legacy TINYINT supprimé, D4) |
| `original_name` | varchar(500)? | nom d'origine |
| `file_extension` | varchar(16) | — |
| `byte_length` | bigint? | — |
| `page_count` | int? | — |
| `ocr_text` | text? | **texte OCR** → full-text P3 (FR-023) |
| `redaction` / `pdf_owner` / `pdf_password` | text?/varchar? | réservés |
| `sort_order` | int | défaut 0 (ordre des pages dans le lot, FR-012) |
| `created_at` | timestamptz | défaut now() UTC |

- **Index** : `IX_file_version` ; **`tsvector` généré + GIN** sur `ocr_text` (D-13).
- **Règles** : FR-017 (OCR + résolution type + binaire disque) ; FR-023.

---

## 2. Référentiel / Paramétrage (8) — `models/referentials.prisma`

### `document_type` — Type de document (liste plate)
`document_type_id` (PK), `label` (varchar 500, NN), `code` (varchar 50?), `is_active` (défaut true).
**Unicité** : index unique **partiel** `label WHERE is_active` (FR-032). Source catégorie QR `TYPE_DOCUMENT`.

### `classification_plan` — Plan de classement (arbre, D-14)
`plan_id` (PK), `parent_id` int? → self (NULL=racine), `label` (text, NN), `code`, `is_public` (défaut false), `depth` (défaut 0), `path` (varchar 900, NN), `is_active`.
**Règles** : `path` recalculé à l'insertion/déplacement ; sous-arbre = `path LIKE @ancestor || '%'` ; rendu indenté `ORDER BY path` + `depth` (FR-002/029/031). Source catégorie QR `PLAN`.

### `location` — Localisation (arbre, D-14)
`location_id` (PK), `parent_id` int? → self, `label` (varchar 500, NN), `code`, `depth`, `path` (varchar 900, NN), `is_active`. Mêmes règles d'arbre. Source catégorie QR `LOCALISATION`.

### `dossier_category` — Catégorie de dossier
`dossier_category_id` (PK), `label` (varchar 100, NN), `is_active`.

### `dossier` — Dossier (arbre, D-14)
`dossier_id` (PK), `parent_id` int? → self (NULL=racine ; sentinelle legacy `PARENT_ID=1` supprimée), `label` (varchar 500, NN), `code`, `dossier_category_id` int? → `dossier_category`, `location_id` int? → `location`, `service_code_suffix`, `depth`, `path` (varchar 900, NN), `is_active`, `created_at`.
**Unicité** : index unique **partiel** `label WHERE is_active` → **règle anti-doublon** (FR-009, CA-P2-b). Source catégorie QR `DOSSIER`.

### `dossier_exit_motive` — Motif de sortie (réservé)
`exit_motive_id` (PK), `label` (varchar 150, NN), `is_active`. Sous-système prêt hors périmètre.

### `file_type` — Type de fichier
`file_type_id` (PK **int**, legacy TINYINT→int, D4), `extension` (varchar 16, NN), `friendly_name` (varchar 100, NN), `max_size_bytes` (bigint), `icon`, `is_media`, `is_active`.
**Unicité** : `@@unique(extension)` → empêche les doublons auto-créés (FR-017, CA-P2-d).

### `intercalaire_category` — Catégorie d'intercalaire (contrat QR, D9/D-18)
`intercalaire_category_id` (PK), `category_code` (varchar 20, NN, **UNIQUE**) ∈ {`TYPE_DOCUMENT`,`PLAN`,`LOCALISATION`,`DOSSIER`,`BLANK`}, `target_table` (varchar?), `target_column` (varchar?) (NULL si BLANK), `is_blank` (défaut false), `is_ingest_handled` (défaut true — les 4 gérées, D9), `label` (varchar 100, NN).
**Données de référence** (seed) :

| code | target_table | target_column | is_blank |
|---|---|---|---|
| TYPE_DOCUMENT | document_type | document_type_id | false |
| PLAN | classification_plan | plan_id | false |
| LOCALISATION | location | location_id | false |
| DOSSIER | dossier | dossier_id | false |
| BLANK | (null) | (null) | true |

---

## 3. Sécurité (6) — `models/security.prisma`

### `app_user` — Utilisateur
`user_id` (PK), `username` (varchar 400, NN, **UNIQUE**), `first_name`/`last_name` (varchar 50, NN), `full_name` (**colonne générée** `first_name || ' ' || last_name`, SQL brut), `email`, `phone`, `password_hash` (**bcrypt**, FR-034 ; jamais en clair), `must_change_pwd`, `service_id`, `matricule`, `is_disabled`, `is_admin` (booléen — admin = court-circuit habilitation, D-17), `created_at`.

### `app_group` — Profil / fonction
`group_id` (PK), `name` (varchar 200, NN), `is_active`.

### `app_user_group` — Identité applicative effective (D7)
`user_group_id` (PK — **acteur de toutes les FK** créateur/validateur/audit), `user_id` int NN → `app_user` (Cascade), `group_id` int NN → `app_group`, `is_default`. **@@unique(user_id, group_id)**.

### `permission_level` — Niveau de permission (table de domaine)
`permission_level_id` (PK, **non autoincrement** — valeurs métier), `name`. Seed : `1 Consultation, 2 Création, 3 Modification, 4 Validation/Publication, 5 Prêts/Communication`.

### `document_type_permission` — ACL par TYPE (gabarit)
`document_type_permission_id` (PK), `document_type_id` int NN → `document_type` (Cascade), `permission_level_id` int NN → `permission_level`, `group_id` int? → `app_group`, `user_group_id` int? → `app_user_group`.
**CHECK** (SQL brut) : exactement un bénéficiaire (`(group_id IS NULL) <> (user_group_id IS NULL)`).

### `document_permission` — ACL par DOCUMENT (instance)
`document_permission_id` (PK), `document_id` int NN → `document` (Cascade), `permission_level_id` int NN → `permission_level`, `user_group_id` int NN → `app_user_group`, `granted_by` int?, `granted_at` (timestamptz, défaut now()). **@@unique(document_id, user_group_id, permission_level_id)**.
**Rôle** : auto-grant consultation au groupe créateur à l'acquisition (FR-029).

> **Règle d'habilitation P3 (deny-by-default, D-17)** : un document est visible/ouvrable ssi
> `EXISTS document_permission(document_id, user_group_id, level≥Consultation)`
> `OR EXISTS document_type_permission(document.document_type_id, [group_id ∈ groupes de l'utilisateur OR user_group_id], level≥Consultation)`
> `OR app_user.is_admin`. Sinon invisible (FR-026→028, CA-P3-b).

---

## 4. Audit / Journal (3) — `models/audit.prisma`

### `audit_action` — Référentiel d'actions
`audit_action_id` (PK), `description` (varchar 500, NN).

### `navigation_audit` — Journal de navigation (gros volume)
`audit_id` (PK **bigint**), `user_group_id` int? → `app_user_group`, `activity` (text?), `url` (varchar 2000?), `menu_id` (int?), `activity_at` (timestamptz, défaut now()), `actor_full_name`/`actor_role`/`actor_service`, `ip_address`, `machine_name`. Index `(user_group_id, activity_at)` et `(activity_at)`.
**Rôle** : FR-033 ; trace de consultation/ouverture P3 (alimentée aussi par Pino).

### `data_change_audit` — Journal de modification de données
`data_change_audit_id` (PK bigint), `user_group_id` int? → `app_user_group`, `audit_action_id` int? → `audit_action`, `changed_at` (timestamptz, défaut now()), `object_ref` (varchar 256?, ex. `document:12345`), `old_value` (text?), `new_value` (text?). Index `(user_group_id, changed_at)` et `(object_ref)`.
**Rôle** : FR-033 (qui a changé quoi).

---

## Contraintes en SQL brut (migrations Prisma)

Prisma ne couvre pas nativement ces éléments → migrations SQL ajoutées dans `packages/db/prisma/migrations/` :

1. **Index uniques partiels** : `document_type(label) WHERE is_active`, `dossier(label) WHERE is_active`, `document_version(document_id) WHERE is_current`.
2. **CHECK** : `acquisition_batch.status IN (0,1,2)` ; `document_type_permission` bénéficiaire exclusif.
3. **Colonne générée** : `app_user.full_name` (`GENERATED ALWAYS AS (first_name || ' ' || last_name) STORED`).
4. **Full-text** : colonne `tsvector` générée sur `document_file.ocr_text` (+ option libellé/cote) + **index GIN**.
5. **Index couvrants** P3 sur `document` (dossier/type/date) et ACL (`document_permission(document_id,user_group_id)`, `document_type_permission(document_type_id)`).

## Ordre de création (intégrité FK)

1. **Sécurité & référentiels** : `app_user` → `app_group` → `app_user_group` ; `document_type`, `classification_plan`, `location`, `dossier_category` → `dossier`, `file_type`, `intercalaire_category`, `permission_level`, `audit_action`.
2. **Cœur métier** : `acquisition_batch` → `document` → `document_version` → `document_file`.
3. **ACL & audit** : `document_type_permission`, `document_permission`, `navigation_audit`, `data_change_audit`.

## Règles transverses (récap, mappées spec)

| Règle | Source |
|---|---|
| Découpage QR : non-blank ouvre + applique attribut ; blank = séparateur ; sans QR = rattachement courant | FR-013→016 |
| Tous docs/fichiers d'un upload partagent `batch_id` ; compteurs/statut MAJ en fin | FR-011, FR-019, CA-P2-c |
| Cycle archivage `is_archived` false→true (validation QA) | FR-018, états `document` |
| Binaire disque `{file_id}{extension}` ; 1 type par extension | FR-017, D-16 |
| Dossier : libellé unique (actifs) ; racines `parent_id IS NULL` | FR-009 |
| Hiérarchies : `path` recalculé ; sous-arbre par `LIKE`; rendu `ORDER BY path` + `depth` | FR-029/031, D-14 |
| Recherche P3 : plein-texte libellé + cote + `ocr_text` (`tsvector`/GIN) ; filtres type/dossier/plan/localisation/date | FR-021→023 |
| Habilitation P3 deny-by-default (instance OU type OU admin) | FR-026→028, D-17 |
| Contrat QR : namespace+version validés ; catégorie validée contre `intercalaire_category` | FR-035, D-18 |
