-- Retrait de « Localisation » et « Catégorie » de l'écran « Dossiers », base comprise.
--
-- PÉRIMÈTRE, décidé explicitement :
--  - `dossier.location_id` et `dossier.dossier_category_id` : SUPPRIMÉES.
--  - `dossier_category` : table SUPPRIMÉE — elle n'existait que pour ce rattachement, plus rien
--    ne la référence une fois la colonne partie.
--  - `location` : CONSERVÉE. Elle est rattachée bien au-delà des dossiers — `document.location_id`
--    (colonne indexée), le filtre de recherche, la colonne d'export, les filtres de tableau de
--    bord, la catégorie d'intercalaire QR « LOCALISATION » et le défaut du paramétrage des types.
--    La supprimer aurait fait tomber tout cela ; seul son écran d'administration est masqué
--    (HIDDEN_MENU_KEYS).
--
-- DESTRUCTIF ET IRRÉVERSIBLE : les rattachements dossier → localisation et dossier → catégorie
-- sont perdus, ainsi que le contenu de `dossier_category`. Aucune reprise n'est prévue, c'est le
-- but recherché.

-- Clés étrangères d'abord : PostgreSQL refuserait de retirer une colonne encore contrainte.
ALTER TABLE "dossier" DROP CONSTRAINT IF EXISTS "dossier_location_id_fkey";
ALTER TABLE "dossier" DROP CONSTRAINT IF EXISTS "dossier_dossier_category_id_fkey";

ALTER TABLE "dossier" DROP COLUMN IF EXISTS "location_id";
ALTER TABLE "dossier" DROP COLUMN IF EXISTS "dossier_category_id";

DROP TABLE IF EXISTS "dossier_category";
