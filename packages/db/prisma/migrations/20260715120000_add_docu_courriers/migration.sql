-- AlterTable
ALTER TABLE "role" ADD COLUMN     "organigramme_id" INTEGER;

-- CreateTable
CREATE TABLE "mail_nature" (
    "mail_nature_id" SERIAL NOT NULL,
    "label" VARCHAR(500) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "mail_nature_pkey" PRIMARY KEY ("mail_nature_id")
);

-- CreateTable
CREATE TABLE "mail_objet" (
    "mail_objet_id" SERIAL NOT NULL,
    "label" VARCHAR(500) NOT NULL,
    "duree_suivi_externe" INTEGER NOT NULL DEFAULT 0,
    "duree_suivi_interne" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "mail_objet_pkey" PRIMARY KEY ("mail_objet_id")
);

-- CreateTable
CREATE TABLE "mail_inputation_type" (
    "mail_inputation_type_id" SERIAL NOT NULL,
    "label" VARCHAR(500) NOT NULL,
    "suivi" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "mail_inputation_type_pkey" PRIMARY KEY ("mail_inputation_type_id")
);

-- CreateTable
CREATE TABLE "mail_depart_type" (
    "mail_depart_type_id" SERIAL NOT NULL,
    "label" VARCHAR(500) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "mail_depart_type_pkey" PRIMARY KEY ("mail_depart_type_id")
);

-- CreateTable
CREATE TABLE "mail_confidentialite" (
    "mail_confidentialite_id" SERIAL NOT NULL,
    "label" VARCHAR(500) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "mail_confidentialite_pkey" PRIMARY KEY ("mail_confidentialite_id")
);

-- CreateTable
CREATE TABLE "external_entity_type" (
    "external_entity_type_id" SERIAL NOT NULL,
    "label" VARCHAR(500) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "external_entity_type_pkey" PRIMARY KEY ("external_entity_type_id")
);

-- CreateTable
CREATE TABLE "external_entity" (
    "external_entity_id" SERIAL NOT NULL,
    "label" VARCHAR(500) NOT NULL,
    "email" VARCHAR(200),
    "telephone" VARCHAR(50),
    "external_entity_type_id" INTEGER,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "external_entity_pkey" PRIMARY KEY ("external_entity_id")
);

-- CreateTable
CREATE TABLE "external_entity_custom_property" (
    "external_entity_custom_property_id" SERIAL NOT NULL,
    "label" VARCHAR(500) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "external_entity_custom_property_pkey" PRIMARY KEY ("external_entity_custom_property_id")
);

-- CreateTable
CREATE TABLE "external_entity_custom_value" (
    "external_entity_custom_value_id" SERIAL NOT NULL,
    "value" TEXT NOT NULL,
    "external_entity_id" INTEGER NOT NULL,
    "external_entity_type_id" INTEGER NOT NULL,
    "external_entity_custom_property_id" INTEGER NOT NULL,

    CONSTRAINT "external_entity_custom_value_pkey" PRIMARY KEY ("external_entity_custom_value_id")
);

-- CreateTable
CREATE TABLE "organigramme" (
    "organigramme_id" SERIAL NOT NULL,
    "parent_id" INTEGER,
    "label" VARCHAR(500) NOT NULL,
    "depth" INTEGER NOT NULL DEFAULT 0,
    "path" VARCHAR(900) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "organigramme_pkey" PRIMARY KEY ("organigramme_id")
);

-- CreateTable
CREATE TABLE "mail" (
    "mail_id" SERIAL NOT NULL,
    "title" VARCHAR(500) NOT NULL,
    "mail_date" DATE NOT NULL,
    "description" TEXT,
    "reference" VARCHAR(255),
    "n_reference" VARCHAR(100),
    "mail_type" SMALLINT NOT NULL DEFAULT 0,
    "status" SMALLINT NOT NULL DEFAULT 0,
    "date_enregistrement_courrier" TIMESTAMPTZ(0),
    "date_follow_up" TIMESTAMPTZ(0),
    "end_date_follow_up" TIMESTAMPTZ(0),
    "date_decharge" TIMESTAMPTZ(0),
    "date_traited" TIMESTAMPTZ(0),
    "date_butoire" TIMESTAMPTZ(0),
    "valider" BOOLEAN NOT NULL DEFAULT false,
    "validation_direction" BOOLEAN NOT NULL DEFAULT false,
    "validation_dg" BOOLEAN NOT NULL DEFAULT false,
    "enregistrement_reponse" BOOLEAN NOT NULL DEFAULT false,
    "decharge" BOOLEAN NOT NULL DEFAULT false,
    "destinataire_expediteur" INTEGER NOT NULL,
    "mail_nature_id" INTEGER,
    "confidentialite_id" INTEGER,
    "external_entity_id" INTEGER,
    "mail_parent" INTEGER,
    "mail_objet_id" INTEGER,
    "organigramme_id" INTEGER,
    "mail_depart_type_id" INTEGER,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_by" INTEGER,
    "created_at" TIMESTAMPTZ(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "modified_by" INTEGER,
    "modified_at" TIMESTAMPTZ(0),

    CONSTRAINT "mail_pkey" PRIMARY KEY ("mail_id")
);

-- CreateTable
CREATE TABLE "mail_inputation" (
    "mail_inputation_id" SERIAL NOT NULL,
    "instructions" TEXT,
    "deadline" TIMESTAMPTZ(0),
    "date_treated" TIMESTAMPTZ(0),
    "last_reminder_sent" TIMESTAMPTZ(0),
    "mail_inputation_type_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "mail_id" INTEGER NOT NULL,
    "created_by" INTEGER,
    "created_at" TIMESTAMPTZ(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mail_inputation_pkey" PRIMARY KEY ("mail_inputation_id")
);

-- CreateTable
CREATE TABLE "mail_comment" (
    "mail_comment_id" SERIAL NOT NULL,
    "comments" TEXT NOT NULL,
    "user_id" INTEGER NOT NULL,
    "mail_id" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mail_comment_pkey" PRIMARY KEY ("mail_comment_id")
);

-- CreateTable
CREATE TABLE "mail_document" (
    "mail_document_id" SERIAL NOT NULL,
    "decharge" BOOLEAN NOT NULL DEFAULT false,
    "mail_id" INTEGER NOT NULL,
    "document_id" INTEGER NOT NULL,
    "created_by" INTEGER,
    "created_at" TIMESTAMPTZ(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mail_document_pkey" PRIMARY KEY ("mail_document_id")
);

-- CreateTable
CREATE TABLE "mail_scanned_document" (
    "mail_scanned_document_id" SERIAL NOT NULL,
    "file_name" VARCHAR(500),
    "file_path" VARCHAR(1000),
    "date_scanned" TIMESTAMPTZ(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "machine_name" VARCHAR(128),
    "is_traite" BOOLEAN NOT NULL DEFAULT false,
    "mail_id" INTEGER,
    "document_id" INTEGER,
    "created_by" INTEGER,
    "created_at" TIMESTAMPTZ(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mail_scanned_document_pkey" PRIMARY KEY ("mail_scanned_document_id")
);

-- CreateTable
CREATE TABLE "mail_action_log" (
    "mail_action_log_id" SERIAL NOT NULL,
    "mail_id" INTEGER,
    "action_code" INTEGER NOT NULL,
    "user_group_id" INTEGER,
    "details" TEXT,
    "created_at" TIMESTAMPTZ(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mail_action_log_pkey" PRIMARY KEY ("mail_action_log_id")
);

-- CreateTable
CREATE TABLE "mail_permission" (
    "mail_permission_id" SERIAL NOT NULL,
    "mail_id" INTEGER NOT NULL,
    "permission_level_id" INTEGER NOT NULL,
    "user_group_id" INTEGER NOT NULL,
    "granted_by" INTEGER,
    "granted_at" TIMESTAMPTZ(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mail_permission_pkey" PRIMARY KEY ("mail_permission_id")
);

-- CreateTable
CREATE TABLE "notification" (
    "notification_id" SERIAL NOT NULL,
    "recipient_user_group_id" INTEGER NOT NULL,
    "message" TEXT NOT NULL,
    "target_type" VARCHAR(50),
    "target_id" INTEGER,
    "is_read" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "read_at" TIMESTAMPTZ(0),

    CONSTRAINT "notification_pkey" PRIMARY KEY ("notification_id")
);

-- CreateIndex
CREATE INDEX "external_entity_external_entity_type_id_idx" ON "external_entity"("external_entity_type_id");

-- CreateIndex
CREATE INDEX "external_entity_custom_value_external_entity_id_idx" ON "external_entity_custom_value"("external_entity_id");

-- CreateIndex
CREATE UNIQUE INDEX "external_entity_custom_value_external_entity_id_external_en_key" ON "external_entity_custom_value"("external_entity_id", "external_entity_custom_property_id");

-- CreateIndex
CREATE INDEX "organigramme_parent_id_idx" ON "organigramme"("parent_id");

-- CreateIndex
CREATE INDEX "organigramme_path_idx" ON "organigramme"("path");

-- CreateIndex
CREATE INDEX "mail_status_idx" ON "mail"("status");

-- CreateIndex
CREATE INDEX "mail_mail_type_idx" ON "mail"("mail_type");

-- CreateIndex
CREATE INDEX "mail_external_entity_id_idx" ON "mail"("external_entity_id");

-- CreateIndex
CREATE INDEX "mail_destinataire_expediteur_idx" ON "mail"("destinataire_expediteur");

-- CreateIndex
CREATE INDEX "mail_mail_parent_idx" ON "mail"("mail_parent");

-- CreateIndex
CREATE INDEX "mail_date_butoire_idx" ON "mail"("date_butoire");

-- CreateIndex
CREATE INDEX "mail_created_at_idx" ON "mail"("created_at");

-- CreateIndex
CREATE INDEX "mail_mail_nature_id_idx" ON "mail"("mail_nature_id");

-- CreateIndex
CREATE INDEX "mail_confidentialite_id_idx" ON "mail"("confidentialite_id");

-- CreateIndex
CREATE INDEX "mail_mail_objet_id_idx" ON "mail"("mail_objet_id");

-- CreateIndex
CREATE INDEX "mail_organigramme_id_idx" ON "mail"("organigramme_id");

-- CreateIndex
CREATE INDEX "mail_mail_depart_type_id_idx" ON "mail"("mail_depart_type_id");

-- CreateIndex
CREATE INDEX "mail_inputation_mail_id_idx" ON "mail_inputation"("mail_id");

-- CreateIndex
CREATE INDEX "mail_inputation_user_id_idx" ON "mail_inputation"("user_id");

-- CreateIndex
CREATE INDEX "mail_inputation_mail_inputation_type_id_idx" ON "mail_inputation"("mail_inputation_type_id");

-- CreateIndex
CREATE INDEX "mail_comment_mail_id_idx" ON "mail_comment"("mail_id");

-- CreateIndex
CREATE INDEX "mail_document_mail_id_idx" ON "mail_document"("mail_id");

-- CreateIndex
CREATE INDEX "mail_document_document_id_idx" ON "mail_document"("document_id");

-- CreateIndex
CREATE UNIQUE INDEX "mail_document_mail_id_document_id_key" ON "mail_document"("mail_id", "document_id");

-- CreateIndex
CREATE INDEX "mail_scanned_document_is_traite_idx" ON "mail_scanned_document"("is_traite");

-- CreateIndex
CREATE INDEX "mail_scanned_document_mail_id_idx" ON "mail_scanned_document"("mail_id");

-- CreateIndex
CREATE INDEX "mail_scanned_document_document_id_idx" ON "mail_scanned_document"("document_id");

-- CreateIndex
CREATE INDEX "mail_action_log_mail_id_idx" ON "mail_action_log"("mail_id");

-- CreateIndex
CREATE INDEX "mail_action_log_user_group_id_created_at_idx" ON "mail_action_log"("user_group_id", "created_at");

-- CreateIndex
CREATE INDEX "mail_permission_mail_id_user_group_id_idx" ON "mail_permission"("mail_id", "user_group_id");

-- CreateIndex
CREATE UNIQUE INDEX "mail_permission_mail_id_user_group_id_permission_level_id_key" ON "mail_permission"("mail_id", "user_group_id", "permission_level_id");

-- CreateIndex
CREATE INDEX "notification_recipient_user_group_id_is_read_idx" ON "notification"("recipient_user_group_id", "is_read");

-- CreateIndex
CREATE INDEX "role_organigramme_id_idx" ON "role"("organigramme_id");

-- AddForeignKey
ALTER TABLE "external_entity" ADD CONSTRAINT "external_entity_external_entity_type_id_fkey" FOREIGN KEY ("external_entity_type_id") REFERENCES "external_entity_type"("external_entity_type_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "external_entity_custom_value" ADD CONSTRAINT "external_entity_custom_value_external_entity_id_fkey" FOREIGN KEY ("external_entity_id") REFERENCES "external_entity"("external_entity_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "external_entity_custom_value" ADD CONSTRAINT "external_entity_custom_value_external_entity_type_id_fkey" FOREIGN KEY ("external_entity_type_id") REFERENCES "external_entity_type"("external_entity_type_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "external_entity_custom_value" ADD CONSTRAINT "external_entity_custom_value_external_entity_custom_proper_fkey" FOREIGN KEY ("external_entity_custom_property_id") REFERENCES "external_entity_custom_property"("external_entity_custom_property_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organigramme" ADD CONSTRAINT "organigramme_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "organigramme"("organigramme_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mail" ADD CONSTRAINT "mail_destinataire_expediteur_fkey" FOREIGN KEY ("destinataire_expediteur") REFERENCES "app_user_group"("user_group_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mail" ADD CONSTRAINT "mail_mail_nature_id_fkey" FOREIGN KEY ("mail_nature_id") REFERENCES "mail_nature"("mail_nature_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mail" ADD CONSTRAINT "mail_confidentialite_id_fkey" FOREIGN KEY ("confidentialite_id") REFERENCES "mail_confidentialite"("mail_confidentialite_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mail" ADD CONSTRAINT "mail_external_entity_id_fkey" FOREIGN KEY ("external_entity_id") REFERENCES "external_entity"("external_entity_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mail" ADD CONSTRAINT "mail_mail_parent_fkey" FOREIGN KEY ("mail_parent") REFERENCES "mail"("mail_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mail" ADD CONSTRAINT "mail_mail_objet_id_fkey" FOREIGN KEY ("mail_objet_id") REFERENCES "mail_objet"("mail_objet_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mail" ADD CONSTRAINT "mail_organigramme_id_fkey" FOREIGN KEY ("organigramme_id") REFERENCES "organigramme"("organigramme_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mail" ADD CONSTRAINT "mail_mail_depart_type_id_fkey" FOREIGN KEY ("mail_depart_type_id") REFERENCES "mail_depart_type"("mail_depart_type_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mail" ADD CONSTRAINT "mail_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "app_user_group"("user_group_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mail" ADD CONSTRAINT "mail_modified_by_fkey" FOREIGN KEY ("modified_by") REFERENCES "app_user_group"("user_group_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mail_inputation" ADD CONSTRAINT "mail_inputation_mail_id_fkey" FOREIGN KEY ("mail_id") REFERENCES "mail"("mail_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mail_inputation" ADD CONSTRAINT "mail_inputation_mail_inputation_type_id_fkey" FOREIGN KEY ("mail_inputation_type_id") REFERENCES "mail_inputation_type"("mail_inputation_type_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mail_inputation" ADD CONSTRAINT "mail_inputation_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user_group"("user_group_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mail_inputation" ADD CONSTRAINT "mail_inputation_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "app_user_group"("user_group_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mail_comment" ADD CONSTRAINT "mail_comment_mail_id_fkey" FOREIGN KEY ("mail_id") REFERENCES "mail"("mail_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mail_comment" ADD CONSTRAINT "mail_comment_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user_group"("user_group_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mail_document" ADD CONSTRAINT "mail_document_mail_id_fkey" FOREIGN KEY ("mail_id") REFERENCES "mail"("mail_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mail_document" ADD CONSTRAINT "mail_document_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "document"("document_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mail_document" ADD CONSTRAINT "mail_document_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "app_user_group"("user_group_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mail_scanned_document" ADD CONSTRAINT "mail_scanned_document_mail_id_fkey" FOREIGN KEY ("mail_id") REFERENCES "mail"("mail_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mail_scanned_document" ADD CONSTRAINT "mail_scanned_document_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "document"("document_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mail_scanned_document" ADD CONSTRAINT "mail_scanned_document_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "app_user_group"("user_group_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mail_action_log" ADD CONSTRAINT "mail_action_log_mail_id_fkey" FOREIGN KEY ("mail_id") REFERENCES "mail"("mail_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mail_action_log" ADD CONSTRAINT "mail_action_log_user_group_id_fkey" FOREIGN KEY ("user_group_id") REFERENCES "app_user_group"("user_group_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mail_permission" ADD CONSTRAINT "mail_permission_mail_id_fkey" FOREIGN KEY ("mail_id") REFERENCES "mail"("mail_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mail_permission" ADD CONSTRAINT "mail_permission_permission_level_id_fkey" FOREIGN KEY ("permission_level_id") REFERENCES "permission_level"("permission_level_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mail_permission" ADD CONSTRAINT "mail_permission_user_group_id_fkey" FOREIGN KEY ("user_group_id") REFERENCES "app_user_group"("user_group_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification" ADD CONSTRAINT "notification_recipient_user_group_id_fkey" FOREIGN KEY ("recipient_user_group_id") REFERENCES "app_user_group"("user_group_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role" ADD CONSTRAINT "role_organigramme_id_fkey" FOREIGN KEY ("organigramme_id") REFERENCES "organigramme"("organigramme_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ============================================================================
-- Docu-Courriers — contraintes non exprimables en Prisma (SQL brut)
-- ============================================================================

-- Domain CHECKs — états stockés en smallint (énumérations §02.1, pas d'enum Prisma).
ALTER TABLE "mail" ADD CONSTRAINT "ck_mail_status" CHECK ("status" IN (0, 1, 2, 3, 4));
ALTER TABLE "mail" ADD CONSTRAINT "ck_mail_type" CHECK ("mail_type" IN (0, 1, 2));

-- Uniques partiels sur le libellé actif des référentiels « lookup » (anti-doublon → contrainte V6 ;
-- la désactivation is_active=false libère le libellé). NB : external_entity (correspondants) n'est
-- volontairement PAS contraint — deux correspondants actifs peuvent porter le même libellé.
CREATE UNIQUE INDEX "ux_mail_nature_label_active" ON "mail_nature"("label") WHERE "is_active";
CREATE UNIQUE INDEX "ux_mail_objet_label_active" ON "mail_objet"("label") WHERE "is_active";
CREATE UNIQUE INDEX "ux_mail_inputation_type_label_active" ON "mail_inputation_type"("label") WHERE "is_active";
CREATE UNIQUE INDEX "ux_mail_depart_type_label_active" ON "mail_depart_type"("label") WHERE "is_active";
CREATE UNIQUE INDEX "ux_mail_confidentialite_label_active" ON "mail_confidentialite"("label") WHERE "is_active";
CREATE UNIQUE INDEX "ux_external_entity_type_label_active" ON "external_entity_type"("label") WHERE "is_active";
CREATE UNIQUE INDEX "ux_eecp_label_active" ON "external_entity_custom_property"("label") WHERE "is_active";

-- Numérotation NReference : unique PAR type de courrier de départ (fix §19 : numérotation par type,
-- et non globale). Ne s'applique qu'aux courriers numérotés (n_reference et type non nuls).
CREATE UNIQUE INDEX "ux_mail_nreference_per_type" ON "mail"("mail_depart_type_id", "n_reference")
  WHERE "n_reference" IS NOT NULL AND "mail_depart_type_id" IS NOT NULL;

-- ============================================================================
-- Recherche multicritères plein-texte (§11) — index d'expression GIN (french),
-- sans colonne stockée. Requête :
--   to_tsvector('french', ...) @@ websearch_to_tsquery('french', :q)
-- ============================================================================
CREATE INDEX "ix_mail_fts" ON "mail"
  USING GIN (to_tsvector('french',
    coalesce("title", '') || ' ' ||
    coalesce("description", '') || ' ' ||
    coalesce("reference", '') || ' ' ||
    coalesce("n_reference", '')));
