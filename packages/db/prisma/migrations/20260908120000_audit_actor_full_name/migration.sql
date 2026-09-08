-- Nom de l'acteur figé dans le journal des modifications (2026-09-08).
-- Modèle : packages/db/prisma/models/audit.prisma (`DataChangeAudit.actorFullName`)
--
-- L'onglet « Historique » d'un document n'affichait aucun nom : `data_change_audit` et
-- `navigation_audit` ne portaient l'auteur que par `user_group_id`, et cette colonne est
-- nullable. Toute écriture faite par un compte sans groupe par défaut — ou sous un jeton
-- émis avant que le groupe n'existe — perdait donc définitivement son auteur.
--
-- `navigation_audit` avait déjà `actor_full_name` (jamais alimentée) ; on donne la même
-- colonne à `data_change_audit` et l'API renseigne désormais les deux à l'écriture.
-- Un journal doit porter l'identité TELLE QU'ELLE ÉTAIT au moment du fait : une jointure
-- vers `app_user` afficherait le nom actuel, et perdrait l'auteur si le compte est supprimé
-- ou son groupe réaffecté. La jointure reste en repli pour les lignes déjà écrites.

ALTER TABLE "data_change_audit" ADD COLUMN "actor_full_name" VARCHAR(200);

COMMENT ON COLUMN "data_change_audit"."actor_full_name" IS
  'Nom de l''acteur figé à l''écriture (le user_group_id reste le lien relationnel).';
