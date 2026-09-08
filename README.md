# Archivage par QR

Reprise de trois fonctionnalités d'une GED/SAE legacy en une application neuve :

- **P1** — génération de feuilles d'intercalaires à QR codes ;
- **P2** — acquisition par lot (découpage par QR, OCR, stockage) ;
- **P3** — recherche multi-critères et export (Excel / PDF / Word / CSV).

Spécification & conception : [`specs/001-archivage-qr/`](specs/001-archivage-qr/).

## Stack

TypeScript monorepo (pnpm + Turborepo) — **Next.js + Ant Design** (web), **NestJS** REST (api),
**BullMQ/Redis** (worker), **PostgreSQL + Prisma**. QR/PDF/OCR/exports en packages partagés.

```text
apps/      web (Next.js) · api (NestJS) · worker (BullMQ)
packages/  db · qr · pdf · ocr · exports · storage · types · ui · config
storage/   archives/  (binaires hors base)
```

## Démarrage (dev)

```bash
npm i -g pnpm                    # ou: corepack enable
pnpm install
cp .env.example .env             # PostgreSQL est publié sur localhost:5432 (base DocuPro)
docker compose up -d postgres redis
pnpm --filter @archivage/db prisma migrate deploy
pnpm --filter @archivage/db run db:seed         # admin / admin1234
pnpm dev                         # web (:5000) + api (:3001/api) + worker
```

Écrans : `/intercalaires` (P1), `/acquisition` (P2), `/search` (P3), `/admin` (référentiels & utilisateurs).

Détails d'exploitation (ports, FTS, OCR, sécurité, tests) : [`docs/operations.md`](docs/operations.md).
Spécification & conception : [`specs/001-archivage-qr/`](specs/001-archivage-qr/).
