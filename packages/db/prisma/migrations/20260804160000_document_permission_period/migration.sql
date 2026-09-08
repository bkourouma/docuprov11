-- Période de validité des droits explicites sur UN document (`document_permission`), même geste
-- que 20260804130000_document_security_menu pour `document_type_permission.start_date/end_date`.
-- Modèle : packages/db/prisma/models/security.prisma (`DocumentPermission.startDate/endDate`).
--
-- Nullable : `null` = sans limite. Purement déclaratif comme le reste de l'ACL (override D-17,
-- cf. document-tabs.service.ts) — rien ne filtre encore sur ces dates.

ALTER TABLE "document_permission" ADD COLUMN "start_date" TIMESTAMPTZ(0);
ALTER TABLE "document_permission" ADD COLUMN "end_date" TIMESTAMPTZ(0);
