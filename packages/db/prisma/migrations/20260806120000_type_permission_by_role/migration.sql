-- « Sécurité type document par profil » devient « par rôle » (2026-08-06).
-- Modèle : packages/db/prisma/models/security.prisma (`DocumentTypePermission.roleId`)
--
-- L'écran accordait un droit par TYPE de document à un `app_group` (« profil »). Or l'administration
-- n'expose qu'une seule notion de population d'utilisateurs — le RÔLE (`role`, celui qui porte déjà
-- les menus et qui est affecté à chaque compte) : les profils n'y sont créés nulle part, et la liste
-- déroulante montrait donc un référentiel que personne n'alimente. On bascule le bénéficiaire
-- collectif de ce droit sur `role`.
--
-- Substitution et non ajout : garder les deux axes ferait cohabiter deux définitions concurrentes de
-- « groupe » dans la MÊME table, et l'ACL devrait résoudre les deux. La table est vide en dev comme
-- en recette (aucun droit par type n'a encore été accordé) — le DROP est donc sans perte ; si une
-- base en portait, ses lignes « profil » seraient à ressaisir sur le rôle correspondant.
--
-- `document_permission` (droits sur UN document, onglet « Accès par Profil ») garde son `group_id` :
-- ce lot ne touche qu'aux droits par type.

ALTER TABLE "document_type_permission" DROP CONSTRAINT "ck_dtp_grantee";
ALTER TABLE "document_type_permission" DROP CONSTRAINT "document_type_permission_group_id_fkey";
ALTER TABLE "document_type_permission" DROP COLUMN "group_id";

ALTER TABLE "document_type_permission" ADD COLUMN "role_id" INTEGER;

-- `ON DELETE SET NULL` comme l'ancienne FK profil aurait laissé des lignes sans bénéficiaire, que le
-- CHECK ci-dessous interdit : la suppression d'un rôle emporte ses droits, comme pour ses menus
-- (`role_menu_permission`).
ALTER TABLE "document_type_permission"
  ADD CONSTRAINT "document_type_permission_role_id_fkey"
  FOREIGN KEY ("role_id") REFERENCES "role"("role_id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Même invariant qu'avant, sur le nouvel axe : un droit vise UN bénéficiaire, jamais zéro ni deux.
ALTER TABLE "document_type_permission"
  ADD CONSTRAINT "ck_dtp_grantee" CHECK (("role_id" IS NULL) <> ("user_group_id" IS NULL));

CREATE INDEX "document_type_permission_role_id_idx" ON "document_type_permission"("role_id");
