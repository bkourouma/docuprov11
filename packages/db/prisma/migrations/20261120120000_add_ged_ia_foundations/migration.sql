-- GED IA — fondations de données (2026-11-20) : 11 tables, extension pgvector.
-- Modèles : packages/db/prisma/models/ged.prisma. Miroir TS : packages/types/src/ged.ts.
--
-- Migration ADDITIVE : aucune table existante n'est modifiée (les relations ajoutées aux modèles
-- Prisma existants sont de simples champs inverses, sans effet sur le schéma SQL).
-- Écrite en deux temps : `prisma migrate diff` (CREATE TABLE / INDEX / FOREIGN KEY) puis SQL brut
-- (extension, CHECK ck_*, uniques partiels ux_*, index HNSW ix_*) — la partie SQL brut est
-- identique à prisma/sql/ged.sql.
--
-- Prérequis : pgvector disponible sur le serveur (image pgvector/pgvector:pg16 en dev ; en
-- production, installer le paquet pgvector AVANT de déployer cette migration).

-- Extension pgvector (avant la table ged_document_chunk, qui porte une colonne vector(1024)).
CREATE EXTENSION IF NOT EXISTS vector;

-- CreateTable
CREATE TABLE "ged_ai_setting" (
    "ged_ai_setting_id" INTEGER NOT NULL DEFAULT 1,
    "mode" SMALLINT NOT NULL DEFAULT 0,
    "provider" VARCHAR(50),
    "model" VARCHAR(200),
    "embedding_model" VARCHAR(200),
    "embedding_dimension" INTEGER NOT NULL DEFAULT 1024,
    "endpoint" VARCHAR(500),
    "api_key_ref" VARCHAR(200),
    "masking_enabled" BOOLEAN NOT NULL DEFAULT true,
    "auto_apply_threshold" DECIMAL(4,3),
    "timeout_seconds" INTEGER NOT NULL DEFAULT 60,
    "updated_at" TIMESTAMPTZ(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" INTEGER,

    CONSTRAINT "ged_ai_setting_pkey" PRIMARY KEY ("ged_ai_setting_id")
);

-- CreateTable
CREATE TABLE "ged_ai_masking_rule" (
    "ged_ai_masking_rule_id" SERIAL NOT NULL,
    "label" VARCHAR(200) NOT NULL,
    "kind" SMALLINT NOT NULL DEFAULT 0,
    "pattern" TEXT NOT NULL,
    "replacement" VARCHAR(100) NOT NULL DEFAULT '[MASQUÉ]',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ged_ai_masking_rule_pkey" PRIMARY KEY ("ged_ai_masking_rule_id")
);

-- CreateTable
CREATE TABLE "ged_ai_decision" (
    "ged_ai_decision_id" BIGSERIAL NOT NULL,
    "document_id" INTEGER,
    "source_item_id" BIGINT,
    "task" SMALLINT NOT NULL,
    "mode" SMALLINT NOT NULL,
    "provider" VARCHAR(50),
    "model" VARCHAR(200) NOT NULL,
    "prompt_version" VARCHAR(50),
    "input_excerpt" TEXT,
    "input_hash" VARCHAR(64),
    "input_masked" BOOLEAN NOT NULL DEFAULT false,
    "output" JSONB,
    "confidence" DECIMAL(4,3),
    "status" SMALLINT NOT NULL DEFAULT 0,
    "validated_by" INTEGER,
    "validated_at" TIMESTAMPTZ(0),
    "requested_by" INTEGER,
    "prompt_tokens" INTEGER,
    "completion_tokens" INTEGER,
    "duration_ms" INTEGER,
    "error_message" TEXT,
    "created_at" TIMESTAMPTZ(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ged_ai_decision_pkey" PRIMARY KEY ("ged_ai_decision_id")
);

-- CreateTable
CREATE TABLE "ged_source_connector" (
    "ged_source_connector_id" SERIAL NOT NULL,
    "label" VARCHAR(200) NOT NULL,
    "connector_type" VARCHAR(40) NOT NULL,
    "mode" SMALLINT NOT NULL DEFAULT 0,
    "status" SMALLINT NOT NULL DEFAULT 0,
    "config" JSONB,
    "credentials_enc" TEXT,
    "credentials_key_id" VARCHAR(100),
    "credentials_ref" VARCHAR(200),
    "credentials_expires_at" TIMESTAMPTZ(0),
    "change_token" TEXT,
    "sync_interval_minutes" INTEGER,
    "target_dossier_id" INTEGER,
    "last_sync_at" TIMESTAMPTZ(0),
    "last_success_at" TIMESTAMPTZ(0),
    "last_error" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by" INTEGER,
    "created_at" TIMESTAMPTZ(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ged_source_connector_pkey" PRIMARY KEY ("ged_source_connector_id")
);

-- CreateTable
CREATE TABLE "ged_source_sync_run" (
    "ged_source_sync_run_id" BIGSERIAL NOT NULL,
    "connector_id" INTEGER NOT NULL,
    "status" SMALLINT NOT NULL DEFAULT 0,
    "started_at" TIMESTAMPTZ(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(0),
    "items_seen" INTEGER NOT NULL DEFAULT 0,
    "items_created" INTEGER NOT NULL DEFAULT 0,
    "items_updated" INTEGER NOT NULL DEFAULT 0,
    "items_deleted" INTEGER NOT NULL DEFAULT 0,
    "items_duplicate" INTEGER NOT NULL DEFAULT 0,
    "items_failed" INTEGER NOT NULL DEFAULT 0,
    "change_token_before" TEXT,
    "change_token_after" TEXT,
    "error_message" TEXT,

    CONSTRAINT "ged_source_sync_run_pkey" PRIMARY KEY ("ged_source_sync_run_id")
);

-- CreateTable
CREATE TABLE "ged_source_item" (
    "ged_source_item_id" BIGSERIAL NOT NULL,
    "connector_id" INTEGER NOT NULL,
    "external_id" VARCHAR(500) NOT NULL,
    "origin_url" TEXT,
    "origin_path" TEXT,
    "name" VARCHAR(500) NOT NULL,
    "mime_type" VARCHAR(200),
    "byte_length" BIGINT,
    "origin_author" VARCHAR(300),
    "origin_created_at" TIMESTAMPTZ(0),
    "origin_modified_at" TIMESTAMPTZ(0),
    "content_hash" VARCHAR(64),
    "remote_version" VARCHAR(200),
    "origin_acl" JSONB,
    "origin_metadata" JSONB,
    "state" SMALLINT NOT NULL DEFAULT 0,
    "document_id" INTEGER,
    "duplicate_of_id" BIGINT,
    "error_message" TEXT,
    "first_seen_at" TIMESTAMPTZ(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "indexed_at" TIMESTAMPTZ(0),

    CONSTRAINT "ged_source_item_pkey" PRIMARY KEY ("ged_source_item_id")
);

-- CreateTable
CREATE TABLE "ged_document_chunk" (
    "ged_document_chunk_id" BIGSERIAL NOT NULL,
    "document_id" INTEGER,
    "document_version_id" INTEGER,
    "source_item_id" BIGINT,
    "chunk_index" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "content_hash" VARCHAR(64) NOT NULL,
    "token_count" INTEGER,
    "page_from" INTEGER,
    "page_to" INTEGER,
    "embedding" vector(1024) NOT NULL,
    "embedding_model" VARCHAR(200) NOT NULL,
    "created_at" TIMESTAMPTZ(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ged_document_chunk_pkey" PRIMARY KEY ("ged_document_chunk_id")
);

-- CreateTable
CREATE TABLE "ged_space" (
    "ged_space_id" SERIAL NOT NULL,
    "label" VARCHAR(200) NOT NULL,
    "description" TEXT,
    "kind" SMALLINT NOT NULL,
    "owner_user_group_id" INTEGER NOT NULL,
    "publication_slug" VARCHAR(120),
    "published_at" TIMESTAMPTZ(0),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ged_space_pkey" PRIMARY KEY ("ged_space_id")
);

-- CreateTable
CREATE TABLE "ged_space_member" (
    "ged_space_member_id" SERIAL NOT NULL,
    "space_id" INTEGER NOT NULL,
    "user_group_id" INTEGER,
    "role_id" INTEGER,
    "permission" SMALLINT NOT NULL DEFAULT 0,
    "added_by" INTEGER,
    "added_at" TIMESTAMPTZ(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ged_space_member_pkey" PRIMARY KEY ("ged_space_member_id")
);

-- CreateTable
CREATE TABLE "ged_space_document" (
    "space_id" INTEGER NOT NULL,
    "document_id" INTEGER NOT NULL,
    "added_by" INTEGER,
    "added_at" TIMESTAMPTZ(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ged_space_document_pkey" PRIMARY KEY ("space_id","document_id")
);

-- CreateTable
CREATE TABLE "ged_version_info" (
    "ged_version_info_id" SERIAL NOT NULL,
    "document_version_id" INTEGER NOT NULL,
    "space_id" INTEGER,
    "content_hash" VARCHAR(64),
    "change_kind" SMALLINT NOT NULL DEFAULT 0,
    "change_summary" TEXT,
    "source_item_id" BIGINT,
    "ai_decision_id" BIGINT,
    "restored_from_version_id" INTEGER,
    "created_at" TIMESTAMPTZ(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ged_version_info_pkey" PRIMARY KEY ("ged_version_info_id")
);

-- CreateIndex
CREATE INDEX "ged_ai_masking_rule_is_active_sort_order_idx" ON "ged_ai_masking_rule"("is_active", "sort_order");

-- CreateIndex
CREATE INDEX "ged_ai_decision_document_id_created_at_idx" ON "ged_ai_decision"("document_id", "created_at");

-- CreateIndex
CREATE INDEX "ged_ai_decision_source_item_id_idx" ON "ged_ai_decision"("source_item_id");

-- CreateIndex
CREATE INDEX "ged_ai_decision_status_task_idx" ON "ged_ai_decision"("status", "task");

-- CreateIndex
CREATE INDEX "ged_ai_decision_created_at_idx" ON "ged_ai_decision"("created_at");

-- CreateIndex
CREATE INDEX "ged_source_connector_connector_type_idx" ON "ged_source_connector"("connector_type");

-- CreateIndex
CREATE INDEX "ged_source_connector_is_active_status_idx" ON "ged_source_connector"("is_active", "status");

-- CreateIndex
CREATE INDEX "ged_source_sync_run_connector_id_started_at_idx" ON "ged_source_sync_run"("connector_id", "started_at");

-- CreateIndex
CREATE INDEX "ged_source_item_content_hash_idx" ON "ged_source_item"("content_hash");

-- CreateIndex
CREATE INDEX "ged_source_item_document_id_idx" ON "ged_source_item"("document_id");

-- CreateIndex
CREATE INDEX "ged_source_item_duplicate_of_id_idx" ON "ged_source_item"("duplicate_of_id");

-- CreateIndex
CREATE INDEX "ged_source_item_connector_id_state_idx" ON "ged_source_item"("connector_id", "state");

-- CreateIndex
CREATE UNIQUE INDEX "ged_source_item_connector_id_external_id_key" ON "ged_source_item"("connector_id", "external_id");

-- CreateIndex
CREATE INDEX "ged_document_chunk_document_id_idx" ON "ged_document_chunk"("document_id");

-- CreateIndex
CREATE INDEX "ged_document_chunk_document_version_id_idx" ON "ged_document_chunk"("document_version_id");

-- CreateIndex
CREATE INDEX "ged_document_chunk_source_item_id_idx" ON "ged_document_chunk"("source_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "ged_space_publication_slug_key" ON "ged_space"("publication_slug");

-- CreateIndex
CREATE INDEX "ged_space_owner_user_group_id_idx" ON "ged_space"("owner_user_group_id");

-- CreateIndex
CREATE INDEX "ged_space_kind_is_active_idx" ON "ged_space"("kind", "is_active");

-- CreateIndex
CREATE INDEX "ged_space_member_space_id_idx" ON "ged_space_member"("space_id");

-- CreateIndex
CREATE INDEX "ged_space_member_user_group_id_idx" ON "ged_space_member"("user_group_id");

-- CreateIndex
CREATE INDEX "ged_space_member_role_id_idx" ON "ged_space_member"("role_id");

-- CreateIndex
CREATE INDEX "ged_space_document_document_id_idx" ON "ged_space_document"("document_id");

-- CreateIndex
CREATE UNIQUE INDEX "ged_version_info_document_version_id_key" ON "ged_version_info"("document_version_id");

-- CreateIndex
CREATE INDEX "ged_version_info_content_hash_idx" ON "ged_version_info"("content_hash");

-- CreateIndex
CREATE INDEX "ged_version_info_space_id_idx" ON "ged_version_info"("space_id");

-- AddForeignKey
ALTER TABLE "ged_ai_decision" ADD CONSTRAINT "ged_ai_decision_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "document"("document_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ged_ai_decision" ADD CONSTRAINT "ged_ai_decision_source_item_id_fkey" FOREIGN KEY ("source_item_id") REFERENCES "ged_source_item"("ged_source_item_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ged_ai_decision" ADD CONSTRAINT "ged_ai_decision_validated_by_fkey" FOREIGN KEY ("validated_by") REFERENCES "app_user_group"("user_group_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ged_source_connector" ADD CONSTRAINT "ged_source_connector_target_dossier_id_fkey" FOREIGN KEY ("target_dossier_id") REFERENCES "dossier"("dossier_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ged_source_sync_run" ADD CONSTRAINT "ged_source_sync_run_connector_id_fkey" FOREIGN KEY ("connector_id") REFERENCES "ged_source_connector"("ged_source_connector_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ged_source_item" ADD CONSTRAINT "ged_source_item_connector_id_fkey" FOREIGN KEY ("connector_id") REFERENCES "ged_source_connector"("ged_source_connector_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ged_source_item" ADD CONSTRAINT "ged_source_item_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "document"("document_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ged_source_item" ADD CONSTRAINT "ged_source_item_duplicate_of_id_fkey" FOREIGN KEY ("duplicate_of_id") REFERENCES "ged_source_item"("ged_source_item_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ged_document_chunk" ADD CONSTRAINT "ged_document_chunk_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "document"("document_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ged_document_chunk" ADD CONSTRAINT "ged_document_chunk_document_version_id_fkey" FOREIGN KEY ("document_version_id") REFERENCES "document_version"("document_version_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ged_document_chunk" ADD CONSTRAINT "ged_document_chunk_source_item_id_fkey" FOREIGN KEY ("source_item_id") REFERENCES "ged_source_item"("ged_source_item_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ged_space" ADD CONSTRAINT "ged_space_owner_user_group_id_fkey" FOREIGN KEY ("owner_user_group_id") REFERENCES "app_user_group"("user_group_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ged_space_member" ADD CONSTRAINT "ged_space_member_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "ged_space"("ged_space_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ged_space_member" ADD CONSTRAINT "ged_space_member_user_group_id_fkey" FOREIGN KEY ("user_group_id") REFERENCES "app_user_group"("user_group_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ged_space_member" ADD CONSTRAINT "ged_space_member_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "role"("role_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ged_space_document" ADD CONSTRAINT "ged_space_document_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "ged_space"("ged_space_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ged_space_document" ADD CONSTRAINT "ged_space_document_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "document"("document_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ged_version_info" ADD CONSTRAINT "ged_version_info_document_version_id_fkey" FOREIGN KEY ("document_version_id") REFERENCES "document_version"("document_version_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ged_version_info" ADD CONSTRAINT "ged_version_info_restored_from_version_id_fkey" FOREIGN KEY ("restored_from_version_id") REFERENCES "document_version"("document_version_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ged_version_info" ADD CONSTRAINT "ged_version_info_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "ged_space"("ged_space_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ged_version_info" ADD CONSTRAINT "ged_version_info_source_item_id_fkey" FOREIGN KEY ("source_item_id") REFERENCES "ged_source_item"("ged_source_item_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ged_version_info" ADD CONSTRAINT "ged_version_info_ai_decision_id_fkey" FOREIGN KEY ("ai_decision_id") REFERENCES "ged_ai_decision"("ged_ai_decision_id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ============================================================================
-- SQL brut — contraintes et index non exprimables en Prisma (cf. prisma/sql/ged.sql)
-- ============================================================================

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
