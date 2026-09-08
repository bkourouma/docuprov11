# Operations & deployment notes — Archivage par QR

## Toolchain

- **Node.js ≥ 20**, **pnpm** (`npm i -g pnpm` or corepack), **Docker** + Docker Compose.
- Monorepo: pnpm workspaces + Turborepo. `pnpm build` builds packages then apps (Turbo `^build`).

## Local infrastructure

```bash
docker compose up -d postgres redis
```

- **PostgreSQL** is published on host port **5432** (`docker-compose.yml`), database `DocuPro`.
  All `DATABASE_URL`s use `localhost:5432`. If a local PostgreSQL install already owns 5432,
  stop it before starting the container (or run only one of the two).
- **Redis** on 6379 (BullMQ).
- Binaries are stored on disk under `ARCHIVES_PATH` (default `./storage/archives`), named
  `{file_id}{extension}` — **never in the database**.

## Environment (`.env`)

Copy `.env.example` → `.env`. Keys: `DATABASE_URL`, `REDIS_URL`, `ARCHIVES_PATH`, `JWT_SECRET`
(≥ 16 chars), `JWT_EXPIRES_IN`, `PORT`, `TESSERACT_LANG` (`fra+eng`), `TESSERACT_DATA_PATH` (optional).
The API loads `.env` from its own dir then the repo root; Prisma CLI reads `packages/db/.env`.

## Database (Prisma)

```bash
pnpm --filter @archivage/db prisma migrate deploy   # apply migrations (21 tables + raw-SQL constraints)
pnpm --filter @archivage/db prisma generate          # regenerate the typed client
pnpm --filter @archivage/db run db:seed              # admin/admin1234, permission levels, QR categories, demo refs
```

Constraints **not** expressible in Prisma live in the migration's raw SQL: partial unique indexes
(active dossier/type label, single current version), CHECKs (batch status, exclusive ACL grantee),
and the **GIN expression index** powering full-text search:
`to_tsvector('french', coalesce(ocr_text,''))` on `document_file`.

## Full-text search

PostgreSQL FTS. The search service queries via `websearch_to_tsquery('french', …)` against the GIN
expression index (`ix_document_file_ocr_tsv`), plus `ILIKE` on label/cote. Verified with `EXPLAIN`
(see research.md → "Notes de performance").

## OCR (Tesseract)

Default engine is **tesseract.js** (pure-Node, bundled language data — no system dependency). For
higher throughput a **Tesseract CLI** path can be enabled via `TESSERACT_DATA_PATH` + a system binary.

## Running

```bash
pnpm dev                                   # web (Next.js) + api (NestJS) + worker (BullMQ)
# or individually:
pnpm --filter @archivage/api dev           # http://localhost:3001/api
pnpm --filter @archivage/web dev           # http://localhost:5000
pnpm --filter @archivage/worker dev        # consumes the 'acquisition' queue
```

## Tests

```bash
pnpm --filter @archivage/qr test           # QR contract + generate/decode round-trip (needs --experimental-vm-modules; set in the script)
pnpm --filter @archivage/pdf test          # split + intercalaire composition
pnpm --filter @archivage/exports test      # xlsx/csv/docx/pdf
pnpm --filter @archivage/worker exec jest  # segmentation engine
pnpm --filter @archivage/api test          # unit (hierarchy)
# e2e (needs the dev stack up + seed):
$env:NODE_ENV='test'; pnpm --filter @archivage/api exec jest --config ./test/jest-e2e.json --forceExit
```

## Security review (T057)

- **Deny-by-default at transport**: a global `JwtAuthGuard` requires a valid JWT on every route except
  those marked `@Public()` (login only).
- **Admin endpoints** (`/referentials/*`, `/users/*`) are additionally behind `AdminGuard`.
- **P3 search/detail/file content** apply the deny-by-default **document ACL** (per-document or
  per-type grant, or admin) — non-authorized documents are invisible and return 404 on direct access.
- **Passwords**: bcrypt (cost 12); never stored in clear; `must_change_pwd` set on seed/reset; policy
  ≥ 8 chars enforced on create/change; `POST /auth/change-password` verifies the current password.
- **Timestamps** are UTC; the QR contract is ASCII + versioned + namespaced (foreign QRs ignored).
