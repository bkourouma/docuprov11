# Quickstart — Validation bout-en-bout

**Feature**: Reprise « Archivage par QR » (`001-archivage-qr`)
**But**: prouver que les trois user stories fonctionnent de bout en bout. Guide de validation/exécution — l'implémentation détaillée relève de `tasks.md`.

## Prérequis

- **Node.js LTS ≥ 20** + **pnpm** (monorepo pnpm workspaces + Turborepo).
- **Docker** + **Docker Compose** (PostgreSQL + Redis).
- **OCR** : **Tesseract.js** (pur-Node, données `fra`/`eng` téléchargées par la lib — aucune dépendance système). Option : binaire **Tesseract CLI** + `TESSERACT_DATA_PATH` pour plus de débit.
- **poppler-utils** si l'on retient `pdftoppm` pour la rastérisation (sinon pdfjs-dist suffit).
- Racine de stockage `ARCHIVES` (`storage/archives/`) accessible en écriture (binaires hors base, D-16).
- Variables d'environnement (`.env`) : `DATABASE_URL`, `REDIS_URL`, `ARCHIVES_PATH`, `JWT_SECRET`, données Tesseract.

## Mise en place

```bash
# Dépendances du monorepo
pnpm install

# Démarrer PostgreSQL + Redis
docker compose up -d postgres redis

# Schéma : appliquer les migrations Prisma (21 tables + contraintes SQL brut + tsvector/GIN)
pnpm --filter @archivage/db prisma migrate deploy

# Générer le client Prisma
pnpm --filter @archivage/db prisma generate

# Seed (permission_level, 5 intercalaire_category, admin user, référentiels de démo)
pnpm --filter @archivage/db prisma db seed
```

**Seeds attendus** : `permission_level` (1→5), `intercalaire_category` (5 lignes : TYPE_DOCUMENT, PLAN, LOCALISATION, DOSSIER, BLANK), un `app_user` administrateur (`is_admin=true`), quelques `document_type`/`dossier` de démonstration.

## Lancement

```bash
# Tout le monorepo (web + api + worker) via Turborepo
pnpm dev
# ou séparément :
pnpm --filter @archivage/api dev       # NestJS REST (Swagger sur /api/docs)
pnpm --filter @archivage/worker dev    # worker BullMQ (OCR/QR/PDF)
pnpm --filter @archivage/web dev        # Next.js (UI P1/P2/P3)

# Tout-en-conteneurs (alternative)
docker compose up --build
```

Ouvrir l'application, se connecter avec le compte administrateur de seed (obtient un **JWT Bearer**).

---

## Scénario 1 — P1 : génération d'intercalaires (User Story 2)

**Objectif** : produire un PDF d'intercalaires imprimables (FR-001→007).

1. Écran « Intercalaires » → catégorie **Plan de classement** → liste **en arbre indenté** (FR-002, `depth`/`path`).
2. Cocher plusieurs éléments (sélection multiple, FR-003) → **Générer**.
3. **Attendu** : PDF *inline*, **une page A4 par élément**, chacune avec libellé de catégorie + QR + libellé d'élément (FR-004).
4. Relire un QR → charge utile `DOCUPRO|1|INTERCALAIRE|PLAN|{id}` (contrat [qr-payload.md](contracts/qr-payload.md), CA-P1-b).
5. **Cas limite** : ne rien cocher → bouton **Générer** désactivé ; aucun PDF vide (CA-P1-a, FR-006).
6. **Séparateur vierge** → page « blank » (`DOCUPRO|1|INTERCALAIRE|BLANK|0`) (FR-007).

**API** : `GET /api/intercalaires/items?category=PLAN`, `POST /api/intercalaires/generate`.

---

## Scénario 2 — P2 : acquisition par lot (User Story 1)

**Objectif** : un lot de PDF scannés est découpé en documents corrects (FR-008→020).

**Fixture** : un PDF simulant une liasse, dans l'ordre :
`[intercalaire TYPE_DOCUMENT id=T]`, page A, page B, `[intercalaire DOSSIER id=D]`, page C, `[intercalaire BLANK]`, page E.

1. Écran « Acquisition » → **dossier existant** *ou* **Nouveau dossier** (FR-008).
   - **Cas limite** : nouveau dossier au libellé déjà actif → **409 refus** (FR-009, CA-P2-b).
2. Téléverser la fixture (multi-fichiers, barre de progression, FR-010) → **lot** créé (`status=0`), `batch_guid` généré (FR-011) ; un **job BullMQ** est enfilé.
3. Le **worker** traite le job de façon asynchrone ; suivre la progression (FR-019) via `GET /api/batches/{id}`.
4. **Attendu après traitement** :
   - **Document 1** : ouvert par l'intercalaire TYPE_DOCUMENT (`document_type_id=T`), pages A+B.
   - **Document 2** : ouvert par l'intercalaire DOSSIER (`dossier_id=D` **prévaut**, FR-016), page C.
   - **BLANK** clôt le document courant (FR-014) ; page E suit la règle « sans QR » (FR-015).
   - Nombre de documents = K (ou K+1 si pages avant le 1er intercalaire) — **CA-P2-a**.
5. Chaque fichier : `ocr_text` renseigné (pdfjs-dist ou Tesseract), `file_type` résolu par extension **sans doublon** (CA-P2-d), binaire sous `storage/archives/{file_id}{extension}` (FR-017, D-16).
6. Tous les documents/fichiers partagent `batch_id` (CA-P2-c) ; chaque document `is_archived=false`, `created_by`=opérateur (FR-018).
7. Fin : compteurs et `status` du lot mis à jour ; lien vers validation/indexation présent (FR-019).
8. **Idempotence** : rejouer (`POST /api/batches/{id}/reprocess`) ne crée **pas** de doublons (FR-020).

**API** : `POST /api/batches`, `POST /api/batches/{id}/files`, `GET /api/batches/{id}`, `POST /api/batches/{id}/reprocess`.

---

## Scénario 3 — P3 : recherche, ouverture, export, habilitation (User Story 3)

**Objectif** : grille filtrable + plein-texte + export + deny-by-default (FR-021→029).

**Pré-données** : documents du scénario 2 + droits : `consultant` a un `document_permission` (Consultation) sur le **Document 1** seulement.

1. Écran « Recherche » (en `consultant`) → grille montre **Document 1**, **pas Document 2** (deny-by-default, FR-026, CA-P3-b).
2. Filtrer par type/dossier/plan/localisation/date ; trier ; regrouper ; paginer (FR-021/022).
3. **Recherche plein-texte** : terme présent uniquement dans l'OCR d'un fichier du Document 1 → le document remonte (FR-023, SC-006).
4. Cliquer le **libellé** du Document 1 → fiche/visionneuse, **version courante** → fichiers (FR-024) ; binaire streamé du disque.
5. **Export** (xlsx, pdf, docx, csv) → reflète **exactement** le filtre/tri, sans Document 2 (FR-025, CA-P3-a, SC-005).
6. Se connecter **administrateur** → grille montre **tous** les documents (FR-028).
7. **Cas limite** : `GET /api/documents/{id_Document2}` en `consultant` → **403/404** (CA-P3-b).

**API** : `POST /api/documents/search`, `POST /api/documents/export`, `GET /api/documents/{id}`, `GET /api/documents/{id}/files/{fileId}/content`.

---

## Tests automatisés (rappel)

```bash
pnpm test                                   # tout le monorepo (Turborepo)
pnpm --filter @archivage/qr test            # parse/format du contrat QR
pnpm --filter @archivage/worker test        # pipeline P2 (PDF fixtures → documents)
pnpm --filter @archivage/api test:e2e       # conformité endpoints ↔ contracts/openapi.yaml (Supertest)
```

## Critères de succès vérifiés (mapping)

| Scénario | Success Criteria couverts |
|---|---|
| 1 (P1) | SC-002 (QR relisible), SC-008 (pas de doc vide) |
| 2 (P2) | SC-001 (K/K+1 docs corrects), SC-003 (QR non conformes rejetés), SC-009 (anti-doublon dossier), SC-010 (batch_id partagé) |
| 3 (P3) | SC-004 (0 fuite habilitation), SC-005 (export fidèle), SC-006 (plein-texte OCR), SC-007 (échelle) |
