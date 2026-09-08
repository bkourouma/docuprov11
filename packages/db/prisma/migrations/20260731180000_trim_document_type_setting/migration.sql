-- Le paramétrage d'un type de document se réduit aux DEUX AXES DE RANGEMENT :
-- le dossier (où la pièce est rangée) et le plan de classement (de quoi elle relève).
--
-- Colonnes retirées : `location_id`, `ocr`, `cryptage`, `taux_compression`, `profil_scanner`,
-- `routines`. Héritées du module source, elles décrivaient une chaîne de numérisation que V6 ne
-- pilote pas depuis cet écran — l'OCR et le découpage sont gouvernés par le mode d'acquisition
-- (`acquisition_batch.use_intercalaires`), pas par le type de document.
--
-- AUCUNE DONNÉE PERDUE : les six colonnes ont été vérifiées vides sur les 20 lignes existantes
-- (0 localisation, 0 OCR, 0 cryptage, 0 taux, 0 profil, 0 routine) avant la suppression.
--
-- `location` n'est PAS touchée : elle reste la localisation du DOCUMENT et sert à la recherche,
-- aux exports, aux tableaux de bord et aux intercalaires QR. Seul le lien depuis ce paramétrage
-- disparaît.

ALTER TABLE "document_type_setting" DROP CONSTRAINT IF EXISTS "document_type_setting_location_id_fkey";
ALTER TABLE "document_type_setting" DROP CONSTRAINT IF EXISTS "ck_dts_taux_compression";

ALTER TABLE "document_type_setting" DROP COLUMN IF EXISTS "location_id";
ALTER TABLE "document_type_setting" DROP COLUMN IF EXISTS "ocr";
ALTER TABLE "document_type_setting" DROP COLUMN IF EXISTS "cryptage";
ALTER TABLE "document_type_setting" DROP COLUMN IF EXISTS "taux_compression";
ALTER TABLE "document_type_setting" DROP COLUMN IF EXISTS "profil_scanner";
ALTER TABLE "document_type_setting" DROP COLUMN IF EXISTS "routines";
