-- §16 — Normalisation des libellés de référentiel.
--
-- Écart corrigé : les index d'unicité portaient sur le libellé BRUT, si bien que « Officiel » et
-- « officiel » (ou « Note de service » et « Notedeservice ») pouvaient coexister parmi les actifs.
-- On les remplace par des index sur la clé normalisée du source : `lower(replace(label, ' ', ''))`.
--
-- Cette expression doit rester le miroir exact de `labelDedupKey()` côté API
-- (apps/api/src/modules/courriers/domain/label-normalisation.ts), sinon un doublon passerait le
-- contrôle applicatif pour échouer ensuite en violation de contrainte (500 au lieu de 409).
--
-- `replace(label, ' ', '')` ne retire que l'espace ASCII, comme le `Replace(" ", "")` du source ;
-- l'API compacte déjà tabulations/sauts de ligne en espaces avant l'écriture, les deux convergent.

DROP INDEX "ux_mail_nature_label_active";
CREATE UNIQUE INDEX "ux_mail_nature_label_active"
  ON "mail_nature" (lower(replace("label", ' ', ''))) WHERE "is_active";

DROP INDEX "ux_mail_objet_label_active";
CREATE UNIQUE INDEX "ux_mail_objet_label_active"
  ON "mail_objet" (lower(replace("label", ' ', ''))) WHERE "is_active";

DROP INDEX "ux_mail_inputation_type_label_active";
CREATE UNIQUE INDEX "ux_mail_inputation_type_label_active"
  ON "mail_inputation_type" (lower(replace("label", ' ', ''))) WHERE "is_active";

DROP INDEX "ux_mail_depart_type_label_active";
CREATE UNIQUE INDEX "ux_mail_depart_type_label_active"
  ON "mail_depart_type" (lower(replace("label", ' ', ''))) WHERE "is_active";

DROP INDEX "ux_mail_confidentialite_label_active";
CREATE UNIQUE INDEX "ux_mail_confidentialite_label_active"
  ON "mail_confidentialite" (lower(replace("label", ' ', ''))) WHERE "is_active";

DROP INDEX "ux_external_entity_type_label_active";
CREATE UNIQUE INDEX "ux_external_entity_type_label_active"
  ON "external_entity_type" (lower(replace("label", ' ', ''))) WHERE "is_active";

DROP INDEX "ux_eecp_label_active";
CREATE UNIQUE INDEX "ux_eecp_label_active"
  ON "external_entity_custom_property" (lower(replace("label", ' ', ''))) WHERE "is_active";
