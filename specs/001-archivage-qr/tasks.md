---
description: "Task list for Reprise « Archivage par QR » (stack JS/TS)"
---

# Tasks: Reprise « Archivage par QR »

**Input**: Design documents from `specs/001-archivage-qr/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md), [data-model.md](data-model.md), [contracts/](contracts/)

**Stack**: TypeScript monorepo (pnpm + Turborepo) — **Next.js + React + Ant Design + Tailwind** (web), **NestJS** REST (api), **BullMQ/Redis** (worker), **PostgreSQL + Prisma**, QR/PDF/OCR/exports en packages partagés. Détails dans [research.md](research.md).

**Tests**: Included. The plan's Testing section and [quickstart.md](quickstart.md) define Jest + Supertest and integration fixtures. Test tasks target the high-risk areas (QR splitting, deny-by-default ACL, exports, contract conformance) — not exhaustive coverage.

**Organization**: Tasks grouped by user story. US1 = Acquisition par lot (P1, MVP) · US2 = Génération intercalaires (P2) · US3 = Recherche & export (P3).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency on an incomplete task)
- Workspace package names: `@archivage/web`, `@archivage/api`, `@archivage/worker`, `@archivage/db`, `@archivage/qr`, `@archivage/pdf`, `@archivage/ocr`, `@archivage/exports`, `@archivage/storage`, `@archivage/types`, `@archivage/ui`, `@archivage/config`.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Monorepo scaffolding and dependencies.

- [X] T001 Scaffold the monorepo (pnpm workspaces + Turborepo): `pnpm-workspace.yaml`, `turbo.json`, root `package.json`; create `apps/web` (Next.js+React+TS), `apps/api` (NestJS), `apps/worker` (Node+BullMQ), `packages/{db,qr,pdf,ocr,exports,storage,types,ui,config}`, and `storage/archives/` per [plan.md](plan.md).
- [X] T002 Install dependencies per workspace: web (`next`, `react`, `antd`, `tailwindcss`), api (`@nestjs/*`, `@prisma/client`, `bullmq`, `ioredis`, `multer`, `zod`, `jsonwebtoken`, `bcrypt`, `nestjs-pino`/`pino`), worker (`bullmq`, `ioredis`, `pdfjs-dist`, `zxing-wasm`, `pdf-lib`, `tesseract.js`), packages (`qrcode`, `exceljs`, `docx`, `fast-csv`, `pdfkit`), dev (`jest`, `ts-jest`, `supertest`, `prisma`) — latest stable.
- [X] T003 [P] Shared config package: base `eslint`, `prettier`, `tsconfig` in `packages/config`, referenced by every workspace.
- [X] T004 [P] Env/config loading with zod validation (`DATABASE_URL`, `REDIS_URL`, `ARCHIVES_PATH`, `JWT_SECRET`, Tesseract paths) in `apps/api/src/config/` and `apps/worker/src/config/`; `.env.example` at root.
- [X] T005 [P] `docker-compose.yml` (postgres + redis, app/worker services, `storage/archives` volume) at repo root.
- [X] T006 [P] Web base: Tailwind + Ant Design provider/theme wired in `apps/web/app/layout.tsx` + `apps/web/tailwind.config.ts`.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Shared 21-table schema, auth, queue, and cross-cutting services that ALL stories depend on.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [X] T007 [P] Prisma core models (Document, DocumentVersion, DocumentFile, AcquisitionBatch) in `packages/db/prisma/models/core.prisma` per [data-model.md](data-model.md) §1.
- [X] T008 [P] Prisma referential models (DocumentType, ClassificationPlan, Location, Dossier, DossierCategory, DossierExitMotive, FileType, IntercalaireCategory) in `packages/db/prisma/models/referentials.prisma` per §2.
- [X] T009 [P] Prisma security models (AppUser, AppGroup, AppUserGroup, PermissionLevel, DocumentTypePermission, DocumentPermission) in `packages/db/prisma/models/security.prisma` per §3.
- [X] T010 [P] Prisma audit models (AuditAction, NavigationAudit, DataChangeAudit) in `packages/db/prisma/models/audit.prisma` per §4.
- [X] T011 [P] Shared types + `QrPayload` format/parse/validate (namespace `DOCUPRO`, version `1`, `INTERCALAIRE`, category enum, id) in `packages/qr/src/payload.ts` + DTO/enum types in `packages/types/src/` per [contracts/qr-payload.md](contracts/qr-payload.md). Shared US1↔US2 contract.
- [X] T012 Configure Prisma datasource/generator (`prismaSchemaFolder`) + run initial migration creating all 21 tables in `packages/db/prisma/` (depends on T007–T010).
- [X] T013 Raw-SQL migration for constraints Prisma can't express: partial unique indexes (active dossier/type label, single current version), CHECK (batch status, exclusive ACL grantee), generated `app_user.full_name`, covering indexes — in `packages/db/prisma/migrations/` (depends on T012).
- [X] T014 [P] Raw-SQL migration: generated `tsvector` column + GIN index on `document_file.ocr_text` (full-text P3) in `packages/db/prisma/migrations/` (depends on T012).
- [X] T015 [P] Seed script (permission_level 1–5; the 5 `intercalaire_category` rows; admin `app_user`+`app_user_group`; demo referentials) in `packages/db/prisma/seed.ts`.
- [X] T016 [P] `FileStore` abstraction + local-disk implementation writing/streaming `{file_id}{file_extension}` under `ARCHIVES_PATH` in `packages/storage/src/index.ts` (used by api + worker).
- [X] T017 Auth module (NestJS): JWT strategy + guards, bcrypt hashing, login/logout, current-identity resolver (effective `app_user_group`, `is_admin`), `must_change_pwd` handling, in `apps/api/src/modules/auth/` (depends on T012).
- [X] T018 [P] Prisma module + shared DB client provider in `apps/api/src/modules/prisma/` and a worker DB client in `apps/worker/src/db.ts` (depends on T012).
- [X] T019 [P] BullMQ queue setup (connection, `acquisition` queue, job typing) shared by api (producer) and worker (consumer) in `apps/api/src/modules/queue/` + `apps/worker/src/queue.ts`.
- [X] T020 [P] Hierarchy service (materialized `path`/`depth`, subtree `LIKE` query, indented render) in `apps/api/src/common/hierarchy.service.ts`.
- [X] T021 [P] Audit writers (`navigation_audit` + `data_change_audit`) as a NestJS module/interceptor in `apps/api/src/modules/audit/`.
- [X] T022 [P] Global error filter + Pino structured logging in `apps/api/src/common/` (and worker logger in `apps/worker/src/logger.ts`).
- [X] T023 API bootstrap: global zod validation pipe, JWT guard wiring, Swagger/OpenAPI generation aligned to [contracts/openapi.yaml](contracts/openapi.yaml), in `apps/api/src/main.ts` + `apps/api/src/app.module.ts` (depends on T017).

**Checkpoint**: Schema, auth, queue, storage, hierarchy, audit, and QR contract are ready — user stories can begin (in parallel if staffed).

---

## Phase 3: User Story 1 - Acquisition par lot pilotée par QR (Priority: P1) 🎯 MVP

**Goal**: Téléverser un lot de PDF scannés, le découper en documents d'après les QR (4 catégories + blank), OCR, stocker les binaires, rattacher dossier/lot, traitement asynchrone idempotent.

**Independent Test**: Téléverser un PDF fixture contenant des intercalaires (préparés à la main ou via US2) et vérifier le nombre de documents (K/K+1), les attributs de classement, le `dossier` prévalent, l'`ocr_text`, le binaire sur disque, et le `batch_id` partagé.

### Tests for User Story 1 ⚠️

- [X] T024 [P] [US1] Unit tests for `QrPayload` parse/validation (valid, foreign namespace ignored, unknown version rejected, BLANK id=0) in `packages/qr/test/payload.test.ts`.
- [X] T025 [P] [US1] e2e/contract tests for `/api/batches*` against [contracts/openapi.yaml](contracts/openapi.yaml) in `apps/api/test/batches.e2e-spec.ts`.
- [X] T026 [P] [US1] Integration test of the splitting pipeline with reference PDF fixtures (K/K+1, opening categories, DOSSIER prevails, BLANK separator, no-QR attach, unknown extension → single file_type) in `apps/worker/test/splitting.spec.ts`.

### Implementation for User Story 1

- [X] T027 [P] [US1] QR reader (zxing-wasm decode, jsQR fallback) in `packages/qr/src/reader.ts`.
- [X] T028 [P] [US1] PDF rasterizer (pdfjs-dist render page → image; poppler-utils option) in `packages/pdf/src/rasterize.ts`.
- [X] T029 [P] [US1] PDF splitter (pdf-lib: extract page ranges into per-document PDFs) in `packages/pdf/src/split.ts`.
- [X] T030 [P] [US1] OCR adapter (text layer via pdfjs-dist first, then **tesseract.js** primary `fra`/`eng`; optional Tesseract CLI path when configured) in `packages/ocr/src/index.ts`.
- [X] T031 [US1] Acquisition module (NestJS): create batch (`acquisition_batch`, uuid), resolve target dossier or create new with active-label anti-doublon (409), in `apps/api/src/modules/acquisition/acquisition.service.ts` (depends on T012, T020).
- [X] T032 [US1] Upload endpoint (Multer) accepting multi PDF, persisting temp inputs and enqueuing a BullMQ `acquisition` job, in `apps/api/src/modules/acquisition/acquisition.controller.ts` (depends on T019, T031).
- [X] T033 [US1] Worker splitting processor: order files by name, rasterize separation pages, decode QR, open/close documents, apply `document_type_id`/`plan_id`/`location_id`/`dossier_id` (DOSSIER prevails), BLANK separator, no-QR attaches to current (or opens "sans type"), in `apps/worker/src/processors/acquisition.processor.ts` (depends on T011, T027, T028, T029).
- [X] T034 [US1] Worker ingestion: resolve/auto-create `file_type` by extension (unique), write binary via `FileStore`, persist `document_file` with `ocr_text`/`page_count`/`sort_order`, update batch `file_count`/`document_count`/`status`, idempotent reprocess of a `batch_id`, in `apps/worker/src/processors/ingestion.ts` (depends on T016, T030, T033).
- [X] T035 [US1] Auto-grant Consultation `document_permission` to the creating `app_user_group` for each produced document (FR-029) in `apps/worker/src/processors/grant-permission.ts` (depends on T009).
- [X] T036 [US1] Batch status/reprocess endpoints `GET /api/batches/:id`, `POST /api/batches/:id/reprocess` in `apps/api/src/modules/acquisition/acquisition.controller.ts` (depends on T031, T019).
- [X] T037 [US1] P2 page (Next.js + Ant Design): dossier cascade / "Nouveau dossier", multi-file upload with progress, status polling, in `apps/web/app/acquisition/` (depends on T032, T036).
- [X] T038 [US1] Emit `navigation_audit` + `data_change_audit` for acquisition actions via the audit module (depends on T021).

**Checkpoint**: US1 fully functional and independently testable — this is the MVP.

---

## Phase 4: User Story 2 - Génération des feuilles d'intercalaires QR (Priority: P2)

**Goal**: Sélectionner une catégorie + éléments et produire un PDF imprimable, une page A4 par élément, chacune avec libellé de catégorie, QR unique et libellé d'élément.

**Independent Test**: Sélectionner une catégorie (arbre indenté pour plan/localisation), générer, et vérifier une page par élément avec QR relisible conforme au contrat ; sélection vide bloquée ; séparateur vierge produit.

### Tests for User Story 2 ⚠️

- [X] T039 [P] [US2] e2e/contract tests for `/api/intercalaires*` against [contracts/openapi.yaml](contracts/openapi.yaml) in `apps/api/test/intercalaires.e2e-spec.ts`.
- [X] T040 [P] [US2] Test: QR round-trip (generate → decode), one page per selected item, empty selection rejected (400), in `apps/api/test/intercalaire-generation.spec.ts`.

### Implementation for User Story 2

- [X] T041 [P] [US2] QR bitmap generator via `qrcode` (ECC level Q, alphanumeric, quiet zone) in `packages/qr/src/generator.ts`.
- [X] T042 [P] [US2] Intercalaire PDF composer (pdf-lib: A4 page, embed QR PNG, category + item labels) in `packages/pdf/src/intercalaire.ts`.
- [X] T043 [US2] Intercalaires module (NestJS): list categories, load items per category (flat for type/dossier, indented tree for plan/location via hierarchy service, none for BLANK), build the multi-page PDF, in `apps/api/src/modules/intercalaires/intercalaires.service.ts` (depends on T011, T020, T041, T042).
- [X] T044 [US2] Endpoints `GET /api/intercalaires/categories`, `GET /api/intercalaires/items`, `POST /api/intercalaires/generate` (inline PDF; empty selection → 400) in `apps/api/src/modules/intercalaires/intercalaires.controller.ts` (depends on T043).
- [X] T045 [US2] P1 page (Next.js + Ant Design): category selector + item multi-select (indented Tree), Generate disabled on empty selection, in `apps/web/app/intercalaires/` (depends on T044).

**Checkpoint**: US1 and US2 both work independently; US2's sheets now feed US1's splitting end-to-end.

---

## Phase 5: User Story 3 - Recherche multi-critères & export (Priority: P3)

**Goal**: Grille filtrable/triable/regroupable, recherche plein-texte (libellé + cote + OCR), ouverture de document, export Excel/PDF/Word/CSV, habilitation deny-by-default.

**Independent Test**: Avec des données pré-chargées et des droits ciblés, vérifier qu'un consultant ne voit que les documents autorisés, que la recherche OCR remonte le bon document, que l'export reflète le filtre/tri, et que l'admin voit tout.

### Tests for User Story 3 ⚠️

- [X] T046 [P] [US3] e2e/contract tests for `/api/documents*` against [contracts/openapi.yaml](contracts/openapi.yaml) in `apps/api/test/documents.e2e-spec.ts`.
- [X] T047 [P] [US3] Integration test: deny-by-default visibility (consultant sees only granted doc, admin sees all, 403/404 on direct access) + full-text OCR hit, in `apps/api/test/permission-search.spec.ts`.
- [X] T048 [P] [US3] Integration test: export reflects current filter/sort across `xlsx`/`pdf`/`docx`/`csv`, in `apps/api/test/export.spec.ts`.

### Implementation for User Story 3

- [X] T049 [US3] Search query: Prisma `$queryRaw` over `document` + joins, filters (type/dossier/plan/location/date), full-text on `tsvector` (label+cote+`ocr_text`), dynamic sort/group, pagination, **and the deny-by-default ACL predicate** (EXISTS `document_permission` OR `document_type_permission` OR `is_admin`), in `apps/api/src/modules/search/search.service.ts` (depends on T014, T017).
- [X] T050 [P] [US3] Document detail service: resolve current version → files, in `apps/api/src/modules/documents/documents.service.ts`.
- [X] T051 [P] [US3] Export services reflecting current filter/sort: ExcelJS (xlsx), docx (docx), fast-csv (csv), PDFKit (pdf), in `packages/exports/src/` (xlsx.ts, docx.ts, csv.ts, pdf.ts).
- [X] T052 [US3] Endpoints `POST /api/documents/search`, `POST /api/documents/export`, `GET /api/documents/:id`, `GET /api/documents/:id/files/:fileId/content` (ACL guard, 403/404, stream from disk via `FileStore`) in `apps/api/src/modules/documents/documents.controller.ts` (depends on T049, T050, T051, T016).
- [X] T053 [US3] P3 page (Next.js + Ant Design Table, server-side pagination/sort/group): full-text box, label open link, export buttons, in `apps/web/app/search/` (depends on T052).
- [X] T054 [US3] Emit `navigation_audit` on document open (FR-033) via the audit module (depends on T021).

**Checkpoint**: All three user stories independently functional.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Admin tooling, scale tuning, security, docs, end-to-end validation.

- [X] T055 [P] Referential administration (CRUD with anti-doublon + path recompute) for dossiers, document types, plans, locations, file types, and permission grants, in `apps/api/src/modules/referentials/` + `apps/web/app/admin/`.
- [X] T056 [P] Verify covering indexes + GIN/tsvector plans and tune server-side pagination against the observed scale (~42k documents, ~93k files); record findings in [research.md](research.md) notes.
- [X] T057 [P] Security hardening — `must_change_pwd` flow, password policy, review every endpoint's JWT guard + ACL, in `apps/api/src/modules/auth/`.
- [X] T058 [P] Unit tests for the hierarchy service path/depth + subtree queries in `apps/api/test/hierarchy.spec.ts`.
- [X] T059 [P] Documentation (README, ops/deploy notes for `ARCHIVES`, Postgres FTS, Tesseract data, docker-compose) in `README.md` + `docs/`.
- [X] T060 Run the [quickstart.md](quickstart.md) scenarios end-to-end and confirm all Success Criteria (SC-001 → SC-010).
- [X] T061 [P] User & group administration (FR-033): create/edit users, assign them to profils/groups (`app_user_group`), reset password / set `must_change_pwd`, enable/disable, in `apps/api/src/modules/users/` + `apps/web/app/admin/users/`. Complements the data model (T009), identity resolver (T017) and seed (T015).

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: no dependencies — start immediately.
- **Foundational (Phase 2)**: depends on Setup — **blocks all user stories**.
- **User Stories (Phase 3–5)**: each depends only on Foundational; can run in parallel if staffed, or sequentially P1 → P2 → P3.
- **Polish (Phase 6)**: depends on the desired user stories being complete.

### User Story Dependencies

- **US1 (P1, MVP)**: after Foundational. Independently testable via QR PDF fixtures (does not require US2).
- **US2 (P2)**: after Foundational. Independent; functionally complements US1 (its sheets pilot US1's splitting) but is testable on its own.
- **US3 (P3)**: after Foundational. Independent; testable with seeded/acquired data + targeted permissions.

### Within Each User Story

- Tests written first and failing → shared packages (qr/pdf/ocr/exports) → api services → endpoints → web page → audit wiring.

### Parallel Opportunities

- Setup: T003, T004, T005, T006 in parallel.
- Foundational: T007–T011 in parallel (distinct Prisma model files + qr/types), then T012→T013 serialize; T014, T015, T016, T018–T022 in parallel after the schema exists.
- US1: T024, T025, T026 (tests) in parallel; T027, T028, T029, T030 (packages) in parallel.
- US2: T039/T040 in parallel; T041/T042 in parallel.
- US3: T046, T047, T048 in parallel; T050, T051 in parallel.
- Across teams: once Foundational is done, US1 / US2 / US3 can each be owned by a different developer.

---

## Parallel Example: User Story 1

```bash
# Tests for US1 together:
Task: "Unit tests for QrPayload in packages/qr/test/payload.test.ts"
Task: "Contract tests for /api/batches* in apps/api/test/batches.e2e-spec.ts"
Task: "Splitting pipeline integration test in apps/worker/test/splitting.spec.ts"

# Shared packages for US1 together:
Task: "QR reader (zxing-wasm) in packages/qr/src/reader.ts"
Task: "PDF rasterizer (pdfjs-dist) in packages/pdf/src/rasterize.ts"
Task: "PDF splitter (pdf-lib) in packages/pdf/src/split.ts"
Task: "OCR adapter (Tesseract) in packages/ocr/src/index.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 only)

1. Phase 1: Setup.
2. Phase 2: Foundational (CRITICAL — blocks all stories).
3. Phase 3: User Story 1 (Acquisition).
4. **STOP and VALIDATE**: test US1 independently with QR PDF fixtures.
5. Deploy/demo if ready.

### Incremental Delivery

1. Setup + Foundational → foundation ready.
2. US1 (Acquisition) → test → demo (**MVP**).
3. US2 (Intercalaires) → test → demo (closes the print→scan loop).
4. US3 (Recherche & export) → test → demo (retrieval + access control).

### Parallel Team Strategy

After Foundational: Developer A → US1, Developer B → US2, Developer C → US3; integrate independently.

---

## Notes

- `[P]` = different files, no dependency on an incomplete task.
- The 21-table schema is shared by all stories, so it lives in Foundational (not per-story).
- `QrPayload` is the P1↔P2 contract → Foundational; US1 exercises the parse side, US2 the format side.
- Prisma multi-file schema (`prismaSchemaFolder`) lets the 4 model files be edited in parallel; constraints Prisma can't express are added as raw-SQL migrations (T013/T014).
- The worker does the heavy lifting (OCR/QR/PDF) so the API never blocks; idempotent reprocess keeps a re-run from duplicating documents.
- Verify each story's tests fail before implementing; commit after each task or logical group.
