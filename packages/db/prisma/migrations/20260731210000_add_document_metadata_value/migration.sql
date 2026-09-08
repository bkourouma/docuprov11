-- Docu-Archives — VALEURS des métadonnées saisies sur un document.
-- Modèle : packages/db/prisma/models/archives.prisma (`DocumentMetadataValue`).
--
-- Pourquoi cette table : `metadata_document_type` ne dit que QUELS champs proposer pour QUEL type
-- de document — c'est de la configuration. Rien ne permettait jusqu'ici de stocker la VALEUR de
-- ces champs (« Montant = 5000 » sur le document #42), ce qui bloquait le formulaire dynamique de
-- l'étape « Indexation » de l'acquisition.
--
-- Migration écrite À LA MAIN comme celles du lot Docu-Archives, et ADDITIVE uniquement : aucune
-- table ni colonne existante n'est modifiée, supprimée ou renommée.
--
-- Choix de modélisation :
--  - une seule colonne `value` TEXT pour toutes les saisies, normalisées par le serveur selon le
--    `data_type` de la métadonnée (entier en base 10, date ISO AAAA-MM-JJ, booléen true/false) :
--    typer par colonne n'apporterait rien tant qu'aucun écran ne trie ni ne filtre là-dessus ;
--  - sauf pour les métadonnées de type Liste (`data_type = 6`), qui référencent l'élément choisi
--    par clé étrangère — seul cas où un libellé recopié pourrait diverger du référentiel ;
--  - ON DELETE RESTRICT sur `metadata_list_item` : l'écran « Éléments de listes » DÉSACTIVE
--    (is_active = false) au lieu de supprimer, donc ce garde-fou ne bloque aucun geste applicatif
--    et protège seulement contre un DELETE manuel qui laisserait des valeurs orphelines ;
--  - CHECK « au moins une des deux colonnes renseignée » : un champ vidé supprime sa ligne, pour
--    qu'« absent » et « vide » ne soient pas deux états distincts à traiter côté écran.

CREATE TABLE "document_metadata_value" (
    "document_metadata_value_id" SERIAL NOT NULL,
    "document_id" INTEGER NOT NULL,
    "metadata_id" INTEGER NOT NULL,
    "value" TEXT,
    "metadata_list_item_id" INTEGER,

    CONSTRAINT "document_metadata_value_pkey" PRIMARY KEY ("document_metadata_value_id")
);

-- Une valeur au plus par (document, métadonnée) : la saisie remplace, elle n'empile pas.
CREATE UNIQUE INDEX "document_metadata_value_document_id_metadata_id_key"
  ON "document_metadata_value"("document_id", "metadata_id");

CREATE INDEX "document_metadata_value_metadata_id_idx"
  ON "document_metadata_value"("metadata_id");

ALTER TABLE "document_metadata_value"
  ADD CONSTRAINT "document_metadata_value_document_id_fkey"
  FOREIGN KEY ("document_id") REFERENCES "document"("document_id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "document_metadata_value"
  ADD CONSTRAINT "document_metadata_value_metadata_id_fkey"
  FOREIGN KEY ("metadata_id") REFERENCES "metadata"("metadata_id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "document_metadata_value"
  ADD CONSTRAINT "document_metadata_value_metadata_list_item_id_fkey"
  FOREIGN KEY ("metadata_list_item_id") REFERENCES "metadata_list_item"("metadata_list_item_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "document_metadata_value"
  ADD CONSTRAINT "document_metadata_value_not_empty"
  CHECK ("value" IS NOT NULL OR "metadata_list_item_id" IS NOT NULL);
