-- La CONFIDENTIALITÉ devient éditable manuellement à l'ouverture du lot d'acquisition, en
-- écrasement du niveau par défaut lu dans `document_type_setting` pour le type choisi.
-- Modèle : packages/db/prisma/models/core.prisma (`AcquisitionBatch.confidentialiteId`).
-- Même geste que 20260804120000_batch_plan_override pour `plan_id`.
--
-- Pourquoi : jusqu'ici la confidentialité du lot était TOUJOURS recalculée par le worker depuis
-- le paramétrage du type (`document_type_setting.confidentialite_id`), sans possibilité de la
-- corriger à l'écran — contrairement à `dossier_id`/`plan_id`, déjà éditables.
--
-- `null` = aucun choix manuel : le worker retombe sur le paramétrage du type, comme avant.
--
-- Additive et rétrocompatible : colonne nullable, les lots déjà traités restent lisibles tels
-- quels.

ALTER TABLE "acquisition_batch" ADD COLUMN "confidentialite_id" INTEGER;

-- Même action référentielle que `document.confidentialite_id` : la suppression d'un niveau ne
-- doit pas emporter l'historique des lots.
ALTER TABLE "acquisition_batch"
  ADD CONSTRAINT "acquisition_batch_confidentialite_id_fkey"
  FOREIGN KEY ("confidentialite_id") REFERENCES "confidentialite"("confidentialite_id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "acquisition_batch_confidentialite_id_idx" ON "acquisition_batch"("confidentialite_id");
