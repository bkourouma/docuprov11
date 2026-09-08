-- Le TYPE DE DOCUMENT devient une propriété du LOT d'acquisition.
-- Modèle : packages/db/prisma/models/core.prisma (`AcquisitionBatch.documentTypeId`).
--
-- Pourquoi : le type est désormais choisi à l'étape « Destination », AVANT le téléversement, et
-- c'est lui qui décide du dossier et du plan de classement (via `document_type_setting`) ainsi que
-- des métadonnées à saisir. Tant qu'il ne vivait que dans l'écran, le classement devait être
-- renvoyé par le client à l'indexation — donc restait modifiable par quiconque appelle l'API.
-- En le portant sur le lot, c'est le worker qui classe les documents à leur création, et
-- l'endpoint d'indexation n'accepte plus que les métadonnées (verrouillage demandé).
--
-- En mode « avec intercalaires », ce type n'est qu'un REPLI : le worker ne l'applique qu'aux
-- documents dont aucun intercalaire QR n'a fixé le type.
--
-- Additive et rétrocompatible : colonne nullable, les lots déjà traités restent lisibles tels
-- quels (leurs documents portent déjà leur propre `document_type_id`).

ALTER TABLE "acquisition_batch" ADD COLUMN "document_type_id" INTEGER;

-- Même action référentielle que `document.document_type_id` (migration d'init) : la suppression
-- d'un type ne doit pas emporter l'historique des lots.
ALTER TABLE "acquisition_batch"
  ADD CONSTRAINT "acquisition_batch_document_type_id_fkey"
  FOREIGN KEY ("document_type_id") REFERENCES "document_type"("document_type_id")
  ON DELETE SET NULL ON UPDATE CASCADE;
