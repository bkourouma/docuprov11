-- Retrait du champ "Téléphone" de l'écran de paramétrage e-mail : coordonnées réduites à
-- l'e-mail de contact et au site web. Colonne supprimée plutôt que masquée, pour ne pas laisser de
-- code mort (cf. migration 20260722150000_trim_email_template_setting pour le même principe).

ALTER TABLE "email_template_setting"
    DROP COLUMN "phone";
