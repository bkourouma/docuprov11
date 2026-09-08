-- §05 — Le destinataire d'un courrier Arrivée devient un RÔLE (fonction), et non plus une personne.
--
-- Motif métier : au bureau d'ordre on adresse un courrier à une fonction (« Bureau d'ordre »,
-- « Directeur Général »), pas à un individu ; tous les utilisateurs qui portent ce rôle le
-- reçoivent. Un rôle ayant N utilisateurs, la colonne `destinataire_expediteur` (FK vers UN
-- app_user_group) ne pouvait pas l'exprimer.
--
-- Modèle retenu : le destinataire est SOIT un acteur nommé (Départ §12 et courriers déjà
-- enregistrés), SOIT un rôle (Arrivée §05). Les deux colonnes coexistent et s'excluent, plutôt que
-- de migrer l'existant vers un rôle — un courrier historique était réellement adressé à une
-- personne, réécrire cette donnée serait une falsification de l'archive.
--
-- `destinataire_expediteur` perd donc son NOT NULL. Le CHECK ci-dessous rétablit l'invariant que ce
-- NOT NULL portait : un courrier a toujours exactement un destinataire, d'un genre ou de l'autre.
-- Sans lui, un courrier sans destinataire deviendrait représentable — et les notifications du
-- workflow (§06/§08/§10/§13) le sauteraient en silence.
--
-- Note : `role` n'a pas de suppression physique (is_active), d'où un ON DELETE NO ACTION qui
-- refuserait d'orpheliner un courrier plutôt que d'annuler son destinataire.

ALTER TABLE "mail" ALTER COLUMN "destinataire_expediteur" DROP NOT NULL;

ALTER TABLE "mail" ADD COLUMN "destinataire_role_id" INTEGER;

ALTER TABLE "mail"
  ADD CONSTRAINT "mail_destinataire_role_id_fkey"
  FOREIGN KEY ("destinataire_role_id") REFERENCES "role"("role_id")
  ON DELETE NO ACTION ON UPDATE CASCADE;

CREATE INDEX "mail_destinataire_role_id_idx" ON "mail"("destinataire_role_id");

ALTER TABLE "mail"
  ADD CONSTRAINT "ck_mail_destinataire"
  CHECK (("destinataire_expediteur" IS NULL) <> ("destinataire_role_id" IS NULL));
