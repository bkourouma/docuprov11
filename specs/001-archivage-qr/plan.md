# Implementation Plan: Reprise « Archivage par QR »

**Branch**: `001-archivage-qr` | **Date**: 2026-06-11 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/001-archivage-qr/spec.md`

## Summary

Réimplémenter, dans une application web **JavaScript/TypeScript** neuve et isolée, une **chaîne d'archivage par numérisation de masse pilotée par QR codes** composée de trois écrans :

1. **Génération d'intercalaires QR** (lecture seule) — feuilles séparatrices A4 imprimables, une par élément sélectionné, portant un QR encodant la catégorie + la cible de classement.
2. **Acquisition par lot** — téléversement de PDF scannés, découpage en documents d'après les QR (4 catégories ouvrantes + vierge), OCR, stockage des binaires sur disque, rattachement dossier/lot, traitement **asynchrone idempotent** (worker).
3. **Recherche multi-critères & export** — grille filtrable/triable/regroupable avec recherche plein-texte (libellé + cote + texte OCR), ouverture de document, export Excel/PDF/Word/CSV, et **habilitation « refus par défaut »**.

**Approche technique** : **monorepo TypeScript** (pnpm workspaces + Turborepo) en **Modular Monolith + worker async** : frontend **Next.js + React + Ant Design + Tailwind**, backend **NestJS (REST)**, base **PostgreSQL + Prisma**, file de traitement **Redis + BullMQ**, OCR/QR/PDF dans un **worker Node**. Binaires stockés hors base sous une racine `ARCHIVES` (`{file_id}{extension}`). Horodatages **UTC**. Contrat QR **ASCII délimité versionné**. Déploiement **Docker Compose** (PostgreSQL + Redis + app).

## Technical Context

**Language/Version**: **TypeScript** (Node.js LTS ≥ 20).

**Primary Dependencies**:
- Frontend : **Next.js** + **React** ; **Ant Design** (formulaires, arbres, grilles) + **Tailwind CSS** ; grille P3 = **Ant Design Table**.
- Backend : **NestJS** (REST), validation **zod** (via pipe), guards JWT.
- Données : **PostgreSQL** + **Prisma** (schéma multi-fichiers, migrations, client typé) ; recherche plein-texte **PostgreSQL FTS** (`tsvector` + GIN).
- Async : **Redis** + **BullMQ** (jobs OCR / lecture QR / découpage PDF) ; upload **Multer**.
- QR : **qrcode** (génération P1) ; **zxing-wasm** (décodage P2 ; `jsQR` en repli).
- PDF/Image : **pdf-lib** (composer intercalaires, découper) ; **pdfjs-dist** / **poppler-utils** (rastériser page → image pour décodage QR & extraction texte) ; **PDFKit** (export PDF P3 ; **Puppeteer** en alternative HTML→PDF).
- OCR : **Tesseract.js** (primaire, pur-Node, données `fra`/`eng`) ; **Tesseract CLI** optionnel (perf en volume, activé par configuration).
- Export : **ExcelJS** (.xlsx) ; **docx** (.docx) ; **fast-csv** (.csv) ; **PDFKit** (.pdf).
- Sécurité : **JWT** (`jsonwebtoken`) + **bcrypt** + guards NestJS.
- Observabilité : **Pino** (logs structurés).

**Storage**: **PostgreSQL** (cible) ; binaires sur système de fichiers sous racine `ARCHIVES`. Le modèle reste transposable (les hiérarchies par chemin matérialisé peuvent évoluer vers `ltree`).

**Testing**: **Jest** (unitaire NestJS/packages) + **Supertest** (e2e/contrat API) ; tests d'intégration du pipeline P2 (PDF fixtures → documents) côté worker ; jeux de **PDF d'intercalaires de référence** comme fixtures.

**Target Platform**: Application web ; conteneurs Docker (Node app + PostgreSQL + Redis) ; navigateurs modernes.

**Project Type**: Web application (monorepo : `apps/web` Next.js, `apps/api` NestJS, `apps/worker` BullMQ, `packages/*` partagés).

**Performance Goals**: P3 — grille et recherche plein-texte perçues rapides à l'échelle observée (≈ 42 000 documents, ≈ 93 400 fichiers) via index couvrants + `tsvector`/GIN + pagination serveur. P2 — OCR/lecture QR exécutés en **job BullMQ** avec progression ; un lot rejouable sans doublon (idempotence).

**Constraints**: habilitation **deny-by-default** (FR-026→029) ; toutes les FK contraintes ; unicité métier (libellé dossier/type actif → index unique partiel, extension de type de fichier) ; binaires hors base ; horodatages **UTC** stockés, affichage local ; contrat QR **ASCII** versionné ; secrets d'authentification **hachés bcrypt** (jamais en clair).

**Scale/Scope**: ~42 000 documents, ~42 000 versions, ~93 400 fichiers, ~10 400 lots, ~285 000 lignes de journal ; 21 tables (4 cœur, 8 référentiels, 6 sécurité, 3 audit) ; 3 écrans + administration des référentiels.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

Le fichier `.specify/memory/constitution.md` est un **gabarit non ratifié** (placeholders) : **aucun principe constitutionnel contraignant** n'est défini. Les portes appliquées sont les **bonnes pratiques par défaut** dérivées des exigences non-fonctionnelles de la spec :

| Porte | Exigence | État |
|---|---|---|
| **Intégrité des données** | Toutes les FK contraintes ; unicité métier ; CHECK de domaine (statut lot). | ✅ Modèle Prisma + SQL brut (index uniques partiels, CHECK) — D3, FR-030/032. |
| **Sécurité d'accès** | Habilitation deny-by-default appliquée à P3 ; secrets hachés bcrypt. | ✅ FR-026→029, FR-034. |
| **Simplicité** | Modular Monolith (pas de microservices) ; hiérarchies par chemin matérialisé. | ✅ D2 ; pas de violation à justifier. |
| **Testabilité** | Chaque user story indépendamment testable ; pipeline d'ingestion déterministe et rejouable. | ✅ Stories P1/P2/P3 isolées ; FR-020 idempotence. |
| **Portabilité / OSS** | Pile 100 % open source (Node/Postgres/Redis). | ✅ D14. |

**Résultat (pré-Phase 0)** : ✅ Aucune violation. `Complexity Tracking` non requis.

**Re-check post-Phase 1 (design)** : ✅ Inchangé. Le monorepo en couches (packages partagés + worker isolé), le modèle 21 tables à FK contraintes, l'habilitation deny-by-default et l'idempotence par lot **renforcent** les portes par défaut sans en violer aucune.

## Project Structure

### Documentation (this feature)

```text
specs/001-archivage-qr/
├── plan.md              # Ce fichier (/speckit-plan)
├── research.md          # Phase 0 — décisions techniques (stack JS/TS) résolues
├── data-model.md        # Phase 1 — 21 entités (Prisma/PostgreSQL), relations, règles, états
├── quickstart.md        # Phase 1 — scénarios de validation bout-en-bout
├── contracts/           # Phase 1 — contrats d'interface
│   ├── openapi.yaml      #   endpoints REST P1/P2/P3 + admin référentiels (auth JWT)
│   └── qr-payload.md     #   contrat de charge utile du QR (P1 ↔ P2) — agnostique techno
├── checklists/
│   └── requirements.md   # Checklist qualité de la spec (déjà créée)
└── tasks.md             # Phase 2 (/speckit-tasks)
```

### Source Code (repository root) — Monorepo TypeScript

```text
archivage-qr/
├── apps/
│   ├── web/                     # Next.js + React + Ant Design + Tailwind (P1, P2, P3, admin)
│   │   └── app/                 #   routes : /intercalaires, /acquisition, /search, /admin
│   ├── api/                     # NestJS (REST) — modules métier + guards JWT
│   │   └── src/modules/         #   auth, users, permissions, referentials, intercalaires,
│   │                            #   acquisition, documents, search, exports, audit
│   └── worker/                  # Worker Node + BullMQ (OCR / QR / découpage PDF)
│       └── src/processors/      #   acquisition.processor, ingestion
│
├── packages/
│   ├── db/                      # Prisma (schéma multi-fichiers, migrations, seed, client)
│   │   └── prisma/
│   │       ├── models/          #   core.prisma, referentials.prisma, security.prisma, audit.prisma
│   │       ├── migrations/      #   + SQL brut : uniques partiels, CHECK, tsvector/GIN, colonne générée
│   │       └── seed.ts
│   ├── qr/                      # génération (qrcode) + parsing/validation du contrat QR
│   ├── pdf/                     # compose (pdf-lib), rastérise (pdfjs-dist/poppler), découpe
│   ├── ocr/                     # abstraction OCR (Tesseract CLI / .js)
│   ├── exports/                 # ExcelJS, docx, fast-csv, PDFKit
│   ├── storage/                 # FileStore disque ({file_id}{extension} sous ARCHIVES)
│   ├── types/                   # types partagés (DTOs, contrat QR, énumérations)
│   ├── ui/                      # composants UI partagés (web)
│   └── config/                  # eslint, prettier, tsconfig de base
│
├── storage/archives/           # binaires stockés sur disque (hors base)
├── docker-compose.yml          # postgres + redis + app
├── turbo.json / pnpm-workspace.yaml
└── README.md

tests : co-localisés (`apps/*/test`, `packages/*/test`) — Jest + Supertest.
```

**Structure Decision** : **monorepo Modular Monolith + worker async**. Le backend NestJS (`apps/api`) expose la REST API et orchestre les cas d'usage via des modules ; le **worker** (`apps/worker`) traite l'ingestion P2 hors cycle requête (BullMQ/Redis) pour ne pas bloquer l'API sur l'OCR/QR/PDF. Les **packages partagés** isolent les choix de librairie (`qr`, `pdf`, `ocr`, `exports`, `storage`) derrière des abstractions, ce qui facilite leur substitution (ex. zxing-wasm ↔ jsQR, Tesseract CLI ↔ .js) et permet à l'API **et** au worker de les réutiliser. **Prisma** (`packages/db`) porte le schéma des 21 tables ; les contraintes non couvertes nativement par Prisma (index uniques partiels « actifs », CHECK, colonnes générées, `tsvector`/GIN full-text) sont ajoutées en **SQL brut** dans les migrations. Cette séparation permet d'implémenter et tester chaque user story indépendamment (P1 = `web` + `qr` + `pdf` ; P2 = `worker` + `acquisition` ; P3 = `search` + `exports`).

## Complexity Tracking

> Aucune violation de la Constitution Check — section non requise.
