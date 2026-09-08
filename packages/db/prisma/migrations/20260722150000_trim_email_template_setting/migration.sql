-- Simplifie « email_template_setting » : l'écran de paramétrage exposait trop de champs
-- (sous-titre institutionnel, baseline, nom du produit, URL de logo externe, couleur d'accent,
-- adresse, mention de bas de page). Ces champs sont retirés plutôt que masqués côté écran, pour ne
-- pas laisser de colonnes et de code mort inutilisés.
--
-- L'organisation, le logo (dépôt de fichier), le téléphone, l'e-mail de contact et le site web
-- restent seuls éditables.
--
-- `accent_color` portait un CHECK de format (`ck_email_template_setting_accent_color`) : PostgreSQL
-- le supprime automatiquement avec la colonne, aucune action explicite requise.

ALTER TABLE "email_template_setting"
    DROP COLUMN "org_tagline",
    DROP COLUMN "product_name",
    DROP COLUMN "baseline",
    DROP COLUMN "logo_url",
    DROP COLUMN "accent_color",
    DROP COLUMN "address_line",
    DROP COLUMN "footer_note";
