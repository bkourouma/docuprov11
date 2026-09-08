-- Cachet serveur d'un document : signature électronique + horodatage.
-- Modèle : packages/db/prisma/models/core.prisma (`DocumentSeal`).
--
-- Complète l'onglet « Sécurité et conformité », dont la migration précédente n'apportait que
-- l'empreinte des binaires. L'empreinte répond à « ce fichier a-t-il changé ? » ; le cachet
-- répond à « QUI l'atteste, et À QUELLE DATE ? » — ce que le module source affichait en dur.
--
-- Ce que ce cachet est, exactement :
--  - une signature Ed25519 produite par la CLÉ DE L'INSTALLATION sur une charge qui contient les
--    empreintes des binaires ET la date de scellement ;
--  - un horodatage INTERNE : la date étant dans la charge signée, la retoucher après coup casse
--    la signature — contrairement à une simple colonne date, modifiable sans trace.
--
-- Ce qu'il n'est PAS : un horodatage QUALIFIÉ au sens eIDAS. Celui-ci exige un jeton RFC 3161
-- délivré par une autorité tierce, seule à pouvoir attester la date face à l'exploitant lui-même.
-- La colonne `algorithm` et l'absence d'unicité sur `key_fingerprint` laissent la place à un
-- second type de cachet (jeton TSA) sans nouvelle migration.
--
-- Une seule ligne par document (`UNIQUE`) : re-sceller remplace, l'historique des scellements
-- vivant dans le journal d'audit.

CREATE TABLE "document_seal" (
    "document_seal_id" SERIAL NOT NULL,
    "document_id" INTEGER NOT NULL,
    "algorithm" VARCHAR(32) NOT NULL,
    "key_fingerprint" VARCHAR(64) NOT NULL,
    "payload" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "sealed_at" TIMESTAMPTZ(0) NOT NULL,
    "sealed_by" INTEGER,

    CONSTRAINT "document_seal_pkey" PRIMARY KEY ("document_seal_id")
);

CREATE UNIQUE INDEX "document_seal_document_id_key" ON "document_seal"("document_id");

ALTER TABLE "document_seal"
  ADD CONSTRAINT "document_seal_document_id_fkey"
  FOREIGN KEY ("document_id") REFERENCES "document"("document_id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Même garde que sur `document_file.hash` : l'empreinte de clé est un SHA-256 hexadécimal.
ALTER TABLE "document_seal"
  ADD CONSTRAINT "ck_document_seal_key_fingerprint"
  CHECK ("key_fingerprint" ~ '^[0-9a-f]{64}$');
