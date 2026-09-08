-- Docu-Archives — cycle de vie, métadonnées dynamiques et prêts de documents.
-- Portage des menus « Paramétrage Docu-Archives » et « Docu-Archives » (source ASP.NET Zero).
-- Modèles : packages/db/prisma/models/archives.prisma.
--
-- Migration écrite À LA MAIN, comme celle du tableau de bord : `prisma migrate diff` propose
-- aussi de recréer deux clés étrangères de `mail` (ON DELETE RESTRICT → SET NULL), dérive
-- préexistante entre schéma et base sans rapport avec ce lot. À traiter séparément.
--
-- Additive uniquement : aucune table ni colonne existante n'est supprimée ou renommée. La seule
-- modification d'une table existante est l'ajout de `document.document_state`, avec valeur par
-- défaut, donc invisible pour le code actuel (acquisition/recherche continuent de lire
-- `is_archived` / `is_frozen`).

-- ===========================================================================
-- 1. Référentiels plats du cycle de vie
-- ===========================================================================

CREATE TABLE "destruction_mode" (
    "destruction_mode_id" SERIAL NOT NULL,
    "label" VARCHAR(500) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "destruction_mode_pkey" PRIMARY KEY ("destruction_mode_id")
);

CREATE TABLE "final_fate" (
    "final_fate_id" SERIAL NOT NULL,
    "label" VARCHAR(500) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "final_fate_pkey" PRIMARY KEY ("final_fate_id")
);

CREATE TABLE "lending_motive" (
    "lending_motive_id" SERIAL NOT NULL,
    "label" VARCHAR(500) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "lending_motive_pkey" PRIMARY KEY ("lending_motive_id")
);

-- ===========================================================================
-- 2. Paramétrage par type de document
-- ===========================================================================

CREATE TABLE "document_type_setting" (
    "document_type_setting_id" SERIAL NOT NULL,
    "document_type_id" INTEGER NOT NULL,
    "dossier_id" INTEGER,
    "plan_id" INTEGER,
    "location_id" INTEGER,
    "ocr" BOOLEAN NOT NULL DEFAULT false,
    "cryptage" BOOLEAN NOT NULL DEFAULT false,
    "taux_compression" INTEGER,
    "profil_scanner" VARCHAR(200),
    "routines" VARCHAR(500),

    CONSTRAINT "document_type_setting_pkey" PRIMARY KEY ("document_type_setting_id")
);

CREATE UNIQUE INDEX "document_type_setting_document_type_id_key"
  ON "document_type_setting"("document_type_id");

CREATE TABLE "document_type_life_cycle" (
    "document_type_life_cycle_id" SERIAL NOT NULL,
    "document_type_id" INTEGER NOT NULL,
    "usefulness_lifespan" INTEGER NOT NULL,
    "compliance_lifespan" INTEGER NOT NULL,
    "observations" TEXT,
    "final_fate_id" INTEGER,
    "destruction_mode_id" INTEGER,

    CONSTRAINT "document_type_life_cycle_pkey" PRIMARY KEY ("document_type_life_cycle_id")
);

CREATE UNIQUE INDEX "document_type_life_cycle_document_type_id_key"
  ON "document_type_life_cycle"("document_type_id");

CREATE TABLE "document_life_cycle" (
    "document_life_cycle_id" SERIAL NOT NULL,
    "document_id" INTEGER NOT NULL,
    "usefulness_lifespan" DATE NOT NULL,
    "compliance_lifespan" DATE NOT NULL,
    "observations" TEXT,
    "final_fate_id" INTEGER,
    "destruction_mode_id" INTEGER,
    "created_by" INTEGER,
    "created_at" TIMESTAMPTZ(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "modified_at" TIMESTAMPTZ(0),

    CONSTRAINT "document_life_cycle_pkey" PRIMARY KEY ("document_life_cycle_id")
);

CREATE UNIQUE INDEX "document_life_cycle_document_id_key" ON "document_life_cycle"("document_id");
CREATE INDEX "document_life_cycle_usefulness_lifespan_idx"
  ON "document_life_cycle"("usefulness_lifespan");

-- ===========================================================================
-- 3. Métadonnées dynamiques
-- ===========================================================================

CREATE TABLE "metadata" (
    "metadata_id" SERIAL NOT NULL,
    "label" VARCHAR(500) NOT NULL,
    "data_type" SMALLINT NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "metadata_pkey" PRIMARY KEY ("metadata_id")
);

CREATE TABLE "metadata_list_item" (
    "metadata_list_item_id" SERIAL NOT NULL,
    "metadata_id" INTEGER NOT NULL,
    "label" VARCHAR(500) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "metadata_list_item_pkey" PRIMARY KEY ("metadata_list_item_id")
);

CREATE INDEX "metadata_list_item_metadata_id_idx" ON "metadata_list_item"("metadata_id");

CREATE TABLE "metadata_document_type" (
    "metadata_document_type_id" SERIAL NOT NULL,
    "document_type_id" INTEGER NOT NULL,
    "metadata_id" INTEGER NOT NULL,

    CONSTRAINT "metadata_document_type_pkey" PRIMARY KEY ("metadata_document_type_id")
);

CREATE UNIQUE INDEX "metadata_document_type_document_type_id_metadata_id_key"
  ON "metadata_document_type"("document_type_id", "metadata_id");
CREATE INDEX "metadata_document_type_metadata_id_idx" ON "metadata_document_type"("metadata_id");

-- ===========================================================================
-- 4. Prêt / communication de documents
-- ===========================================================================

CREATE TABLE "lending_document" (
    "lending_document_id" SERIAL NOT NULL,
    "start_date" DATE NOT NULL,
    "projected_return_date" DATE,
    "returned_date" TIMESTAMPTZ(0),
    "lending_motive_id" INTEGER,
    "user_group_id" INTEGER NOT NULL,
    "created_by" INTEGER,
    "created_at" TIMESTAMPTZ(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lending_document_pkey" PRIMARY KEY ("lending_document_id")
);

CREATE INDEX "lending_document_user_group_id_idx" ON "lending_document"("user_group_id");
CREATE INDEX "lending_document_start_date_idx" ON "lending_document"("start_date");

CREATE TABLE "lending_document_detail" (
    "lending_document_detail_id" SERIAL NOT NULL,
    "lending_document_id" INTEGER NOT NULL,
    "document_id" INTEGER NOT NULL,
    "returned_date" TIMESTAMPTZ(0),

    CONSTRAINT "lending_document_detail_pkey" PRIMARY KEY ("lending_document_detail_id")
);

CREATE UNIQUE INDEX "lending_document_detail_lending_document_id_document_id_key"
  ON "lending_document_detail"("lending_document_id", "document_id");
CREATE INDEX "lending_document_detail_document_id_idx" ON "lending_document_detail"("document_id");
CREATE INDEX "lending_document_detail_returned_date_idx"
  ON "lending_document_detail"("returned_date");

CREATE TABLE "lending_document_comment" (
    "lending_document_comment_id" SERIAL NOT NULL,
    "lending_document_id" INTEGER NOT NULL,
    "user_group_id" INTEGER NOT NULL,
    "comments" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lending_document_comment_pkey" PRIMARY KEY ("lending_document_comment_id")
);

CREATE INDEX "lending_document_comment_lending_document_id_idx"
  ON "lending_document_comment"("lending_document_id");

-- ===========================================================================
-- 5. Clés étrangères
-- ===========================================================================

ALTER TABLE "document_type_setting" ADD CONSTRAINT "document_type_setting_document_type_id_fkey"
  FOREIGN KEY ("document_type_id") REFERENCES "document_type"("document_type_id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "document_type_setting" ADD CONSTRAINT "document_type_setting_dossier_id_fkey"
  FOREIGN KEY ("dossier_id") REFERENCES "dossier"("dossier_id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "document_type_setting" ADD CONSTRAINT "document_type_setting_plan_id_fkey"
  FOREIGN KEY ("plan_id") REFERENCES "classification_plan"("plan_id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "document_type_setting" ADD CONSTRAINT "document_type_setting_location_id_fkey"
  FOREIGN KEY ("location_id") REFERENCES "location"("location_id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "document_type_life_cycle" ADD CONSTRAINT "document_type_life_cycle_document_type_id_fkey"
  FOREIGN KEY ("document_type_id") REFERENCES "document_type"("document_type_id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "document_type_life_cycle" ADD CONSTRAINT "document_type_life_cycle_final_fate_id_fkey"
  FOREIGN KEY ("final_fate_id") REFERENCES "final_fate"("final_fate_id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "document_type_life_cycle" ADD CONSTRAINT "document_type_life_cycle_destruction_mode_id_fkey"
  FOREIGN KEY ("destruction_mode_id") REFERENCES "destruction_mode"("destruction_mode_id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "document_life_cycle" ADD CONSTRAINT "document_life_cycle_document_id_fkey"
  FOREIGN KEY ("document_id") REFERENCES "document"("document_id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "document_life_cycle" ADD CONSTRAINT "document_life_cycle_final_fate_id_fkey"
  FOREIGN KEY ("final_fate_id") REFERENCES "final_fate"("final_fate_id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "document_life_cycle" ADD CONSTRAINT "document_life_cycle_destruction_mode_id_fkey"
  FOREIGN KEY ("destruction_mode_id") REFERENCES "destruction_mode"("destruction_mode_id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "document_life_cycle" ADD CONSTRAINT "document_life_cycle_created_by_fkey"
  FOREIGN KEY ("created_by") REFERENCES "app_user_group"("user_group_id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "metadata_list_item" ADD CONSTRAINT "metadata_list_item_metadata_id_fkey"
  FOREIGN KEY ("metadata_id") REFERENCES "metadata"("metadata_id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "metadata_document_type" ADD CONSTRAINT "metadata_document_type_document_type_id_fkey"
  FOREIGN KEY ("document_type_id") REFERENCES "document_type"("document_type_id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "metadata_document_type" ADD CONSTRAINT "metadata_document_type_metadata_id_fkey"
  FOREIGN KEY ("metadata_id") REFERENCES "metadata"("metadata_id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "lending_document" ADD CONSTRAINT "lending_document_lending_motive_id_fkey"
  FOREIGN KEY ("lending_motive_id") REFERENCES "lending_motive"("lending_motive_id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "lending_document" ADD CONSTRAINT "lending_document_user_group_id_fkey"
  FOREIGN KEY ("user_group_id") REFERENCES "app_user_group"("user_group_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "lending_document" ADD CONSTRAINT "lending_document_created_by_fkey"
  FOREIGN KEY ("created_by") REFERENCES "app_user_group"("user_group_id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "lending_document_detail" ADD CONSTRAINT "lending_document_detail_lending_document_id_fkey"
  FOREIGN KEY ("lending_document_id") REFERENCES "lending_document"("lending_document_id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "lending_document_detail" ADD CONSTRAINT "lending_document_detail_document_id_fkey"
  FOREIGN KEY ("document_id") REFERENCES "document"("document_id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "lending_document_comment" ADD CONSTRAINT "lending_document_comment_lending_document_id_fkey"
  FOREIGN KEY ("lending_document_id") REFERENCES "lending_document"("lending_document_id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "lending_document_comment" ADD CONSTRAINT "lending_document_comment_user_group_id_fkey"
  FOREIGN KEY ("user_group_id") REFERENCES "app_user_group"("user_group_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===========================================================================
-- 6. `document.document_state` (source `DocumentStates`)
-- ===========================================================================
-- Colonne AJOUTÉE, jamais substituée : `is_archived` / `is_frozen` restent la vérité de
-- l'acquisition, de la QA et de la recherche. Seule l'épuration (écran « DUA Expirés ») écrit
-- ici, en posant 3. L'initialisation reflète l'état actuel des documents pour que les écrans
-- « DUA Expirés » et « Documents Épurés » démarrent cohérents sur une base déjà remplie.

ALTER TABLE "document" ADD COLUMN "document_state" SMALLINT NOT NULL DEFAULT 0;

UPDATE "document" SET "document_state" = 1 WHERE "is_archived";

ALTER TABLE "document" ADD CONSTRAINT "ck_document_state"
  CHECK ("document_state" IN (0, 1, 2, 3, 4));

CREATE INDEX "document_document_state_idx" ON "document"("document_state");

-- ===========================================================================
-- 7. Contraintes de domaine et uniques partiels
-- ===========================================================================
-- L'expression des uniques partiels doit rester le miroir exact de `labelDedupKey()`
-- (apps/api/src/modules/courriers/domain/label-normalisation.ts), réutilisé par le service
-- Docu-Archives : sinon un doublon passerait le contrôle applicatif pour échouer en violation de
-- contrainte (500 au lieu de 409).

CREATE UNIQUE INDEX "ux_destruction_mode_label_active"
  ON "destruction_mode" (lower(replace("label", ' ', ''))) WHERE "is_active";
CREATE UNIQUE INDEX "ux_final_fate_label_active"
  ON "final_fate" (lower(replace("label", ' ', ''))) WHERE "is_active";
CREATE UNIQUE INDEX "ux_lending_motive_label_active"
  ON "lending_motive" (lower(replace("label", ' ', ''))) WHERE "is_active";
CREATE UNIQUE INDEX "ux_metadata_label_active"
  ON "metadata" (lower(replace("label", ' ', ''))) WHERE "is_active";

-- Les valeurs de liste ne sont uniques qu'AU SEIN de leur métadonnée : deux listes distinctes
-- peuvent proposer « Autre ».
CREATE UNIQUE INDEX "ux_metadata_list_item_label_active"
  ON "metadata_list_item" ("metadata_id", lower(replace("label", ' ', ''))) WHERE "is_active";

-- Types de saisie (§8) : 0 Null, 1 Texte, 2 Entier, 3 Date, 4 Texte long, 5 Booléen, 6 Liste.
ALTER TABLE "metadata" ADD CONSTRAINT "ck_metadata_data_type"
  CHECK ("data_type" BETWEEN 0 AND 6);

-- Durées de conservation : des mois, jamais négatifs.
ALTER TABLE "document_type_life_cycle" ADD CONSTRAINT "ck_dtlc_lifespans_positive"
  CHECK ("usefulness_lifespan" >= 0 AND "compliance_lifespan" >= 0);

-- Taux de compression : un pourcentage.
ALTER TABLE "document_type_setting" ADD CONSTRAINT "ck_dts_taux_compression"
  CHECK ("taux_compression" IS NULL OR ("taux_compression" BETWEEN 0 AND 100));

-- Un prêt ne peut pas être rendu avant d'avoir commencé.
ALTER TABLE "lending_document" ADD CONSTRAINT "ck_lending_dates"
  CHECK ("projected_return_date" IS NULL OR "projected_return_date" >= "start_date");
