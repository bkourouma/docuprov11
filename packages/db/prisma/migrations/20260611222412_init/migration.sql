-- CreateTable
CREATE TABLE "audit_action" (
    "audit_action_id" SERIAL NOT NULL,
    "description" VARCHAR(500) NOT NULL,

    CONSTRAINT "audit_action_pkey" PRIMARY KEY ("audit_action_id")
);

-- CreateTable
CREATE TABLE "navigation_audit" (
    "audit_id" BIGSERIAL NOT NULL,
    "user_group_id" INTEGER,
    "activity" TEXT,
    "url" VARCHAR(2000),
    "menu_id" INTEGER,
    "activity_at" TIMESTAMPTZ(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor_full_name" VARCHAR(200),
    "actor_role" VARCHAR(200),
    "actor_service" VARCHAR(400),
    "ip_address" VARCHAR(64),
    "machine_name" VARCHAR(128),

    CONSTRAINT "navigation_audit_pkey" PRIMARY KEY ("audit_id")
);

-- CreateTable
CREATE TABLE "data_change_audit" (
    "data_change_audit_id" BIGSERIAL NOT NULL,
    "user_group_id" INTEGER,
    "audit_action_id" INTEGER,
    "changed_at" TIMESTAMPTZ(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "object_ref" VARCHAR(256),
    "old_value" TEXT,
    "new_value" TEXT,

    CONSTRAINT "data_change_audit_pkey" PRIMARY KEY ("data_change_audit_id")
);

-- CreateTable
CREATE TABLE "acquisition_batch" (
    "batch_id" SERIAL NOT NULL,
    "batch_guid" UUID NOT NULL DEFAULT gen_random_uuid(),
    "dossier_id" INTEGER,
    "scanned_by" INTEGER,
    "scan_date" TIMESTAMPTZ(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source_label" VARCHAR(255),
    "file_count" INTEGER NOT NULL DEFAULT 0,
    "document_count" INTEGER NOT NULL DEFAULT 0,
    "status" SMALLINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "acquisition_batch_pkey" PRIMARY KEY ("batch_id")
);

-- CreateTable
CREATE TABLE "document" (
    "document_id" SERIAL NOT NULL,
    "label" VARCHAR(500) NOT NULL,
    "document_type_id" INTEGER,
    "plan_id" INTEGER,
    "location_id" INTEGER,
    "dossier_id" INTEGER,
    "batch_id" INTEGER,
    "cote" VARCHAR(50),
    "document_date" DATE,
    "archive_year" INTEGER,
    "is_archived" BOOLEAN NOT NULL DEFAULT false,
    "is_frozen" BOOLEAN NOT NULL DEFAULT false,
    "overview" TEXT,
    "validated_by" INTEGER,
    "validated_at" TIMESTAMPTZ(0),
    "workflow_instance_id" INTEGER,
    "workflow_task_id" INTEGER,
    "created_by" INTEGER,
    "created_at" TIMESTAMPTZ(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "modified_by" INTEGER,
    "modified_at" TIMESTAMPTZ(0),

    CONSTRAINT "document_pkey" PRIMARY KEY ("document_id")
);

-- CreateTable
CREATE TABLE "document_version" (
    "document_version_id" SERIAL NOT NULL,
    "document_id" INTEGER NOT NULL,
    "version_number" INTEGER NOT NULL DEFAULT 1,
    "is_current" BOOLEAN NOT NULL DEFAULT true,
    "is_validated" BOOLEAN NOT NULL DEFAULT false,
    "comment" TEXT,
    "created_by" INTEGER,
    "created_at" TIMESTAMPTZ(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_version_pkey" PRIMARY KEY ("document_version_id")
);

-- CreateTable
CREATE TABLE "document_file" (
    "file_id" SERIAL NOT NULL,
    "document_version_id" INTEGER NOT NULL,
    "file_type_id" INTEGER NOT NULL,
    "original_name" VARCHAR(500),
    "file_extension" VARCHAR(16) NOT NULL,
    "byte_length" BIGINT,
    "page_count" INTEGER,
    "ocr_text" TEXT,
    "redaction" TEXT,
    "pdf_owner" VARCHAR(256),
    "pdf_password" VARCHAR(256),
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_file_pkey" PRIMARY KEY ("file_id")
);

-- CreateTable
CREATE TABLE "document_type" (
    "document_type_id" SERIAL NOT NULL,
    "label" VARCHAR(500) NOT NULL,
    "code" VARCHAR(50),
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "document_type_pkey" PRIMARY KEY ("document_type_id")
);

-- CreateTable
CREATE TABLE "classification_plan" (
    "plan_id" SERIAL NOT NULL,
    "parent_id" INTEGER,
    "label" TEXT NOT NULL,
    "code" VARCHAR(50),
    "is_public" BOOLEAN NOT NULL DEFAULT false,
    "depth" INTEGER NOT NULL DEFAULT 0,
    "path" VARCHAR(900) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "classification_plan_pkey" PRIMARY KEY ("plan_id")
);

-- CreateTable
CREATE TABLE "location" (
    "location_id" SERIAL NOT NULL,
    "parent_id" INTEGER,
    "label" VARCHAR(500) NOT NULL,
    "code" VARCHAR(50),
    "depth" INTEGER NOT NULL DEFAULT 0,
    "path" VARCHAR(900) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "location_pkey" PRIMARY KEY ("location_id")
);

-- CreateTable
CREATE TABLE "dossier_category" (
    "dossier_category_id" SERIAL NOT NULL,
    "label" VARCHAR(100) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "dossier_category_pkey" PRIMARY KEY ("dossier_category_id")
);

-- CreateTable
CREATE TABLE "dossier" (
    "dossier_id" SERIAL NOT NULL,
    "parent_id" INTEGER,
    "label" VARCHAR(500) NOT NULL,
    "code" VARCHAR(50),
    "dossier_category_id" INTEGER,
    "location_id" INTEGER,
    "service_code_suffix" VARCHAR(50),
    "depth" INTEGER NOT NULL DEFAULT 0,
    "path" VARCHAR(900) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dossier_pkey" PRIMARY KEY ("dossier_id")
);

-- CreateTable
CREATE TABLE "dossier_exit_motive" (
    "exit_motive_id" SERIAL NOT NULL,
    "label" VARCHAR(150) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "dossier_exit_motive_pkey" PRIMARY KEY ("exit_motive_id")
);

-- CreateTable
CREATE TABLE "file_type" (
    "file_type_id" SERIAL NOT NULL,
    "extension" VARCHAR(16) NOT NULL,
    "friendly_name" VARCHAR(100) NOT NULL,
    "max_size_bytes" BIGINT NOT NULL DEFAULT 0,
    "icon" VARCHAR(100) NOT NULL DEFAULT '',
    "is_media" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "file_type_pkey" PRIMARY KEY ("file_type_id")
);

-- CreateTable
CREATE TABLE "intercalaire_category" (
    "intercalaire_category_id" SERIAL NOT NULL,
    "category_code" VARCHAR(20) NOT NULL,
    "target_table" VARCHAR(128),
    "target_column" VARCHAR(64),
    "is_blank" BOOLEAN NOT NULL DEFAULT false,
    "is_ingest_handled" BOOLEAN NOT NULL DEFAULT true,
    "label" VARCHAR(100) NOT NULL,

    CONSTRAINT "intercalaire_category_pkey" PRIMARY KEY ("intercalaire_category_id")
);

-- CreateTable
CREATE TABLE "app_user" (
    "user_id" SERIAL NOT NULL,
    "username" VARCHAR(400) NOT NULL,
    "first_name" VARCHAR(50) NOT NULL,
    "last_name" VARCHAR(50) NOT NULL,
    "full_name" VARCHAR(101),
    "email" VARCHAR(200),
    "phone" VARCHAR(50),
    "password_hash" VARCHAR(256),
    "must_change_pwd" BOOLEAN NOT NULL DEFAULT false,
    "service_id" INTEGER,
    "matricule" VARCHAR(50),
    "is_disabled" BOOLEAN NOT NULL DEFAULT false,
    "is_admin" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "app_user_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "app_group" (
    "group_id" SERIAL NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "app_group_pkey" PRIMARY KEY ("group_id")
);

-- CreateTable
CREATE TABLE "app_user_group" (
    "user_group_id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "group_id" INTEGER NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "app_user_group_pkey" PRIMARY KEY ("user_group_id")
);

-- CreateTable
CREATE TABLE "permission_level" (
    "permission_level_id" INTEGER NOT NULL,
    "name" VARCHAR(50) NOT NULL,

    CONSTRAINT "permission_level_pkey" PRIMARY KEY ("permission_level_id")
);

-- CreateTable
CREATE TABLE "document_type_permission" (
    "document_type_permission_id" SERIAL NOT NULL,
    "document_type_id" INTEGER NOT NULL,
    "permission_level_id" INTEGER NOT NULL,
    "group_id" INTEGER,
    "user_group_id" INTEGER,

    CONSTRAINT "document_type_permission_pkey" PRIMARY KEY ("document_type_permission_id")
);

-- CreateTable
CREATE TABLE "document_permission" (
    "document_permission_id" SERIAL NOT NULL,
    "document_id" INTEGER NOT NULL,
    "permission_level_id" INTEGER NOT NULL,
    "user_group_id" INTEGER NOT NULL,
    "granted_by" INTEGER,
    "granted_at" TIMESTAMPTZ(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_permission_pkey" PRIMARY KEY ("document_permission_id")
);

-- CreateIndex
CREATE INDEX "navigation_audit_user_group_id_activity_at_idx" ON "navigation_audit"("user_group_id", "activity_at");

-- CreateIndex
CREATE INDEX "navigation_audit_activity_at_idx" ON "navigation_audit"("activity_at");

-- CreateIndex
CREATE INDEX "data_change_audit_user_group_id_changed_at_idx" ON "data_change_audit"("user_group_id", "changed_at");

-- CreateIndex
CREATE INDEX "data_change_audit_object_ref_idx" ON "data_change_audit"("object_ref");

-- CreateIndex
CREATE UNIQUE INDEX "acquisition_batch_batch_guid_key" ON "acquisition_batch"("batch_guid");

-- CreateIndex
CREATE INDEX "acquisition_batch_dossier_id_idx" ON "acquisition_batch"("dossier_id");

-- CreateIndex
CREATE INDEX "acquisition_batch_scan_date_idx" ON "acquisition_batch"("scan_date");

-- CreateIndex
CREATE INDEX "document_dossier_id_idx" ON "document"("dossier_id");

-- CreateIndex
CREATE INDEX "document_document_type_id_idx" ON "document"("document_type_id");

-- CreateIndex
CREATE INDEX "document_plan_id_idx" ON "document"("plan_id");

-- CreateIndex
CREATE INDEX "document_location_id_idx" ON "document"("location_id");

-- CreateIndex
CREATE INDEX "document_document_date_idx" ON "document"("document_date");

-- CreateIndex
CREATE INDEX "document_batch_id_idx" ON "document"("batch_id");

-- CreateIndex
CREATE INDEX "document_is_archived_is_frozen_idx" ON "document"("is_archived", "is_frozen");

-- CreateIndex
CREATE INDEX "document_version_document_id_idx" ON "document_version"("document_id");

-- CreateIndex
CREATE UNIQUE INDEX "document_version_document_id_version_number_key" ON "document_version"("document_id", "version_number");

-- CreateIndex
CREATE INDEX "document_file_document_version_id_idx" ON "document_file"("document_version_id");

-- CreateIndex
CREATE INDEX "classification_plan_parent_id_idx" ON "classification_plan"("parent_id");

-- CreateIndex
CREATE INDEX "classification_plan_path_idx" ON "classification_plan"("path");

-- CreateIndex
CREATE INDEX "location_parent_id_idx" ON "location"("parent_id");

-- CreateIndex
CREATE INDEX "location_path_idx" ON "location"("path");

-- CreateIndex
CREATE INDEX "dossier_parent_id_idx" ON "dossier"("parent_id");

-- CreateIndex
CREATE INDEX "dossier_path_idx" ON "dossier"("path");

-- CreateIndex
CREATE UNIQUE INDEX "file_type_extension_key" ON "file_type"("extension");

-- CreateIndex
CREATE UNIQUE INDEX "intercalaire_category_category_code_key" ON "intercalaire_category"("category_code");

-- CreateIndex
CREATE UNIQUE INDEX "app_user_username_key" ON "app_user"("username");

-- CreateIndex
CREATE INDEX "app_user_group_user_id_idx" ON "app_user_group"("user_id");

-- CreateIndex
CREATE INDEX "app_user_group_group_id_idx" ON "app_user_group"("group_id");

-- CreateIndex
CREATE UNIQUE INDEX "app_user_group_user_id_group_id_key" ON "app_user_group"("user_id", "group_id");

-- CreateIndex
CREATE INDEX "document_type_permission_document_type_id_idx" ON "document_type_permission"("document_type_id");

-- CreateIndex
CREATE INDEX "document_permission_document_id_user_group_id_idx" ON "document_permission"("document_id", "user_group_id");

-- CreateIndex
CREATE UNIQUE INDEX "document_permission_document_id_user_group_id_permission_le_key" ON "document_permission"("document_id", "user_group_id", "permission_level_id");

-- AddForeignKey
ALTER TABLE "navigation_audit" ADD CONSTRAINT "navigation_audit_user_group_id_fkey" FOREIGN KEY ("user_group_id") REFERENCES "app_user_group"("user_group_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "data_change_audit" ADD CONSTRAINT "data_change_audit_user_group_id_fkey" FOREIGN KEY ("user_group_id") REFERENCES "app_user_group"("user_group_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "data_change_audit" ADD CONSTRAINT "data_change_audit_audit_action_id_fkey" FOREIGN KEY ("audit_action_id") REFERENCES "audit_action"("audit_action_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "acquisition_batch" ADD CONSTRAINT "acquisition_batch_dossier_id_fkey" FOREIGN KEY ("dossier_id") REFERENCES "dossier"("dossier_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "acquisition_batch" ADD CONSTRAINT "acquisition_batch_scanned_by_fkey" FOREIGN KEY ("scanned_by") REFERENCES "app_user_group"("user_group_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document" ADD CONSTRAINT "document_document_type_id_fkey" FOREIGN KEY ("document_type_id") REFERENCES "document_type"("document_type_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document" ADD CONSTRAINT "document_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "classification_plan"("plan_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document" ADD CONSTRAINT "document_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "location"("location_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document" ADD CONSTRAINT "document_dossier_id_fkey" FOREIGN KEY ("dossier_id") REFERENCES "dossier"("dossier_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document" ADD CONSTRAINT "document_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "acquisition_batch"("batch_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document" ADD CONSTRAINT "document_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "app_user_group"("user_group_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document" ADD CONSTRAINT "document_modified_by_fkey" FOREIGN KEY ("modified_by") REFERENCES "app_user_group"("user_group_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document" ADD CONSTRAINT "document_validated_by_fkey" FOREIGN KEY ("validated_by") REFERENCES "app_user_group"("user_group_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_version" ADD CONSTRAINT "document_version_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "document"("document_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_version" ADD CONSTRAINT "document_version_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "app_user_group"("user_group_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_file" ADD CONSTRAINT "document_file_document_version_id_fkey" FOREIGN KEY ("document_version_id") REFERENCES "document_version"("document_version_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_file" ADD CONSTRAINT "document_file_file_type_id_fkey" FOREIGN KEY ("file_type_id") REFERENCES "file_type"("file_type_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "classification_plan" ADD CONSTRAINT "classification_plan_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "classification_plan"("plan_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "location" ADD CONSTRAINT "location_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "location"("location_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dossier" ADD CONSTRAINT "dossier_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "dossier"("dossier_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dossier" ADD CONSTRAINT "dossier_dossier_category_id_fkey" FOREIGN KEY ("dossier_category_id") REFERENCES "dossier_category"("dossier_category_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dossier" ADD CONSTRAINT "dossier_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "location"("location_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_user_group" ADD CONSTRAINT "app_user_group_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_user_group" ADD CONSTRAINT "app_user_group_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "app_group"("group_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_type_permission" ADD CONSTRAINT "document_type_permission_document_type_id_fkey" FOREIGN KEY ("document_type_id") REFERENCES "document_type"("document_type_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_type_permission" ADD CONSTRAINT "document_type_permission_permission_level_id_fkey" FOREIGN KEY ("permission_level_id") REFERENCES "permission_level"("permission_level_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_type_permission" ADD CONSTRAINT "document_type_permission_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "app_group"("group_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_type_permission" ADD CONSTRAINT "document_type_permission_user_group_id_fkey" FOREIGN KEY ("user_group_id") REFERENCES "app_user_group"("user_group_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_permission" ADD CONSTRAINT "document_permission_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "document"("document_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_permission" ADD CONSTRAINT "document_permission_permission_level_id_fkey" FOREIGN KEY ("permission_level_id") REFERENCES "permission_level"("permission_level_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_permission" ADD CONSTRAINT "document_permission_user_group_id_fkey" FOREIGN KEY ("user_group_id") REFERENCES "app_user_group"("user_group_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================================================================
-- Raw-SQL constraints not expressible in Prisma (T013)
-- ============================================================================

-- One current version per document (FR-024 invariant)
CREATE UNIQUE INDEX "ux_document_version_current" ON "document_version"("document_id") WHERE "is_current";

-- Business uniqueness on ACTIVE labels (FR-009 anti-doublon, FR-032)
CREATE UNIQUE INDEX "ux_document_type_label_active" ON "document_type"("label") WHERE "is_active";
CREATE UNIQUE INDEX "ux_dossier_label_active" ON "dossier"("label") WHERE "is_active";

-- Domain CHECKs
ALTER TABLE "acquisition_batch" ADD CONSTRAINT "ck_batch_status" CHECK ("status" IN (0, 1, 2));
ALTER TABLE "document_type_permission" ADD CONSTRAINT "ck_dtp_grantee" CHECK (("group_id" IS NULL) <> ("user_group_id" IS NULL));

-- ============================================================================
-- Full-text search on OCR text (T014) — GIN expression index (no extra column,
-- kept outside the Prisma model). Query: to_tsvector(...) @@ websearch_to_tsquery(...)
-- ============================================================================
CREATE INDEX "ix_document_file_ocr_tsv" ON "document_file"
  USING GIN (to_tsvector('french', coalesce("ocr_text", '')));
