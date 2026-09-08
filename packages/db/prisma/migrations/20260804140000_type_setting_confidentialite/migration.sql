-- Confidentialité par défaut d'un type de document (écran « Paramétrage des types de documents »).
-- Modèle : packages/db/prisma/models/archives.prisma (`DocumentTypeSetting.confidentialiteId`).
--
-- Posée au même endroit que le dossier et le plan de classement (worker, à la CRÉATION du
-- document), pas seulement affichée : le classement d'un lot ne se ressaisit plus après le choix
-- du type (cf. migration 20260731230000_batch_document_type), la confidentialité par défaut suit
-- la même règle.
--
-- Additive et rétrocompatible : colonne nullable, les paramétrages déjà saisis restent valides
-- (aucune confidentialité par défaut tant qu'elle n'est pas explicitement choisie).

ALTER TABLE "document_type_setting" ADD COLUMN "confidentialite_id" INTEGER;

ALTER TABLE "document_type_setting"
  ADD CONSTRAINT "document_type_setting_confidentialite_id_fkey"
  FOREIGN KEY ("confidentialite_id") REFERENCES "confidentialite"("confidentialite_id")
  ON DELETE SET NULL ON UPDATE CASCADE;
