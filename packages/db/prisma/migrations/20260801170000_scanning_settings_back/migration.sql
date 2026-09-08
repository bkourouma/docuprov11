-- Consigne de numérisation par type de document — onglet « Paramétrage de numérisation ».
-- Modèle : packages/db/prisma/models/archives.prisma (`DocumentTypeSetting`).
--
-- ⚠ Ces cinq colonnes RÉTABLISSENT celles que la migration 20260731180000 avait retirées. Ce
-- n'est pas un retour en arrière par inadvertance : le motif du retrait était qu'elles restaient
-- vides et qu'aucun écran ne les saisissait — V6 ne pilote pas de scanner. Elles reviennent avec
-- un rôle explicitement DOCUMENTAIRE et un écran de saisie (« Paramétrage des types de
-- documents »), pour consigner ce que l'opérateur doit appliquer.
--
-- Ce qu'elles ne sont pas : un pilotage. L'OCR réellement exécuté sur un lot dépend de son mode
-- d'acquisition (`acquisition_batch.use_intercalaires`) ; le cryptage et la compression ne sont
-- appliqués nulle part dans la chaîne. L'écran de consultation affiche donc la CONSIGNE du type
-- à côté de ce qui a été RÉELLEMENT fait, sans jamais laisser croire que l'une commande l'autre.
--
-- `location_id`, également retirée en 20260731180000, n'est PAS rétablie : elle relevait du
-- rangement, pas de la numérisation, et le dossier + le plan y suffisent.
--
-- Additive : colonnes nullables ou à défaut `false`, aucune ligne existante n'est invalidée.

ALTER TABLE "document_type_setting" ADD COLUMN "ocr" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "document_type_setting" ADD COLUMN "cryptage" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "document_type_setting" ADD COLUMN "taux_compression" INTEGER;
ALTER TABLE "document_type_setting" ADD COLUMN "profil_scanner" VARCHAR(200);
ALTER TABLE "document_type_setting" ADD COLUMN "routines" VARCHAR(500);

-- Un taux de compression est un pourcentage : hors de 1..100 il ne veut rien dire. Même garde
-- que celle qui existait avant le retrait (`ck_dts_taux_compression`).
ALTER TABLE "document_type_setting"
  ADD CONSTRAINT "ck_dts_taux_compression"
  CHECK ("taux_compression" IS NULL OR ("taux_compression" BETWEEN 1 AND 100));
