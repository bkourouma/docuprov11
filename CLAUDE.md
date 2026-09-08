<!-- SPECKIT START -->
## Active feature: Reprise « Archivage par QR » (`001-archivage-qr`)

For technologies, project structure, shell commands, and other context, read the
implementation plan and its design artifacts:

- Plan: `specs/001-archivage-qr/plan.md`
- Spec: `specs/001-archivage-qr/spec.md`
- Research (tech decisions): `specs/001-archivage-qr/research.md`
- Data model (21 tables): `specs/001-archivage-qr/data-model.md`
- Contracts: `specs/001-archivage-qr/contracts/` (`openapi.yaml`, `qr-payload.md`)
- Quickstart (validation): `specs/001-archivage-qr/quickstart.md`

Stack: TypeScript monorepo (pnpm + Turborepo). Frontend Next.js + React + Ant Design +
Tailwind. Backend NestJS (REST). PostgreSQL + Prisma (multi-file schema + raw-SQL for
partial uniques / CHECK / tsvector-GIN full-text). Async via Redis + BullMQ worker for
batch ingestion. 100% OSS libs: qrcode, zxing-wasm, pdf-lib, pdfjs-dist, Tesseract
(CLI/.js), ExcelJS, docx, fast-csv, PDFKit. Auth JWT + bcrypt. Logs Pino. Docker Compose.
Binaries on disk under ARCHIVES; timestamps UTC; QR contract ASCII delimited+versioned;
P3 access deny-by-default. (Replaces the original .NET proposal from PRD §13.)
<!-- SPECKIT END -->
