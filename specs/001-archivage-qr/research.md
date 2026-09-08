# Phase 0 — Research & Technical Decisions

**Feature**: Reprise « Archivage par QR » (`001-archivage-qr`)
**Date**: 2026-06-11
**Stack**: JavaScript/TypeScript (Node) — décision produit retenue à la place de la cible .NET initiale du PRD.

Toutes les inconnues techniques du plan sont résolues ci-dessous. Les deux points ouverts de la spec (R7 horaire, R8 format QR) sont tranchés ici car ils n'ont aucun impact sur le périmètre fonctionnel.

> **Changement de cap** : le PRD §13 proposait une pile .NET/C#. L'équipe a choisi une **pile 100 % JS/TS open source** (Node). Le périmètre fonctionnel, le modèle conceptuel (21 tables, 4 catégories) et les contrats sont **inchangés** ; seules les technologies d'implémentation changent.

---

## D-01 — Langage, organisation & architecture

- **Décision** : **TypeScript** dans un **monorepo** (pnpm workspaces + **Turborepo**), architecture **Modular Monolith + worker async**.
- **Rationale** : un seul domaine cohérent (archivage QR) → pas de microservices. Le monorepo partage types/contrats entre `web`, `api` et `worker` ; le worker isole les traitements lourds (OCR/QR/PDF). TypeScript pour la robustesse/maintenabilité.
- **Alternatives** : multi-repos (friction de partage de types) ; microservices (sur-dimensionné) ; JS pur (moins sûr).

## D-02 — Frontend & UI

- **Décision** : **Next.js + React (TypeScript)** ; **Ant Design** (formulaires, arbres hiérarchiques, sélection multiple, upload, **Table** pour la grille P3) + **Tailwind CSS** (mise en page/utilitaires).
- **Rationale** : logiciel métier riche en composants (arbres, grilles, filtres, upload) → Ant Design couvre nativement ces besoins ; Tailwind pour le layout responsive. Next.js pour un front moderne et le rendu/serveur des trois écrans.
- **Alternatives** : shadcn/ui (moins « métier » clé-en-main) ; MUI (équivalent, AntD plus orienté data-grid/tree).

## D-03 — Backend & API

- **Décision** : **NestJS** (REST), validation **zod** (pipe), guards/intercepteurs pour auth et audit.
- **Rationale** : nombreux modules sérieux (auth, users, permissions, referentials, intercalaires, acquisition, documents, search, exports, audit) → la structure modulaire de NestJS (modules/controllers/services/guards) garde le code propre. REST suffit pour des traitements fichiers simples et clairs.
- **Alternatives** : Express (plus léger mais tout à organiser à la main) ; Fastify (perf, mais moins de structure) ; GraphQL (inutilement complexe ici).

## D-04 — Base de données & ORM

- **Décision** : **PostgreSQL** + **Prisma** (schéma **multi-fichiers** via `prismaSchemaFolder`, migrations, client typé).
- **Rationale** : Postgres open source, robuste, excellent full-text, simple à conteneuriser ; Prisma = mapping typé + migrations. Le schéma éclaté en 4 fichiers (core/referentials/security/audit) reflète les 4 catégories de tables et autorise l'édition parallèle.
- **Contraintes non natives Prisma** → **SQL brut** dans les migrations : index **uniques partiels** (`WHERE is_active`), `CHECK` (statut lot, bénéficiaire ACL exclusif), colonne **générée** `full_name`, **unicité partielle** de la version courante, **`tsvector`/GIN** full-text.
- **Alternatives** : SQL Server + Prisma (si compatibilité legacy imposée — possible, non retenu pour une app neuve) ; TypeORM/Drizzle (Prisma préféré pour la DX et les migrations).

## D-05 — Traitement asynchrone (P2) & idempotence

- **Décision** : **Redis + BullMQ** ; à l'upload, un **lot** est persisté (`status=0 ouvert`) et un **job** est enfilé ; le **worker** (`apps/worker`) traite, met à jour progression/compteurs/statut (`1 terminé` / `2 échec`). **Idempotence par lot** : retraiter un `batch_id` purge/saute les documents/fichiers déjà produits avant de rejouer.
- **Rationale** : OCR + rastérisation + décodage QR sont lourds → hors cycle requête, sinon timeouts et API bloquée. BullMQ donne la progression, les retries et la reprise.
- **Alternatives** : traitement synchrone (timeouts) ; cron maison (moins fiable) ; files cloud (infra externe inutile).

## D-06 — Génération de QR (P1)

- **Décision** : **qrcode** (npm).
- **Rationale** : génère le PNG du QR à embarquer dans la page A4 ; permet ECC **niveau Q (25 %)** et encodage **alphanumeric** (payload ASCII).
- **Alternatives** : zxing-wasm (utilisé pour le décodage ; génération possible mais `qrcode` plus direct).

## D-07 — Décodage de QR (P2)

- **Décision** : **zxing-wasm** sur l'image rastérisée de la page de séparation ; **jsQR** en repli.
- **Rationale** : décodeur robuste (WASM ZXing), bon sur taches/rotation modérées, cohérent avec le niveau ECC Q. jsQR comme repli léger.
- **Alternatives** : OpenCV/zbar (binaire natif lourd) ; service externe (contraire à l'autonomie/offline).

## D-08 — Rastérisation & manipulation PDF

- **Décision** : **pdfjs-dist** (ou **poppler-utils** `pdftoppm` via wrapper) pour rendre une page en image (pré-requis au décodage QR) et lire le texte natif ; **pdf-lib** pour **composer** (intercalaires) et **découper** les PDF en documents.
- **Rationale** : pdfjs-dist en pur-Node évite une dépendance système ; poppler-utils en option si meilleure qualité/perf de rendu requise. pdf-lib couvre la création/découpe.
- **Alternatives** : Ghostscript (AGPL/commercial — exclu) ; mupdf (natif).

## D-09 — Extraction de texte / OCR (P2)

- **Décision** : extraire d'abord la **couche texte** du PDF via **pdfjs-dist** ; sinon OCR sur l'image rastérisée prétraitée via **Tesseract.js** (primaire, pur-Node, langues `fra`+`eng`). Un chemin **Tesseract CLI** optionnel (plus rapide en volume) est activable par configuration (`TESSERACT_DATA_PATH` + binaire présent). L'adaptateur OCR (`packages/ocr`) masque ce choix. Alimente `document_file.ocr_text`.
- **Rationale** : éviter l'OCR coûteux quand le texte est présent ; **Tesseract.js par défaut** = zéro dépendance système (ce qui est installé, démarre partout) ; le CLI reste une optimisation de débit pour la production à fort volume, sans changer le contrat de l'adaptateur.
- **Alternatives** : OCR cloud (Azure/AWS — contraire à l'autonomie OSS/offline).

## D-10 — Génération PDF imprimable (intercalaires P1, export PDF P3)

- **Décision** : **pdf-lib** pour composer l'**intercalaire A4** (créer la page, embarquer le PNG du QR de `qrcode`, ajouter libellés) ; **PDFKit** pour l'**export PDF tabulaire** de P3. **Puppeteer** documenté en alternative (HTML→PDF haute fidélité).
- **Rationale** : pdf-lib place précisément QR + texte sur A4 et sert aussi au découpage P2 ; PDFKit est léger (pas de Chromium) pour les exports. Puppeteer si l'on veut un export PDF calqué sur le rendu HTML de la grille.
- **Alternatives** : Puppeteer partout (lourd : embarque Chromium).

## D-11 — Exports P3

- **Décision** : **ExcelJS** (.xlsx), **docx** (.docx), **fast-csv** (.csv), **PDFKit** (.pdf).
- **Rationale** : libs OSS standard et robustes (échappement, UTF-8) ; l'export réutilise la **même requête de recherche** (sans pagination) pour refléter exactement le filtre/tri courant.
- **Alternatives** : csv-writer (équivalent à fast-csv).

## D-12 — Grille P3 (frontend)

- **Décision** : **Ant Design Table** (filtre/tri/regroupement/pagination) en mode **serveur** (pagination/tri envoyés à l'API) pour tenir l'échelle.
- **Rationale** : cohérent avec le choix Ant Design ; couvre colonnes, filtres, tri, regroupement et pagination serveur ; remplace la grille DevExpress legacy.
- **Alternatives** : AG Grid Community (très riche, mais on reste sur l'écosystème AntD pour l'homogénéité).

## D-13 — Recherche plein-texte

- **Décision** : **PostgreSQL Full-Text Search** — colonne **`tsvector` générée** sur `document_file.ocr_text` (+ libellé/cote) avec **index GIN** ; requête via Prisma `$queryRaw` (`to_tsquery`/`websearch_to_tsquery`).
- **Rationale** : full-text natif Postgres suffisant à l'échelle (~93 400 fichiers), aucune infra externe.
- **Alternatives** : OpenSearch/Elasticsearch (option d'échelle future, infra supplémentaire) ; table dénormalisée `document_search_index` comme optimisation.

## D-14 — Hiérarchies (plan, localisation, dossier)

- **Décision** : **liste d'adjacence (`parent_id`) + chemin matérialisé (`path`) + `depth`** ; abandon du nested-set legacy.
- **Rationale** (D2 du PRD) : `path LIKE @ancestor || '%'` couvre les sous-arbres ; `ORDER BY path` rend l'arbre indenté ; insertions/déplacements localisés. `path` recalculé à l'insertion/déplacement.
- **Alternatives** : `ltree` Postgres (option d'optimisation portable) ; nested-set (fragile, lock-heavy).

## D-15 — Authentification & hachage des secrets

- **Décision** : **JWT** (`jsonwebtoken`) + **bcrypt** pour le hachage, **guards NestJS** pour l'autorisation (rôle admin, habilitation) ; `must_change_pwd` honoré.
- **Rationale** : remplace le stockage en clair legacy (FR-034) ; JWT stateless adapté à une API REST ; bcrypt éprouvé.
- **Alternatives** : Auth.js/NextAuth (intègre côté Next ; pertinent si SSO requis — documenté) ; sessions cookie serveur (possible, JWT préféré pour l'API).

## D-16 — Stockage des binaires

- **Décision** : **système de fichiers** sous racine configurable `ARCHIVES` (`storage/archives/`), nom = `{file_id}{extension}` ; aucun blob en base (D1). Abstraction **`FileStore`** (`packages/storage`) partagée api/worker.
- **Rationale** : base légère, streaming direct depuis le disque ; `FileStore` permet un futur stockage objet (S3/MinIO) sans toucher au domaine.
- **Alternatives** : bytea Postgres (alourdit la base) ; stockage objet d'emblée (infra inutile au départ).

## D-17 — Habilitation « refus par défaut » (P3) — *résout R4*

- **Décision** : **deny-by-default** (clarification de la spec). Un document est visible/ouvrable **uniquement** si l'utilisateur a un droit explicite via `document_permission` (instance) **ou** `document_type_permission` (type). Les **administrateurs** court-circuitent le contrôle. À l'acquisition, le **groupe créateur** reçoit automatiquement un droit de consultation.
- **Implémentation** : la requête de recherche applique un prédicat ACL (`EXISTS` sur les deux tables OU rôle admin) ; index `IX_docperm_doc_user` et `IX_dtp_type`. Guard NestJS sur l'ouverture/stream.
- **Alternatives rejetées** : « public sauf restriction » (moins sûr) ; « par type uniquement » (granularité insuffisante).

## D-18 — Format du contrat QR — *résout R8*

- **Décision** : **format délimité ASCII versionné** : `DOCUPRO|1|INTERCALAIRE|{categorie}|{id}` (cf. [contracts/qr-payload.md](contracts/qr-payload.md)).
- **Rationale** : payload ASCII ⇒ encodage QR **alphanumeric** (plus dense) ; délimiteur `|` (0x7C) sans piège d'encodage (vs `¦` U+00A6 legacy) ; namespace `DOCUPRO` ignore les QR étrangers ; champ version pour l'évolutivité. Le **modèle de données ne dépend pas** de ce choix.
- **Alternatives** : JSON `{"ns":"docupro","v":1,...}` (extensible mais plus dense) — alternative documentée.
- **Paramètres** : ECC **niveau Q (25 %)**, zone de silence ≥ 4 modules, module ≥ ~0,5 mm à l'impression.

## D-19 — Horodatages : UTC vs heure locale — *résout R7*

- **Décision** : **stockage en UTC** (`timestamptz`, valeurs UTC) ; **conversion vers l'heure locale à l'affichage** ; la **date métier** `document_date` reste une `date` civile non convertie.
- **Rationale** : UTC évite les ambiguïtés (fuseaux/heure d'été) et fiabilise l'audit ; conversion = responsabilité de présentation.
- **Alternatives** : stockage heure locale (ambigu) — rejeté.

## D-20 — Observabilité, validation, conteneurs

- **Décision** : **Pino** (logs structurés, via `nestjs-pino`) ; **zod** (validation des DTO d'entrée) ; **Docker Compose** (PostgreSQL + Redis + app) pour le dev/déploiement.
- **Rationale** : journalisation propre et corrélable (alimente aussi l'audit applicatif) ; zod = validation typée alignée TS ; Compose = mise en route reproductible (Postgres + Redis + worker).
- **Alternatives** : Winston (Pino préféré pour la perf) ; class-validator (zod préféré pour l'alignement TS).

---

## Synthèse des résolutions de points ouverts

| Point spec | Sujet | Résolution |
|---|---|---|
| **R4** | Politique d'habilitation P3 | **Deny-by-default** (D-17) — confirmé par l'utilisateur. |
| **R7** | UTC vs heure locale | **UTC stocké, affichage local** (D-19). |
| **R8** | Format QR délimité vs JSON | **Délimité ASCII versionné** (D-18) ; JSON en alternative. |

**Aucune inconnue `NEEDS CLARIFICATION` ne subsiste.** Prêt pour la Phase 1.

---

## Notes de performance (vérification T056)

Vérifié sur la base de dev (volume faible — le planificateur seqscan tant que les tables sont petites,
ce qui est attendu) :

- **Plein-texte** : `EXPLAIN` (avec `enable_seqscan=off` pour exposer le plan cible) confirme que
  `to_tsvector('french', coalesce(ocr_text,'')) @@ websearch_to_tsquery(...)` utilise un
  **Bitmap Index Scan sur `ix_document_file_ocr_tsv`** (index GIN d'expression). À l'échelle observée
  (~93 400 fichiers), le planificateur basculera naturellement sur le GIN.
- **Grille P3** : `document` porte les index couvrants attendus (`document_type_id`, `dossier_id`,
  `plan_id`, `location_id`, `document_date`, `batch_id`, `(is_archived,is_frozen)`) ; les filtres de la
  grille sont donc indexés. La pagination est **serveur** (`LIMIT/OFFSET`) ; pour de très grandes
  profondeurs de pagination, envisager la pagination par curseur (keyset) — non requis à l'échelle actuelle.
- **ACL deny-by-default** : les sous-requêtes `EXISTS` s'appuient sur `document_permission(document_id,
  user_group_id)` et `document_type_permission(document_type_id)` (index présents).
- **Option d'échelle** (si besoin futur) : table dénormalisée `document_search_index` ou OpenSearch,
  conformément à D-13.
