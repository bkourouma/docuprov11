-- Retrait du champ « Observations » de l'écran « Cycles de vie des documents ».
--
-- Ne touche QUE `document_type_life_cycle.observations` (la règle par TYPE, seule table de cet
-- écran). `document_life_cycle.observations` (le cycle de vie propre à UN document, saisi depuis
-- la visionneuse — écran distinct) n'est PAS concerné et reste inchangé.
--
-- AUCUNE DONNÉE PERDUE : la table `document_type_life_cycle` est vide (0 ligne) à la date de
-- cette migration ; la colonne n'a jamais porté de valeur.
--
-- Les durées (`usefulness_lifespan`, `compliance_lifespan`) restent stockées en MOIS — seule la
-- présentation de l'écran passe en années, à la frontière du client web (voir archives.prisma).
-- Aucune migration de données n'est donc nécessaire sur ces deux colonnes.

ALTER TABLE "document_type_life_cycle" DROP COLUMN IF EXISTS "observations";
