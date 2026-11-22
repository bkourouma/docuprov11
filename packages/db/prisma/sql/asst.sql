-- ============================================================================
-- Assistant qui agit — objets SQL bruts non exprimables en Prisma : CHECK, index partiels,
-- déclencheurs (cycle de vie d'une proposition, contenu des messages append-only, garde de suppression).
-- Modèles : packages/db/prisma/models/asst.prisma. Miroir TS : packages/types/src/asst-*.ts.
--
-- Ce fichier est COPIÉ à l'identique dans la migration 20261122120000_add_assistant_foundations
-- (section « SQL brut ») : il sert de référence et se ré-exécute sans effet de bord si une base
-- créée par `prisma db push` a besoin de ces objets :
--   prisma db execute --file prisma/sql/asst.sql --schema prisma
-- Convention de nommage du repo : CHECK ck_*, index ix_*, déclencheurs asst_*.
-- Aucune instruction destructive : fonctions et déclencheurs sont CREATE OR REPLACE (PostgreSQL >= 14).
-- Vérification rejouable : prisma/sql/asst.checks.sql (BEGIN ... ROLLBACK).
-- ============================================================================

-- 1) asst_conversation ------------------------------------------------------
DO $$ BEGIN
  ALTER TABLE "asst_conversation" ADD CONSTRAINT "ck_asst_conversation_title"
    CHECK ("title" IS NULL OR btrim("title") <> '');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  -- Contexte de page : { route, subjectType?, subjectId? }.
  ALTER TABLE "asst_conversation" ADD CONSTRAINT "ck_asst_conversation_page_context"
    CHECK ("page_context" IS NULL OR jsonb_typeof("page_context") = 'object');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "asst_conversation" ADD CONSTRAINT "ck_asst_conversation_purge"
    CHECK ("purge_at" >= "created_at");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- Liste des échanges de l'utilisateur (les échanges masqués n'y figurent pas).
CREATE INDEX IF NOT EXISTS "ix_asst_conversation_user_active"
  ON "asst_conversation" ("user_id", "updated_at" DESC) WHERE "deleted_at" IS NULL;

-- 2) asst_message -----------------------------------------------------------
DO $$ BEGIN
  ALTER TABLE "asst_message" ADD CONSTRAINT "ck_asst_message_role" CHECK ("role" IN (0, 1));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "asst_message" ADD CONSTRAINT "ck_asst_message_content"
    CHECK (btrim("content") <> '' AND char_length("content") <= 20000);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "asst_message" ADD CONSTRAINT "ck_asst_message_position" CHECK ("position" >= 1);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "asst_message" ADD CONSTRAINT "ck_asst_message_tokens"
    CHECK (("prompt_tokens" IS NULL OR "prompt_tokens" >= 0)
       AND ("completion_tokens" IS NULL OR "completion_tokens" >= 0));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  -- Seul un message assistant (role = 1) porte des jetons ou un lien vers une décision IA.
  ALTER TABLE "asst_message" ADD CONSTRAINT "ck_asst_message_assistant_only"
    CHECK ("role" = 1 OR ("prompt_tokens" IS NULL AND "completion_tokens" IS NULL AND "ai_decision_id" IS NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Le contenu d'un message est APPEND-ONLY : rattachement, rôle, position et contenu ne changent jamais.
-- (Les jetons et le lien de décision IA restent modifiables : ils sont renseignés après la génération.)
CREATE OR REPLACE FUNCTION asst_message_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW."conversation_id" IS DISTINCT FROM OLD."conversation_id"
     OR NEW."role" IS DISTINCT FROM OLD."role"
     OR NEW."position" IS DISTINCT FROM OLD."position"
     OR NEW."content" IS DISTINCT FROM OLD."content" THEN
    RAISE EXCEPTION 'asst_message % : conversation_id, role, position et content sont immuables', OLD."asst_message_id"
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER "asst_message_immutable" BEFORE UPDATE ON "asst_message"
  FOR EACH ROW EXECUTE FUNCTION asst_message_immutable();

-- 3) asst_proposal ----------------------------------------------------------
DO $$ BEGIN
  ALTER TABLE "asst_proposal" ADD CONSTRAINT "ck_asst_proposal_status" CHECK ("status" BETWEEN 0 AND 5);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  -- Entre 1 et 5 actions par proposition.
  ALTER TABLE "asst_proposal" ADD CONSTRAINT "ck_asst_proposal_actions"
    CHECK (jsonb_typeof("actions") = 'array' AND jsonb_array_length("actions") BETWEEN 1 AND 5);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "asst_proposal" ADD CONSTRAINT "ck_asst_proposal_args_hash" CHECK ("args_hash" ~ '^[0-9a-f]{64}$');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "asst_proposal" ADD CONSTRAINT "ck_asst_proposal_summary"
    CHECK (btrim("summary") <> '' AND char_length("summary") <= 2000);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "asst_proposal" ADD CONSTRAINT "ck_asst_proposal_expiry" CHECK ("expires_at" > "created_at");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  -- Effets appliqués : objet JSON, et seulement pour une proposition appliquée (statut 2).
  ALTER TABLE "asst_proposal" ADD CONSTRAINT "ck_asst_proposal_result"
    CHECK ("result" IS NULL OR (jsonb_typeof("result") = 'object' AND "status" = 2));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  -- Date de confirmation <=> confirmée (1), appliquée (2) ou en échec (5).
  ALTER TABLE "asst_proposal" ADD CONSTRAINT "ck_asst_proposal_confirmed"
    CHECK (("confirmed_at" IS NOT NULL) = ("status" IN (1, 2, 5)));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  -- Date de clôture <=> appliquée (2), refusée (3), expirée (4) ou en échec (5).
  ALTER TABLE "asst_proposal" ADD CONSTRAINT "ck_asst_proposal_finished"
    CHECK (("finished_at" IS NOT NULL) = ("status" IN (2, 3, 4, 5)));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  -- Code d'erreur <=> échec (5) ; message d'erreur seulement en échec.
  ALTER TABLE "asst_proposal" ADD CONSTRAINT "ck_asst_proposal_error"
    CHECK ((("error_code" IS NOT NULL) = ("status" = 5))
       AND ("error_code" IS NULL OR "error_code" ~ '^[a-z0-9_.]+$')
       AND ("error_message" IS NULL OR "status" = 5));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "asst_proposal" ADD CONSTRAINT "ck_asst_proposal_row_version" CHECK ("row_version" >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- Job d'expiration : seules les propositions encore ouvertes (proposées ou confirmées) sont indexées.
CREATE INDEX IF NOT EXISTS "ix_asst_proposal_expiry"
  ON "asst_proposal" ("status", "expires_at") WHERE "status" IN (0, 1);

-- Une proposition naît TOUJOURS « proposée » : aucun état, résultat ni erreur pré-renseigné.
CREATE OR REPLACE FUNCTION asst_proposal_guard_insert() RETURNS trigger AS $$
DECLARE
  v_msg_conversation bigint;
  v_user integer;
  v_group integer;
BEGIN
  IF NEW."status" <> 0 OR NEW."row_version" <> 0
     OR NEW."confirmed_at" IS NOT NULL OR NEW."finished_at" IS NOT NULL
     OR NEW."result" IS NOT NULL OR NEW."error_code" IS NOT NULL OR NEW."error_message" IS NOT NULL THEN
    RAISE EXCEPTION 'asst_proposal : une proposition naît à l''état proposée (status 0, row_version 0, sans date de confirmation/clôture, résultat ni erreur)'
      USING ERRCODE = 'check_violation';
  END IF;
  -- Cohérence des rattachements : le message appartient à la conversation, qui appartient à l'acteur.
  -- Un parent inexistant est laissé aux clés étrangères (erreur foreign_key_violation).
  SELECT "conversation_id" INTO v_msg_conversation FROM "asst_message" WHERE "asst_message_id" = NEW."message_id";
  IF FOUND AND v_msg_conversation <> NEW."conversation_id" THEN
    RAISE EXCEPTION 'asst_proposal : le message % n''appartient pas à la conversation %', NEW."message_id", NEW."conversation_id"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT "user_id", "user_group_id" INTO v_user, v_group FROM "asst_conversation"
    WHERE "asst_conversation_id" = NEW."conversation_id";
  IF FOUND AND (v_user <> NEW."user_id" OR v_group <> NEW."user_group_id") THEN
    RAISE EXCEPTION 'asst_proposal : user_id et user_group_id doivent être ceux de la conversation %', NEW."conversation_id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER "asst_proposal_guard_insert" BEFORE INSERT ON "asst_proposal"
  FOR EACH ROW EXECUTE FUNCTION asst_proposal_guard_insert();

-- Cycle de vie : 0 proposée -> 1 confirmée | 3 refusée | 4 expirée ; 1 confirmée -> 2 appliquée | 5 échec.
-- États terminaux (2, 3, 4, 5) : ligne figée. Contenu de la proposition immuable. Une proposition
-- expirée ne se confirme pas ; on n'expire pas avant l'heure. Sans changement de statut, seuls
-- row_version et updated_at (verrou optimiste, horodatage) peuvent bouger.
CREATE OR REPLACE FUNCTION asst_proposal_guard() RETURNS trigger AS $$
BEGIN
  IF OLD."status" IN (2, 3, 4, 5) THEN
    RAISE EXCEPTION 'asst_proposal % : proposition clôturée (statut %) : figée', OLD."asst_proposal_id", OLD."status"
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW."conversation_id" IS DISTINCT FROM OLD."conversation_id"
     OR NEW."message_id" IS DISTINCT FROM OLD."message_id"
     OR NEW."user_id" IS DISTINCT FROM OLD."user_id"
     OR NEW."user_group_id" IS DISTINCT FROM OLD."user_group_id"
     OR NEW."actions" IS DISTINCT FROM OLD."actions"
     OR NEW."args_hash" IS DISTINCT FROM OLD."args_hash"
     OR NEW."summary" IS DISTINCT FROM OLD."summary"
     OR NEW."expires_at" IS DISTINCT FROM OLD."expires_at"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'asst_proposal % : rattachements, acteurs, actions, args_hash, summary, expires_at et created_at sont immuables', OLD."asst_proposal_id"
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW."row_version" < OLD."row_version" THEN
    RAISE EXCEPTION 'asst_proposal % : row_version ne peut pas décroître (% -> %)', OLD."asst_proposal_id", OLD."row_version", NEW."row_version"
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."status" = OLD."status" THEN
    IF NEW."confirmed_at" IS DISTINCT FROM OLD."confirmed_at"
       OR NEW."finished_at" IS DISTINCT FROM OLD."finished_at"
       OR NEW."result" IS DISTINCT FROM OLD."result"
       OR NEW."error_code" IS DISTINCT FROM OLD."error_code"
       OR NEW."error_message" IS DISTINCT FROM OLD."error_message" THEN
      RAISE EXCEPTION 'asst_proposal % : sans changement de statut, seuls row_version et updated_at peuvent changer', OLD."asst_proposal_id"
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NOT ((OLD."status" = 0 AND NEW."status" IN (1, 3, 4))
          OR (OLD."status" = 1 AND NEW."status" IN (2, 5))) THEN
    RAISE EXCEPTION 'asst_proposal % : transition de statut illégale (% -> %)', OLD."asst_proposal_id", OLD."status", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD."status" = 0 AND NEW."status" = 1 AND OLD."expires_at" <= now() THEN
    RAISE EXCEPTION 'asst_proposal % : proposition expirée, confirmation refusée', OLD."asst_proposal_id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."status" = 0 AND NEW."status" = 4 AND OLD."expires_at" > now() THEN
    RAISE EXCEPTION 'asst_proposal % : proposition non échue, expiration refusée', OLD."asst_proposal_id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER "asst_proposal_guard" BEFORE UPDATE ON "asst_proposal"
  FOR EACH ROW EXECUTE FUNCTION asst_proposal_guard();

-- Suppression directe : refusée pour une proposition confirmée (exécution en cours) ; refusée pour une
-- proposition appliquée (2) ou en échec (5), qui est une trace d'exécution, SAUF si sa conversation a
-- déjà disparu (purge en cascade : la ligne parente est supprimée avant que la cascade ne s'exécute).
CREATE OR REPLACE FUNCTION asst_proposal_guard_delete() RETURNS trigger AS $$
BEGIN
  IF OLD."status" = 1 THEN
    RAISE EXCEPTION 'asst_proposal % : proposition confirmée (exécution en cours), suppression refusée', OLD."asst_proposal_id"
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."status" IN (2, 5) AND EXISTS (
       SELECT 1 FROM "asst_conversation" WHERE "asst_conversation_id" = OLD."conversation_id") THEN
    RAISE EXCEPTION 'asst_proposal % : trace d''exécution (statut %), suppression directe refusée (seule la purge de la conversation l''emporte)', OLD."asst_proposal_id", OLD."status"
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER "asst_proposal_guard_delete" BEFORE DELETE ON "asst_proposal"
  FOR EACH ROW EXECUTE FUNCTION asst_proposal_guard_delete();

-- Une conversation dont une proposition est confirmée (exécution en cours) ne se supprime pas ; une
-- conversation portant une trace d'exécution (proposition appliquée ou en échec) non plus, tant que
-- purge_at n'est pas échue (le masquage par l'utilisateur ramène purge_at à now() : la purge est alors permise).
CREATE OR REPLACE FUNCTION asst_conversation_guard_delete() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "asst_proposal"
             WHERE "conversation_id" = OLD."asst_conversation_id" AND "status" = 1) THEN
    RAISE EXCEPTION 'asst_conversation % : une proposition est en cours d''exécution, suppression refusée', OLD."asst_conversation_id"
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."purge_at" > now() AND EXISTS (SELECT 1 FROM "asst_proposal"
             WHERE "conversation_id" = OLD."asst_conversation_id" AND "status" IN (2, 5)) THEN
    RAISE EXCEPTION 'asst_conversation % : trace d''exécution conservée jusqu''à purge_at, suppression refusée', OLD."asst_conversation_id"
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER "asst_conversation_guard_delete" BEFORE DELETE ON "asst_conversation"
  FOR EACH ROW EXECUTE FUNCTION asst_conversation_guard_delete();

-- Propriétaire et date de création d'une conversation ne changent jamais.
CREATE OR REPLACE FUNCTION asst_conversation_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW."user_id" IS DISTINCT FROM OLD."user_id"
     OR NEW."user_group_id" IS DISTINCT FROM OLD."user_group_id"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'asst_conversation % : user_id, user_group_id et created_at sont immuables', OLD."asst_conversation_id"
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER "asst_conversation_immutable" BEFORE UPDATE ON "asst_conversation"
  FOR EACH ROW EXECUTE FUNCTION asst_conversation_immutable();

-- TRUNCATE interdit (contourne les déclencheurs de ligne) : conversations, messages et propositions.
-- Le propriétaire de la base peut techniquement supprimer ces déclencheurs (barrière applicative forte).
CREATE OR REPLACE FUNCTION asst_no_truncate() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% : TRUNCATE refusé (supprimer par DELETE, purge de conversation)', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER "asst_conversation_no_truncate" BEFORE TRUNCATE ON "asst_conversation"
  FOR EACH STATEMENT EXECUTE FUNCTION asst_no_truncate();
CREATE OR REPLACE TRIGGER "asst_message_no_truncate" BEFORE TRUNCATE ON "asst_message"
  FOR EACH STATEMENT EXECUTE FUNCTION asst_no_truncate();
CREATE OR REPLACE TRIGGER "asst_proposal_no_truncate" BEFORE TRUNCATE ON "asst_proposal"
  FOR EACH STATEMENT EXECUTE FUNCTION asst_no_truncate();

-- 4) asst_user_budget -------------------------------------------------------
-- Pas de CHECK « consommé <= plafond » : le règlement (settle) peut dépasser légèrement l'estimation
-- de la réservation (même principe que wf_budget). Le plafond est contrôlé par l'application.
DO $$ BEGIN
  ALTER TABLE "asst_user_budget" ADD CONSTRAINT "ck_asst_user_budget_consumed"
    CHECK ("consumed_amount" >= 0 AND "consumed_tokens" >= 0 AND "call_count" >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "asst_user_budget" ADD CONSTRAINT "ck_asst_user_budget_caps"
    CHECK (("cap_amount" IS NULL OR "cap_amount" >= 0) AND ("cap_tokens" IS NULL OR "cap_tokens" >= 0));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
