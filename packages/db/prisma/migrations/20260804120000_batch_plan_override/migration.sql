-- Le PLAN DE CLASSEMENT devient éditable manuellement à l'ouverture du lot d'acquisition,
-- en écrasement du plan par défaut lu dans `document_type_setting` pour le type choisi.
-- Modèle : packages/db/prisma/models/core.prisma (`AcquisitionBatch.planId`).
--
-- Pourquoi : jusqu'ici le plan de classement du lot était TOUJOURS recalculé par le worker
-- depuis le paramétrage du type (`document_type_setting.plan_id`), sans possibilité de le
-- corriger à l'écran. `dossier_id` était déjà éditable et transmis ; `plan_id` ne l'était pas.
--
-- `null` = aucun choix manuel : le worker retombe sur le paramétrage du type, comme avant.
-- En mode « avec intercalaires », un intercalaire QR de catégorie « Plan » garde priorité sur
-- ce champ (cf. apps/worker/src/processors/acquisition.processor.ts, fonction `classer`).
--
-- Additive et rétrocompatible : colonne nullable, les lots déjà traités restent lisibles tels
-- quels.

ALTER TABLE "acquisition_batch" ADD COLUMN "plan_id" INTEGER;

-- Même action référentielle que `document.plan_id` (migration d'init) : la suppression d'un
-- plan ne doit pas emporter l'historique des lots.
ALTER TABLE "acquisition_batch"
  ADD CONSTRAINT "acquisition_batch_plan_id_fkey"
  FOREIGN KEY ("plan_id") REFERENCES "classification_plan"("plan_id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "acquisition_batch_plan_id_idx" ON "acquisition_batch"("plan_id");
