-- Confidentialité : niveau exigé par un document, habilitation portée par un utilisateur.
-- Modèles : packages/db/prisma/models/referentials.prisma (`Confidentialite`)
--           packages/db/prisma/models/core.prisma (`Document.confidentialiteId`)
--           packages/db/prisma/models/security.prisma (`AppUser.confidentialiteId`)
--
-- Reprend le 6e cas de l'algorithme de permission du module source : à défaut de droit explicite,
-- l'habilitation de l'utilisateur doit être de rang SUPÉRIEUR OU ÉGAL au niveau du document.
--
-- D'où un référentiel ORDONNÉ (`rank`), là où `mail_confidentialite` n'est qu'un libellé : sans
-- rang, « Confidentiel » et « Secret » seraient incomparables et la règle inexprimable. Les deux
-- tables restent distinctes — la confidentialité d'un courrier et celle d'un document n'ont ni le
-- même cycle de vie ni le même écran ; les fondre coupleraient deux modules sans bénéfice.
--
-- ⚠ Cette migration pose la DONNÉE. Elle ne rebranche pas à elle seule le filtrage des lectures :
-- V6 applique un accès global assumé (override D-17, cf. `DocumentsService.canAccess`), et
-- l'écran de consultation le dit franchement. Rendre la règle bloquante est une décision
-- d'architecture qui toucherait aussi la recherche et le tableau de bord.
--
-- Additive : colonnes nullables, aucune ligne existante n'est invalidée. `null` sur un document
-- signifie « aucun niveau requis » ; `null` sur un utilisateur, « aucune habilitation ».

CREATE TABLE "confidentialite" (
    "confidentialite_id" SERIAL NOT NULL,
    "label" VARCHAR(200) NOT NULL,
    "rank" INTEGER NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "confidentialite_pkey" PRIMARY KEY ("confidentialite_id")
);

-- Deux niveaux actifs de même rang rendraient la comparaison ambiguë. Index PARTIEL : un niveau
-- désactivé libère son rang, comme les autres référentiels du schéma (Prisma ne sait pas les
-- déclarer, d'où le raw SQL).
CREATE UNIQUE INDEX "confidentialite_rank_active_key"
  ON "confidentialite"("rank") WHERE "is_active";

CREATE UNIQUE INDEX "confidentialite_label_active_key"
  ON "confidentialite"(lower(replace("label", ' ', ''))) WHERE "is_active";

ALTER TABLE "confidentialite" ADD CONSTRAINT "ck_confidentialite_rank" CHECK ("rank" >= 0);

ALTER TABLE "document" ADD COLUMN "confidentialite_id" INTEGER;
ALTER TABLE "app_user" ADD COLUMN "confidentialite_id" INTEGER;

-- RESTRICT des deux côtés : supprimer un niveau encore porté par un document ou une habilitation
-- retirerait silencieusement une restriction d'accès. On désactive un niveau, on ne le supprime pas.
ALTER TABLE "document"
  ADD CONSTRAINT "document_confidentialite_id_fkey"
  FOREIGN KEY ("confidentialite_id") REFERENCES "confidentialite"("confidentialite_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "app_user"
  ADD CONSTRAINT "app_user_confidentialite_id_fkey"
  FOREIGN KEY ("confidentialite_id") REFERENCES "confidentialite"("confidentialite_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "document_confidentialite_id_idx" ON "document"("confidentialite_id");
