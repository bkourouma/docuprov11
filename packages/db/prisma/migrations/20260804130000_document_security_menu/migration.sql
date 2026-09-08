-- Menu « Sécurité Documentaire » (réactivation du menu legacy DocumentSecurity).
-- Modèle : packages/db/prisma/models/security.prisma
--   (`DocumentAccessInquiry`, `DocumentTypePermission.startDate/endDate`)
--
-- ===========================================================================
-- 1. Demandes d'accès document (legacy `DocumentAccessInquiry`)
-- ===========================================================================
--
-- `status` remplace le simple booléen `Treated` du legacy : celui-ci ne conservait pas la
-- distinction accepté/refusé une fois la demande traitée, seulement "traitée ou pas". On la porte
-- ici pour que l'historique des demandes reste lisible après coup (reporting, audit).
--
-- `decided_by` n'a délibérément PAS de FK, même convention que `document_permission.granted_by` :
-- l'acteur ayant décidé n'a pas besoin d'intégrité référentielle stricte ici.

CREATE TABLE "document_access_inquiry" (
  "document_access_inquiry_id" SERIAL PRIMARY KEY,
  "document_id" INTEGER NOT NULL,
  "user_group_id" INTEGER NOT NULL,
  "permission_level_id" INTEGER NOT NULL,
  "motive" TEXT NOT NULL,
  "start_date" TIMESTAMPTZ(0),
  "end_date" TIMESTAMPTZ(0),
  "status" SMALLINT NOT NULL DEFAULT 0,
  "decided_by" INTEGER,
  "decided_at" TIMESTAMPTZ(0),
  "created_at" TIMESTAMPTZ(0) NOT NULL DEFAULT now()
);

ALTER TABLE "document_access_inquiry"
  ADD CONSTRAINT "document_access_inquiry_document_id_fkey"
  FOREIGN KEY ("document_id") REFERENCES "document"("document_id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "document_access_inquiry"
  ADD CONSTRAINT "document_access_inquiry_user_group_id_fkey"
  FOREIGN KEY ("user_group_id") REFERENCES "app_user_group"("user_group_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "document_access_inquiry"
  ADD CONSTRAINT "document_access_inquiry_permission_level_id_fkey"
  FOREIGN KEY ("permission_level_id") REFERENCES "permission_level"("permission_level_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "document_access_inquiry"
  ADD CONSTRAINT "ck_document_access_inquiry_status" CHECK ("status" IN (0, 1, 2));

CREATE INDEX "document_access_inquiry_document_id_idx" ON "document_access_inquiry"("document_id");
CREATE INDEX "document_access_inquiry_status_idx" ON "document_access_inquiry"("status");

-- ===========================================================================
-- 2. Période de validité des droits par TYPE de document (legacy `DateDebut`/`DateFin`)
-- ===========================================================================
--
-- Nullable : `null` = sans limite. Purement déclaratif comme le reste de l'ACL (override D-17,
-- cf. document-tabs.service.ts) — rien ne filtre encore sur ces dates.

ALTER TABLE "document_type_permission" ADD COLUMN "start_date" TIMESTAMPTZ(0);
ALTER TABLE "document_type_permission" ADD COLUMN "end_date" TIMESTAMPTZ(0);
