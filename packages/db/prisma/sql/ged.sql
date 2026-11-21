-- ============================================================================
-- GED IA — objets SQL bruts (non exprimables en Prisma) : extension pgvector, CHECK, uniques
-- partiels, index HNSW. Modèles : packages/db/prisma/models/ged.prisma.
--
-- Ce fichier est COPIÉ à l'identique dans la migration 20261120120000_add_ged_ia_foundations
-- (section « SQL brut ») : il sert de référence et se ré-exécute sans effet de bord si une base
-- créée par `prisma db push` a besoin de ces objets :
--   prisma db execute --file prisma/sql/ged.sql --schema prisma
-- Convention de nommage du repo : uniques partiels ux_*, CHECK ck_*, index ix_*.
--
-- Prérequis : l'extension `vector` (pgvector >= 0.5 pour HNSW) doit être DISPONIBLE sur le serveur
-- (image pgvector/pgvector:pg16 en dev). Le CREATE EXTENSION exige le droit CREATE sur la base
-- (pgvector est une extension « trusted » à partir de PostgreSQL 13 si son .control le déclare ;
-- sinon, un superutilisateur doit l'installer une fois).
-- ============================================================================

-- 0) Extension pgvector.
CREATE EXTENSION IF NOT EXISTS vector;

-- 1) ged_ai_setting : ligne unique, états, masquage obligatoire en cloud.
DO $$ BEGIN
  ALTER TABLE "ged_ai_setting" ADD CONSTRAINT "ck_ged_ai_setting_singleton" CHECK ("ged_ai_setting_id" = 1);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "ged_ai_setting" ADD CONSTRAINT "ck_ged_ai_setting_mode" CHECK ("mode" IN (0, 1, 2));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  -- Cloud => masquage obligatoire : aucune donnée ne part en clair vers un fournisseur externe.
  ALTER TABLE "ged_ai_setting" ADD CONSTRAINT "ck_ged_ai_setting_cloud_masking" CHECK ("mode" <> 2 OR "masking_enabled");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "ged_ai_setting" ADD CONSTRAINT "ck_ged_ai_setting_threshold"
    CHECK ("auto_apply_threshold" IS NULL OR "auto_apply_threshold" BETWEEN 0 AND 1);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "ged_ai_setting" ADD CONSTRAINT "ck_ged_ai_setting_dimension" CHECK ("embedding_dimension" > 0 AND "timeout_seconds" > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Ligne par défaut : IA DÉSACTIVÉE (aucun appel, aucune donnée sortante tant que le client n'a pas choisi).
INSERT INTO "ged_ai_setting" ("ged_ai_setting_id", "mode") VALUES (1, 0) ON CONFLICT DO NOTHING;

-- 2) ged_ai_masking_rule.
DO $$ BEGIN
  ALTER TABLE "ged_ai_masking_rule" ADD CONSTRAINT "ck_ged_ai_masking_rule_kind" CHECK ("kind" IN (0, 1, 2));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 3) ged_ai_decision : tâche, mode figé, statut, score, cohérence de la validation, empreinte.
DO $$ BEGIN
  ALTER TABLE "ged_ai_decision" ADD CONSTRAINT "ck_ged_ai_decision_task" CHECK ("task" BETWEEN 0 AND 7);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  -- Une décision n'existe que si l'IA a tourné : mode 1 (locale) ou 2 (cloud), jamais 0.
  ALTER TABLE "ged_ai_decision" ADD CONSTRAINT "ck_ged_ai_decision_mode" CHECK ("mode" IN (1, 2));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "ged_ai_decision" ADD CONSTRAINT "ck_ged_ai_decision_status" CHECK ("status" BETWEEN 0 AND 4);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "ged_ai_decision" ADD CONSTRAINT "ck_ged_ai_decision_confidence"
    CHECK ("confidence" IS NULL OR "confidence" BETWEEN 0 AND 1);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  -- Un validateur suppose une date de validation. Pas l'inverse : la FK validated_by est ON DELETE SET NULL,
  -- la suppression du compte validateur doit pouvoir mettre validated_by à NULL en gardant la date.
  ALTER TABLE "ged_ai_decision" ADD CONSTRAINT "ck_ged_ai_decision_validation"
    CHECK ("validated_by" IS NULL OR "validated_at" IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "ged_ai_decision" ADD CONSTRAINT "ck_ged_ai_decision_input_hash"
    CHECK ("input_hash" IS NULL OR "input_hash" ~ '^[0-9a-f]{64}$');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 4) ged_source_connector / ged_source_sync_run.
DO $$ BEGIN
  ALTER TABLE "ged_source_connector" ADD CONSTRAINT "ck_ged_source_connector_type"
    CHECK ("connector_type" ~ '^[a-z0-9_]+$');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "ged_source_connector" ADD CONSTRAINT "ck_ged_source_connector_mode" CHECK ("mode" IN (0, 1, 2));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "ged_source_connector" ADD CONSTRAINT "ck_ged_source_connector_status" CHECK ("status" BETWEEN 0 AND 3);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "ged_source_connector" ADD CONSTRAINT "ck_ged_source_connector_interval"
    CHECK ("sync_interval_minutes" IS NULL OR "sync_interval_minutes" > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  -- Chiffré par l'application OU référence de coffre : jamais les deux à la fois.
  ALTER TABLE "ged_source_connector" ADD CONSTRAINT "ck_ged_source_connector_credentials"
    CHECK ("credentials_enc" IS NULL OR "credentials_ref" IS NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "ged_source_sync_run" ADD CONSTRAINT "ck_ged_source_sync_run_status" CHECK ("status" BETWEEN 0 AND 3);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 5) ged_source_item : état, empreinte SHA-256 (hex minuscule), pas de doublon de soi-même.
DO $$ BEGIN
  ALTER TABLE "ged_source_item" ADD CONSTRAINT "ck_ged_source_item_state" CHECK ("state" BETWEEN 0 AND 6);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "ged_source_item" ADD CONSTRAINT "ck_ged_source_item_hash"
    CHECK ("content_hash" IS NULL OR "content_hash" ~ '^[0-9a-f]{64}$');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "ged_source_item" ADD CONSTRAINT "ck_ged_source_item_not_own_duplicate"
    CHECK ("duplicate_of_id" IS NULL OR "duplicate_of_id" <> "ged_source_item_id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 6) ged_document_chunk : rattachement obligatoire, unicité par (propriétaire, rang, modèle), HNSW.
DO $$ BEGIN
  ALTER TABLE "ged_document_chunk" ADD CONSTRAINT "ck_ged_document_chunk_owner"
    CHECK ("document_id" IS NOT NULL OR "source_item_id" IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "ged_document_chunk" ADD CONSTRAINT "ck_ged_document_chunk_values"
    CHECK ("chunk_index" >= 0
       AND ("token_count" IS NULL OR "token_count" >= 0)
       AND ("page_from" IS NULL OR "page_to" IS NULL OR "page_to" >= "page_from")
       AND "content_hash" ~ '^[0-9a-f]{64}$');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE UNIQUE INDEX IF NOT EXISTS "ux_ged_chunk_document"
  ON "ged_document_chunk" ("document_id", "chunk_index", "embedding_model")
  WHERE "document_id" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "ux_ged_chunk_source_item"
  ON "ged_document_chunk" ("source_item_id", "chunk_index", "embedding_model")
  WHERE "source_item_id" IS NOT NULL;
-- Recherche sémantique : HNSW en distance cosinus (opérateur <=>). Les droits sont appliqués par
-- jointure sur `document` ; avec pgvector >= 0.8, activer `SET hnsw.iterative_scan = relaxed_order`
-- pour que le filtre n'appauvrisse pas les résultats.
CREATE INDEX IF NOT EXISTS "ix_ged_chunk_embedding_hnsw"
  ON "ged_document_chunk" USING hnsw ("embedding" vector_cosine_ops) WITH (m = 16, ef_construction = 64);

-- 7) ged_space / ged_space_member : genre, publication, bénéficiaire exclusif, unicité par membre.
DO $$ BEGIN
  ALTER TABLE "ged_space" ADD CONSTRAINT "ck_ged_space_kind" CHECK ("kind" BETWEEN 0 AND 3);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  -- Seule une publication porte un identifiant public.
  ALTER TABLE "ged_space" ADD CONSTRAINT "ck_ged_space_publication"
    CHECK ("publication_slug" IS NULL OR ("kind" = 3 AND "publication_slug" ~ '^[a-z0-9][a-z0-9-]*$'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "ged_space_member" ADD CONSTRAINT "ck_ged_space_member_grantee"
    CHECK (("user_group_id" IS NULL) <> ("role_id" IS NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "ged_space_member" ADD CONSTRAINT "ck_ged_space_member_permission" CHECK ("permission" BETWEEN 0 AND 2);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE UNIQUE INDEX IF NOT EXISTS "ux_ged_space_member_user"
  ON "ged_space_member" ("space_id", "user_group_id") WHERE "user_group_id" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "ux_ged_space_member_role"
  ON "ged_space_member" ("space_id", "role_id") WHERE "role_id" IS NOT NULL;

-- 8) ged_version_info.
DO $$ BEGIN
  ALTER TABLE "ged_version_info" ADD CONSTRAINT "ck_ged_version_info_change_kind" CHECK ("change_kind" BETWEEN 0 AND 4);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "ged_version_info" ADD CONSTRAINT "ck_ged_version_info_hash"
    CHECK ("content_hash" IS NULL OR "content_hash" ~ '^[0-9a-f]{64}$');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  -- Une restauration désigne la version restaurée ; l'inverse n'a pas de sens.
  ALTER TABLE "ged_version_info" ADD CONSTRAINT "ck_ged_version_info_restore"
    CHECK ("restored_from_version_id" IS NULL OR "change_kind" = 3);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
