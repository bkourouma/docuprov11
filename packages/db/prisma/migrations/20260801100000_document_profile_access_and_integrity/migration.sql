-- Onglets « Accès par Profil » et « Sécurité et conformité » de la consultation d'un document.
-- Modèles : packages/db/prisma/models/security.prisma (`DocumentPermission`)
--           packages/db/prisma/models/core.prisma (`Document`, `DocumentFile`)
--
-- Portage des deux derniers onglets du `DocumentViewer` du module source. Additive : aucune
-- colonne existante n'est supprimée ni renommée, et le seul assouplissement (`user_group_id`
-- devient nullable) n'invalide aucune ligne en place.
--
-- ===========================================================================
-- 1. Droits accordés à un PROFIL sur un document (« Accès par Profil »)
-- ===========================================================================
--
-- `document_permission` ne savait viser qu'un acteur nommé. On lui ajoute `group_id`, sur le
-- modèle EXACT de `document_type_permission` (qui porte déjà les deux axes depuis l'init) :
-- exactement un des deux est renseigné, garanti par un CHECK de même forme.

ALTER TABLE "document_permission" ADD COLUMN "group_id" INTEGER;

-- Un droit « profil » n'a pas d'acteur nommé : la colonne doit pouvoir être vide.
ALTER TABLE "document_permission" ALTER COLUMN "user_group_id" DROP NOT NULL;

ALTER TABLE "document_permission"
  ADD CONSTRAINT "document_permission_group_id_fkey"
  FOREIGN KEY ("group_id") REFERENCES "app_group"("group_id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Même invariant que `ck_dtp_grantee` : un droit vise UN bénéficiaire, jamais zéro ni deux.
ALTER TABLE "document_permission"
  ADD CONSTRAINT "ck_dp_grantee" CHECK (("group_id" IS NULL) <> ("user_group_id" IS NULL));

CREATE INDEX "document_permission_document_id_group_id_idx"
  ON "document_permission"("document_id", "group_id");

-- L'unique existant (document, user_group, niveau) laisse passer les doublons de profil : ses
-- lignes « profil » ont `user_group_id` NULL, et Postgres tient deux NULL pour distincts. D'où
-- cet index PARTIEL, qui porte l'unicité du côté profil. Prisma ne sait pas déclarer un index
-- partiel : il reste donc en raw SQL, comme les autres du schéma.
CREATE UNIQUE INDEX "document_permission_document_id_group_id_permission_level_key"
  ON "document_permission"("document_id", "group_id", "permission_level_id")
  WHERE "group_id" IS NOT NULL;

-- ===========================================================================
-- 2. Intégrité des binaires (« Sécurité et conformité »)
-- ===========================================================================
--
-- L'empreinte est portée par le FICHIER (c'est le binaire qui en a une, et un document peut en
-- compter plusieurs) ; le verdict de la dernière vérification est porté par le DOCUMENT, car
-- c'est à son échelle que l'écran répond « ce document est-il intact ? ».
--
-- Nullable partout, à dessein : le fonds déjà numérisé n'a pas d'empreinte, et c'est la première
-- vérification qui la POSE (empreinte de référence) avant de pouvoir comparer quoi que ce soit.
-- Un `NOT NULL DEFAULT ''` aurait fabriqué de fausses empreintes indistinguables des vraies.

ALTER TABLE "document_file" ADD COLUMN "hash" VARCHAR(64);
ALTER TABLE "document_file" ADD COLUMN "hash_computed_at" TIMESTAMPTZ(0);

ALTER TABLE "document" ADD COLUMN "date_last_verified" TIMESTAMPTZ(0);
ALTER TABLE "document" ADD COLUMN "integrity_ok" BOOLEAN;

-- Empreinte SHA-256 en hexadécimal : 64 caractères, minuscules. Le CHECK empêche qu'un autre
-- algorithme (ou une empreinte tronquée) s'y glisse sans que le schéma le dise.
ALTER TABLE "document_file"
  ADD CONSTRAINT "ck_document_file_hash_sha256"
  CHECK ("hash" IS NULL OR "hash" ~ '^[0-9a-f]{64}$');
