-- ============================================================================
-- Couche analytique — objets SQL bruts ADDITIFS (lecture seule).
-- Idempotent : ré-exécutable sans effet de bord. Aucune table métier modifiée.
-- Appliquer après `prisma db push` :
--   prisma db execute --file prisma/sql/analytics.sql --schema prisma
-- Convention de nommage du repo : index uniques partiels ux_*, CHECK ck_*, index ix_*.
-- ============================================================================

-- 1) Index additifs sur tables existantes (perf des dashboards à l'échelle).
--    document.created_at = ligne de temps « débit » (≠ document_date déjà indexé).
CREATE INDEX IF NOT EXISTS "ix_document_created_at" ON "document" ("created_at");
--    document.created_by = productivité par acteur.
CREATE INDEX IF NOT EXISTS "ix_document_created_by" ON "document" ("created_by");
--    Anomalies de complétude : index partiels (ne portent que sur les lignes en défaut).
CREATE INDEX IF NOT EXISTS "ix_document_missing_type" ON "document" ("document_id") WHERE "document_type_id" IS NULL;
CREATE INDEX IF NOT EXISTS "ix_document_missing_dossier" ON "document" ("document_id") WHERE "dossier_id" IS NULL;
CREATE INDEX IF NOT EXISTS "ix_document_missing_date" ON "document" ("document_id") WHERE "document_date" IS NULL;

-- 2) CHECK d'intégrité sur la table de cibles (pattern ck_* du repo).
DO $$ BEGIN
  ALTER TABLE "analytics_target" ADD CONSTRAINT "ck_target_scope" CHECK ("scope" IN ('global','programme','type'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "analytics_target" ADD CONSTRAINT "ck_target_metric" CHECK ("metric" IN ('documents','pages'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "analytics_target" ADD CONSTRAINT "ck_target_period_kind" CHECK ("period_kind" IN ('month','quarter','year'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "analytics_target" ADD CONSTRAINT "ck_target_value_positive" CHECK ("target_value" >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 3) Unicité du périmètre GLOBAL (scope_ref_id NULL non couvert par l'unique composite).
CREATE UNIQUE INDEX IF NOT EXISTS "ux_target_global_period"
  ON "analytics_target" ("period_kind", "period_start", "metric")
  WHERE "scope" = 'global';

-- 4) Cible globale par défaut (mois courant) — uniquement si la table est vide.
INSERT INTO "analytics_target" ("scope","scope_ref_id","period_kind","period_start","metric","target_value","note")
SELECT 'global', NULL, 'month', date_trunc('month', now())::date, 'documents', 500,
       'Cible mensuelle par défaut (modifiable dans Admin › Objectifs)'
WHERE NOT EXISTS (SELECT 1 FROM "analytics_target");
