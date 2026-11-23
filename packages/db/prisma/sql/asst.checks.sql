-- ============================================================================
-- Assistant qui agit — vérification rejouable des contraintes et déclencheurs de asst.sql.
-- Prérequis : les 4 tables asst_* et le SQL brut (migration 20261122120000_add_assistant_foundations).
-- Exécution (le script s'arrête à la première erreur, puis ANNULE tout : aucune donnée n'est conservée) :
--   psql -v ON_ERROR_STOP=1 -f packages/db/prisma/sql/asst.checks.sql <base>
-- Chaque cas affiche « OK : ... » ; à la fin « TOUS LES CAS PASSENT ». Un écart lève une exception.
-- Doit être exécuté par le propriétaire des tables (il désactive temporairement les déclencheurs
-- UTILISATEUR, dans la transaction, pour prouver les CHECK indépendamment des déclencheurs).
-- ============================================================================
\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = notice;

BEGIN;

CREATE TEMP TABLE asst_check_counter (n int NOT NULL);
INSERT INTO asst_check_counter VALUES (0);

-- Exécute `stmt` : doit réussir.
CREATE FUNCTION pg_temp.expect_ok(label text, stmt text) RETURNS void AS $$
DECLARE rc bigint;
BEGIN
  EXECUTE stmt;
  GET DIAGNOSTICS rc = ROW_COUNT;
  IF rc = 0 THEN
    RAISE EXCEPTION 'ECHEC : % : l''instruction n''a touché aucune ligne', label;
  END IF;
  UPDATE asst_check_counter SET n = n + 1;
  RAISE NOTICE 'OK : %', label;
END;
$$ LANGUAGE plpgsql;

-- Exécute `stmt` : doit être refusé avec le SQLSTATE attendu (23514 check, 23001 restrict, 23505 unique...).
CREATE FUNCTION pg_temp.expect_error(label text, stmt text, expected_state text) RETURNS void AS $$
BEGIN
  BEGIN
    EXECUTE stmt;
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE <> expected_state THEN
      RAISE EXCEPTION 'ECHEC : % : SQLSTATE % reçu, % attendu (%)', label, SQLSTATE, expected_state, SQLERRM;
    END IF;
    UPDATE asst_check_counter SET n = n + 1;
    RAISE NOTICE 'OK : % (refusé : %)', label, SQLERRM;
    RETURN;
  END;
  RAISE EXCEPTION 'ECHEC : % aurait dû être refusé', label;
END;
$$ LANGUAGE plpgsql;

-- Vérité attendue : lève une exception si `cond` est faux.
CREATE FUNCTION pg_temp.expect_true(label text, cond boolean) RETURNS void AS $$
BEGIN
  IF cond IS NOT TRUE THEN
    RAISE EXCEPTION 'ECHEC : %', label;
  END IF;
  UPDATE asst_check_counter SET n = n + 1;
  RAISE NOTICE 'OK : %', label;
END;
$$ LANGUAGE plpgsql;

-- Crée une proposition « proposée » (conversation 900001, message assistant 900002).
-- `delta` : échéance relative à maintenant (négatif = déjà échue ; la date de création est 2 h dans le passé).
CREATE FUNCTION pg_temp.mkprop(pid bigint, delta interval DEFAULT '1 hour') RETURNS void AS $$
BEGIN
  INSERT INTO "asst_proposal" ("asst_proposal_id", "conversation_id", "message_id", "user_id", "user_group_id",
                               "actions", "summary", "args_hash", "created_at", "expires_at")
  VALUES (pid, 900001, 900002, 9001, 9101, '[{"type":"x"}]'::jsonb, 'Résumé', repeat('a', 64),
          now() - interval '2 hours', now() + delta);
END;
$$ LANGUAGE plpgsql;

-- Jeu d'essai --------------------------------------------------------------------------------------
INSERT INTO "asst_conversation" ("asst_conversation_id", "user_id", "user_group_id", "title", "page_context")
VALUES (900001, 9001, 9101, 'Essai', '{"route":"/documents"}');
INSERT INTO "asst_message" ("asst_message_id", "conversation_id", "role", "content", "position")
VALUES (900001, 900001, 0, 'Bonjour', 1);
INSERT INTO "asst_message" ("asst_message_id", "conversation_id", "role", "content", "position", "prompt_tokens", "completion_tokens", "ai_decision_id")
VALUES (900002, 900001, 1, 'Je propose une action', 2, 10, 20, 12345);

-- ===========================================================================
-- A. asst_conversation
-- ===========================================================================
SELECT pg_temp.expect_true('conversation : purge_at par défaut = création + 90 jours',
  (SELECT "purge_at" - "created_at" BETWEEN interval '89 days 23 hours' AND interval '90 days 1 hour'
     FROM "asst_conversation" WHERE "asst_conversation_id" = 900001));
SELECT pg_temp.expect_error('conversation : titre vide refusé',
  $q$INSERT INTO "asst_conversation" ("user_id","user_group_id","title") VALUES (1,1,'   ')$q$, '23514');
SELECT pg_temp.expect_error('conversation : page_context non objet refusé',
  $q$INSERT INTO "asst_conversation" ("user_id","user_group_id","page_context") VALUES (1,1,'[1]'::jsonb)$q$, '23514');
SELECT pg_temp.expect_error('conversation : purge_at avant created_at refusé',
  $q$INSERT INTO "asst_conversation" ("user_id","user_group_id","purge_at") VALUES (1,1, now() - interval '1 day')$q$, '23514');
SELECT pg_temp.expect_ok('conversation : masquage (deleted_at + purge_at = now()) accepté',
  $q$UPDATE "asst_conversation" SET "deleted_at" = now(), "purge_at" = now() WHERE "asst_conversation_id" = 900001$q$);
SELECT pg_temp.expect_error('conversation : user_id immuable',
  $q$UPDATE "asst_conversation" SET "user_id" = 9002 WHERE "asst_conversation_id" = 900001$q$, '23001');
SELECT pg_temp.expect_error('conversation : user_group_id immuable',
  $q$UPDATE "asst_conversation" SET "user_group_id" = 9102 WHERE "asst_conversation_id" = 900001$q$, '23001');
SELECT pg_temp.expect_error('conversation : created_at immuable',
  $q$UPDATE "asst_conversation" SET "created_at" = now() - interval '1 day' WHERE "asst_conversation_id" = 900001$q$, '23001');
SELECT pg_temp.expect_ok('conversation : title, page_context, last_message_at, updated_at modifiables',
  $q$UPDATE "asst_conversation" SET "title" = 'Nouveau titre', "page_context" = '{"route":"/x"}', "last_message_at" = now(), "updated_at" = now() WHERE "asst_conversation_id" = 900001$q$);
UPDATE "asst_conversation" SET "deleted_at" = NULL, "purge_at" = now() + interval '90 days' WHERE "asst_conversation_id" = 900001;

-- ===========================================================================
-- B. asst_message
-- ===========================================================================
SELECT pg_temp.expect_error('message : contenu vide refusé',
  $q$INSERT INTO "asst_message" ("conversation_id","role","content","position") VALUES (900001,0,' ',10)$q$, '23514');
SELECT pg_temp.expect_error('message : contenu > 20000 caractères refusé',
  $q$INSERT INTO "asst_message" ("conversation_id","role","content","position") VALUES (900001,0,repeat('x',20001),10)$q$, '23514');
SELECT pg_temp.expect_ok('message : contenu de 20000 caractères accepté',
  $q$INSERT INTO "asst_message" ("conversation_id","role","content","position") VALUES (900001,0,repeat('x',20000),10)$q$);
SELECT pg_temp.expect_error('message : rôle 2 refusé',
  $q$INSERT INTO "asst_message" ("conversation_id","role","content","position") VALUES (900001,2,'a',11)$q$, '23514');
SELECT pg_temp.expect_error('message : position 0 refusée',
  $q$INSERT INTO "asst_message" ("conversation_id","role","content","position") VALUES (900001,0,'a',0)$q$, '23514');
SELECT pg_temp.expect_error('message : unique (conversation_id, position)',
  $q$INSERT INTO "asst_message" ("conversation_id","role","content","position") VALUES (900001,0,'doublon',1)$q$, '23505');
SELECT pg_temp.expect_error('message : jetons sur un message utilisateur refusés',
  $q$INSERT INTO "asst_message" ("conversation_id","role","content","position","prompt_tokens") VALUES (900001,0,'a',12,5)$q$, '23514');
SELECT pg_temp.expect_error('message : lien de décision IA sur un message utilisateur refusé',
  $q$INSERT INTO "asst_message" ("conversation_id","role","content","position","ai_decision_id") VALUES (900001,0,'a',12,7)$q$, '23514');
SELECT pg_temp.expect_error('message : jetons négatifs refusés',
  $q$INSERT INTO "asst_message" ("conversation_id","role","content","position","prompt_tokens") VALUES (900001,1,'a',12,-1)$q$, '23514');
SELECT pg_temp.expect_error('message : conversation inexistante refusée (FK)',
  $q$INSERT INTO "asst_message" ("conversation_id","role","content","position") VALUES (999999,0,'a',1)$q$, '23503');
SELECT pg_temp.expect_error('message : content immuable',
  $q$UPDATE "asst_message" SET "content" = 'modifié' WHERE "asst_message_id" = 900001$q$, '23001');
SELECT pg_temp.expect_error('message : role immuable',
  $q$UPDATE "asst_message" SET "role" = 1 WHERE "asst_message_id" = 900001$q$, '23001');
SELECT pg_temp.expect_error('message : position immuable',
  $q$UPDATE "asst_message" SET "position" = 50 WHERE "asst_message_id" = 900001$q$, '23001');
SELECT pg_temp.expect_ok('conversation de rechange pour le test de conversation_id',
  $q$INSERT INTO "asst_conversation" ("asst_conversation_id","user_id","user_group_id") VALUES (900009,9001,9101)$q$);
SELECT pg_temp.expect_error('message : conversation_id immuable',
  $q$UPDATE "asst_message" SET "conversation_id" = 900009 WHERE "asst_message_id" = 900001$q$, '23001');
SELECT pg_temp.expect_ok('message assistant : jetons modifiables',
  $q$UPDATE "asst_message" SET "completion_tokens" = 25 WHERE "asst_message_id" = 900002$q$);

-- ===========================================================================
-- C. asst_proposal : naissance
-- ===========================================================================
SELECT pg_temp.expect_ok('proposition valide insérée (statut 0)', $q$SELECT pg_temp.mkprop(1)$q$);
SELECT pg_temp.expect_true('proposition : row_version 0 et statut 0 à la naissance',
  (SELECT "status" = 0 AND "row_version" = 0 FROM "asst_proposal" WHERE "asst_proposal_id" = 1));
SELECT pg_temp.expect_error('insertion avec status <> 0 refusée',
  $q$INSERT INTO "asst_proposal" ("conversation_id","message_id","user_id","user_group_id","status","actions","summary","args_hash","expires_at","confirmed_at")
     VALUES (900001,900002,9001,9101,1,'[{"type":"x"}]','R',repeat('a',64),now() + interval '1 hour', now())$q$, '23514');
SELECT pg_temp.expect_error('insertion avec row_version <> 0 refusée',
  $q$INSERT INTO "asst_proposal" ("conversation_id","message_id","user_id","user_group_id","row_version","actions","summary","args_hash","expires_at")
     VALUES (900001,900002,9001,9101,3,'[{"type":"x"}]','R',repeat('a',64),now() + interval '1 hour')$q$, '23514');
SELECT pg_temp.expect_error('insertion avec résultat pré-renseigné refusée',
  $q$INSERT INTO "asst_proposal" ("conversation_id","message_id","user_id","user_group_id","actions","summary","args_hash","expires_at","result")
     VALUES (900001,900002,9001,9101,'[{"type":"x"}]','R',repeat('a',64),now() + interval '1 hour','{"effects":[]}')$q$, '23514');
SELECT pg_temp.expect_error('insertion : message d''une autre conversation refusée',
  $q$INSERT INTO "asst_proposal" ("conversation_id","message_id","user_id","user_group_id","actions","summary","args_hash","expires_at")
     VALUES (900009,900002,9001,9101,'[{"type":"x"}]','R',repeat('a',64),now() + interval '1 hour')$q$, '23514');
SELECT pg_temp.expect_error('insertion : user_id différent de celui de la conversation refusé',
  $q$INSERT INTO "asst_proposal" ("conversation_id","message_id","user_id","user_group_id","actions","summary","args_hash","expires_at")
     VALUES (900001,900002,9002,9101,'[{"type":"x"}]','R',repeat('a',64),now() + interval '1 hour')$q$, '23514');
SELECT pg_temp.expect_error('insertion : user_group_id différent de celui de la conversation refusé',
  $q$INSERT INTO "asst_proposal" ("conversation_id","message_id","user_id","user_group_id","actions","summary","args_hash","expires_at")
     VALUES (900001,900002,9001,9102,'[{"type":"x"}]','R',repeat('a',64),now() + interval '1 hour')$q$, '23514');
SELECT pg_temp.expect_error('proposition : message inexistant refusé (FK)',
  $q$INSERT INTO "asst_proposal" ("conversation_id","message_id","user_id","user_group_id","actions","summary","args_hash","expires_at")
     VALUES (900001,999999,9001,9101,'[{"type":"x"}]','R',repeat('a',64),now() + interval '1 hour')$q$, '23503');

-- ===========================================================================
-- D. asst_proposal : transitions
-- ===========================================================================
SELECT pg_temp.expect_ok('transition 0 -> 0 (row_version seul) acceptée',
  $q$UPDATE "asst_proposal" SET "row_version" = "row_version" + 1, "updated_at" = now() WHERE "asst_proposal_id" = 1$q$);
SELECT pg_temp.expect_ok('row_version croissant accepté (0 -> 5)',
  $q$UPDATE "asst_proposal" SET "row_version" = 5 WHERE "asst_proposal_id" = 1$q$);
SELECT pg_temp.expect_ok('row_version égal accepté',
  $q$UPDATE "asst_proposal" SET "row_version" = 5 WHERE "asst_proposal_id" = 1$q$);
SELECT pg_temp.expect_error('row_version décroissant refusé',
  $q$UPDATE "asst_proposal" SET "row_version" = 4 WHERE "asst_proposal_id" = 1$q$, '23514');
SELECT pg_temp.expect_ok('transition 0 -> 1 (confirmation) acceptée',
  $q$UPDATE "asst_proposal" SET "status" = 1, "confirmed_at" = now(), "row_version" = "row_version" + 1 WHERE "asst_proposal_id" = 1$q$);
SELECT pg_temp.expect_ok('transition 1 -> 1 (row_version seul) acceptée',
  $q$UPDATE "asst_proposal" SET "row_version" = "row_version" + 1 WHERE "asst_proposal_id" = 1$q$);
SELECT pg_temp.expect_error('1 -> 1 avec modification d''un autre champ (error_message) refusée',
  $q$UPDATE "asst_proposal" SET "error_message" = 'x' WHERE "asst_proposal_id" = 1$q$, '23001');
SELECT pg_temp.expect_error('transition 1 -> 3 (refus après confirmation) refusée',
  $q$UPDATE "asst_proposal" SET "status" = 3, "finished_at" = now() WHERE "asst_proposal_id" = 1$q$, '23514');
SELECT pg_temp.expect_error('transition 1 -> 4 refusée',
  $q$UPDATE "asst_proposal" SET "status" = 4, "finished_at" = now() WHERE "asst_proposal_id" = 1$q$, '23514');
SELECT pg_temp.expect_error('transition 1 -> 0 refusée',
  $q$UPDATE "asst_proposal" SET "status" = 0, "confirmed_at" = NULL WHERE "asst_proposal_id" = 1$q$, '23514');
SELECT pg_temp.expect_ok('transition 1 -> 2 (appliquée, avec résultat) acceptée',
  $q$UPDATE "asst_proposal" SET "status" = 2, "finished_at" = now(), "result" = '{"effects":[{"ok":true}]}' WHERE "asst_proposal_id" = 1$q$);
SELECT pg_temp.expect_error('proposition appliquée figée : UPDATE de row_version refusé',
  $q$UPDATE "asst_proposal" SET "row_version" = "row_version" + 1 WHERE "asst_proposal_id" = 1$q$, '23001');
SELECT pg_temp.expect_error('transition 2 -> 1 refusée (figée)',
  $q$UPDATE "asst_proposal" SET "status" = 1 WHERE "asst_proposal_id" = 1$q$, '23001');
SELECT pg_temp.expect_error('proposition appliquée figée : result non modifiable',
  $q$UPDATE "asst_proposal" SET "result" = '{"effects":[]}' WHERE "asst_proposal_id" = 1$q$, '23001');

SELECT pg_temp.mkprop(2);
SELECT pg_temp.expect_error('transition 0 -> 2 refusée',
  $q$UPDATE "asst_proposal" SET "status" = 2, "confirmed_at" = now(), "finished_at" = now(), "result" = '{"effects":[]}' WHERE "asst_proposal_id" = 2$q$, '23514');
SELECT pg_temp.expect_error('transition 0 -> 5 refusée',
  $q$UPDATE "asst_proposal" SET "status" = 5, "confirmed_at" = now(), "finished_at" = now(), "error_code" = 'x' WHERE "asst_proposal_id" = 2$q$, '23514');
SELECT pg_temp.expect_ok('transition 0 -> 3 (refus) acceptée',
  $q$UPDATE "asst_proposal" SET "status" = 3, "finished_at" = now() WHERE "asst_proposal_id" = 2$q$);
SELECT pg_temp.expect_error('transition 3 -> 1 refusée (terminal)',
  $q$UPDATE "asst_proposal" SET "status" = 1, "confirmed_at" = now(), "finished_at" = NULL WHERE "asst_proposal_id" = 2$q$, '23001');

SELECT pg_temp.mkprop(3);
UPDATE "asst_proposal" SET "status" = 1, "confirmed_at" = now() WHERE "asst_proposal_id" = 3;
SELECT pg_temp.expect_ok('transition 1 -> 5 (échec, code d''erreur) acceptée',
  $q$UPDATE "asst_proposal" SET "status" = 5, "finished_at" = now(), "error_code" = 'tool.failed', "error_message" = 'Échec' WHERE "asst_proposal_id" = 3$q$);
SELECT pg_temp.expect_error('transition 5 -> 2 refusée (terminal)',
  $q$UPDATE "asst_proposal" SET "status" = 2, "result" = '{"effects":[]}', "error_code" = NULL, "error_message" = NULL WHERE "asst_proposal_id" = 3$q$, '23001');

-- Champs immuables, même à statut inchangé
SELECT pg_temp.mkprop(4);
SELECT pg_temp.expect_error('actions immuables (statut inchangé)',
  $q$UPDATE "asst_proposal" SET "actions" = '[{"type":"y"}]' WHERE "asst_proposal_id" = 4$q$, '23001');
SELECT pg_temp.expect_error('args_hash immuable (statut inchangé)',
  $q$UPDATE "asst_proposal" SET "args_hash" = repeat('b', 64) WHERE "asst_proposal_id" = 4$q$, '23001');
SELECT pg_temp.expect_error('user_id immuable (statut inchangé)',
  $q$UPDATE "asst_proposal" SET "user_id" = 9002 WHERE "asst_proposal_id" = 4$q$, '23001');
SELECT pg_temp.expect_error('user_group_id immuable',
  $q$UPDATE "asst_proposal" SET "user_group_id" = 9102 WHERE "asst_proposal_id" = 4$q$, '23001');
SELECT pg_temp.expect_error('summary immuable',
  $q$UPDATE "asst_proposal" SET "summary" = 'autre' WHERE "asst_proposal_id" = 4$q$, '23001');
SELECT pg_temp.expect_error('expires_at immuable',
  $q$UPDATE "asst_proposal" SET "expires_at" = now() + interval '5 days' WHERE "asst_proposal_id" = 4$q$, '23001');
SELECT pg_temp.expect_error('message_id immuable',
  $q$UPDATE "asst_proposal" SET "message_id" = 900001 WHERE "asst_proposal_id" = 4$q$, '23001');
SELECT pg_temp.expect_error('conversation_id immuable',
  $q$UPDATE "asst_proposal" SET "conversation_id" = 900009 WHERE "asst_proposal_id" = 4$q$, '23001');
SELECT pg_temp.expect_error('actions immuables aussi lors d''une confirmation 0 -> 1',
  $q$UPDATE "asst_proposal" SET "status" = 1, "confirmed_at" = now(), "actions" = '[{"type":"z"}]' WHERE "asst_proposal_id" = 4$q$, '23001');

-- Expiration
SELECT pg_temp.mkprop(5, interval '-1 hour');
SELECT pg_temp.expect_error('confirmer une proposition expirée refusé',
  $q$UPDATE "asst_proposal" SET "status" = 1, "confirmed_at" = now() WHERE "asst_proposal_id" = 5$q$, '23514');
SELECT pg_temp.expect_ok('expirer une proposition échue (0 -> 4) accepté',
  $q$UPDATE "asst_proposal" SET "status" = 4, "finished_at" = now() WHERE "asst_proposal_id" = 5$q$);
SELECT pg_temp.mkprop(6, interval '1 hour');
SELECT pg_temp.expect_error('expirer avant l''heure refusé',
  $q$UPDATE "asst_proposal" SET "status" = 4, "finished_at" = now() WHERE "asst_proposal_id" = 6$q$, '23514');
SELECT pg_temp.expect_ok('refuser (0 -> 3) une proposition non échue accepté',
  $q$UPDATE "asst_proposal" SET "status" = 3, "finished_at" = now() WHERE "asst_proposal_id" = 6$q$);

-- ===========================================================================
-- E. asst_proposal : suppressions
-- ===========================================================================
SELECT pg_temp.expect_error('DELETE direct d''une proposition appliquée refusé',
  $q$DELETE FROM "asst_proposal" WHERE "asst_proposal_id" = 1$q$, '23001');
SELECT pg_temp.expect_error('DELETE direct d''une proposition en échec refusé',
  $q$DELETE FROM "asst_proposal" WHERE "asst_proposal_id" = 3$q$, '23001');
SELECT pg_temp.expect_ok('DELETE direct d''une proposition refusée accepté',
  $q$DELETE FROM "asst_proposal" WHERE "asst_proposal_id" = 2$q$);
SELECT pg_temp.expect_ok('DELETE direct d''une proposition proposée accepté',
  $q$DELETE FROM "asst_proposal" WHERE "asst_proposal_id" = 4$q$);
SELECT pg_temp.expect_error('DELETE du message d''une proposition appliquée refusé (cascade, conversation présente)',
  $q$DELETE FROM "asst_message" WHERE "asst_message_id" = 900002$q$, '23001');

-- Conversation 900002 : proposition confirmée => suppression refusée ; terminée => suppression en cascade.
INSERT INTO "asst_conversation" ("asst_conversation_id","user_id","user_group_id","created_at") VALUES (900002, 9001, 9101, now() - interval '1 day');
INSERT INTO "asst_message" ("asst_message_id","conversation_id","role","content","position") VALUES (900011, 900002, 1, 'a', 1);
INSERT INTO "asst_proposal" ("asst_proposal_id","conversation_id","message_id","user_id","user_group_id","actions","summary","args_hash","created_at","expires_at")
  SELECT g, 900002, 900011, 9001, 9101, '[{"type":"x"}]', 'R', repeat('a',64), now() - interval '2 hours', now() + interval '1 hour'
  FROM generate_series(21, 24) AS g;
UPDATE "asst_proposal" SET "status" = 1, "confirmed_at" = now() WHERE "asst_proposal_id" IN (21, 22, 23);
UPDATE "asst_proposal" SET "status" = 2, "finished_at" = now(), "result" = '{"effects":[]}' WHERE "asst_proposal_id" = 21;
UPDATE "asst_proposal" SET "status" = 5, "finished_at" = now(), "error_code" = 'boom' WHERE "asst_proposal_id" = 22;
UPDATE "asst_proposal" SET "status" = 3, "finished_at" = now() WHERE "asst_proposal_id" = 24;
-- 21 appliquée, 22 en échec, 23 confirmée, 24 refusée
SELECT pg_temp.expect_error('DELETE direct d''une proposition confirmée refusé',
  $q$DELETE FROM "asst_proposal" WHERE "asst_proposal_id" = 23$q$, '23001');
SELECT pg_temp.expect_error('DELETE de conversation refusé tant qu''une proposition est confirmée',
  $q$DELETE FROM "asst_conversation" WHERE "asst_conversation_id" = 900002$q$, '23001');
UPDATE "asst_proposal" SET "status" = 2, "finished_at" = now(), "result" = '{"effects":[]}' WHERE "asst_proposal_id" = 23;
SELECT pg_temp.expect_error('DELETE de conversation refusé avant purge_at (traces appliquée / échec)',
  $q$DELETE FROM "asst_conversation" WHERE "asst_conversation_id" = 900002$q$, '23001');
-- purge_at est TIMESTAMPTZ(0) : `now()` peut être arrondi à la seconde SUPÉRIEURE ; on se place franchement dans le passé.
UPDATE "asst_conversation" SET "deleted_at" = now(), "purge_at" = now() - interval '1 second' WHERE "asst_conversation_id" = 900002;
SELECT pg_temp.expect_ok('DELETE de conversation accepté une fois purge_at échue (cascade)',
  $q$DELETE FROM "asst_conversation" WHERE "asst_conversation_id" = 900002$q$);
SELECT pg_temp.expect_true('cascade : propositions appliquées / en échec / refusées et messages supprimés avec la conversation',
  NOT EXISTS (SELECT 1 FROM "asst_proposal" WHERE "conversation_id" = 900002)
  AND NOT EXISTS (SELECT 1 FROM "asst_message" WHERE "conversation_id" = 900002));

-- ===========================================================================
-- F. asst_proposal : CHECK (déclencheurs utilisateur désactivés dans la transaction)
-- ===========================================================================
SELECT pg_temp.mkprop(7);
ALTER TABLE "asst_proposal" DISABLE TRIGGER USER;
SELECT pg_temp.expect_error('CHECK : status 6 refusé',
  $q$UPDATE "asst_proposal" SET "status" = 6 WHERE "asst_proposal_id" = 7$q$, '23514');
SELECT pg_temp.expect_error('CHECK : row_version négatif refusé',
  $q$UPDATE "asst_proposal" SET "row_version" = -1 WHERE "asst_proposal_id" = 7$q$, '23514');
SELECT pg_temp.expect_error('CHECK : actions vide refusé',
  $q$UPDATE "asst_proposal" SET "actions" = '[]' WHERE "asst_proposal_id" = 7$q$, '23514');
SELECT pg_temp.expect_error('CHECK : actions de 6 éléments refusé',
  $q$UPDATE "asst_proposal" SET "actions" = '[1,2,3,4,5,6]' WHERE "asst_proposal_id" = 7$q$, '23514');
SELECT pg_temp.expect_error('CHECK : actions objet (non tableau) refusé',
  $q$UPDATE "asst_proposal" SET "actions" = '{"a":1}' WHERE "asst_proposal_id" = 7$q$, '23514');
SELECT pg_temp.expect_ok('CHECK : actions de 5 éléments accepté',
  $q$UPDATE "asst_proposal" SET "actions" = '[1,2,3,4,5]' WHERE "asst_proposal_id" = 1$q$);
SELECT pg_temp.expect_error('CHECK : args_hash trop court refusé',
  $q$UPDATE "asst_proposal" SET "args_hash" = 'abc' WHERE "asst_proposal_id" = 7$q$, '23514');
SELECT pg_temp.expect_error('CHECK : args_hash en majuscules refusé',
  $q$UPDATE "asst_proposal" SET "args_hash" = repeat('A', 64) WHERE "asst_proposal_id" = 7$q$, '23514');
SELECT pg_temp.expect_error('CHECK : summary vide refusé',
  $q$UPDATE "asst_proposal" SET "summary" = ' ' WHERE "asst_proposal_id" = 7$q$, '23514');
SELECT pg_temp.expect_error('CHECK : summary > 2000 caractères refusé',
  $q$UPDATE "asst_proposal" SET "summary" = repeat('x', 2001) WHERE "asst_proposal_id" = 7$q$, '23514');
SELECT pg_temp.expect_error('CHECK : expires_at <= created_at refusé',
  $q$UPDATE "asst_proposal" SET "expires_at" = "created_at" WHERE "asst_proposal_id" = 7$q$, '23514');
-- Propositions : 1 appliquée, 3 en échec, 5 expirée, 6 refusée, 7 proposée.
SELECT pg_temp.expect_error('CHECK : result sur statut <> 2 refusé',
  $q$UPDATE "asst_proposal" SET "result" = '{"effects":[]}' WHERE "asst_proposal_id" = 6$q$, '23514');
SELECT pg_temp.expect_error('CHECK : result non objet (statut 2) refusé',
  $q$UPDATE "asst_proposal" SET "result" = '[]' WHERE "asst_proposal_id" = 1$q$, '23514');
SELECT pg_temp.expect_error('CHECK : finished_at absent sur statut terminal refusé',
  $q$UPDATE "asst_proposal" SET "finished_at" = NULL WHERE "asst_proposal_id" = 6$q$, '23514');
SELECT pg_temp.expect_error('CHECK : finished_at renseigné sur statut 0 refusé',
  $q$UPDATE "asst_proposal" SET "finished_at" = now() WHERE "asst_proposal_id" = 7$q$, '23514');
SELECT pg_temp.expect_error('CHECK : confirmed_at absent sur statut 2 refusé',
  $q$UPDATE "asst_proposal" SET "confirmed_at" = NULL WHERE "asst_proposal_id" = 1$q$, '23514');
SELECT pg_temp.expect_error('CHECK : confirmed_at renseigné sur statut 3 refusé',
  $q$UPDATE "asst_proposal" SET "confirmed_at" = now() WHERE "asst_proposal_id" = 6$q$, '23514');
SELECT pg_temp.expect_error('CHECK : error_code sur statut <> 5 refusé',
  $q$UPDATE "asst_proposal" SET "error_code" = 'x' WHERE "asst_proposal_id" = 6$q$, '23514');
SELECT pg_temp.expect_error('CHECK : statut 5 sans error_code refusé',
  $q$UPDATE "asst_proposal" SET "error_code" = NULL WHERE "asst_proposal_id" = 3$q$, '23514');
SELECT pg_temp.expect_error('CHECK : error_code mal formé refusé',
  $q$UPDATE "asst_proposal" SET "error_code" = 'Mauvais Code' WHERE "asst_proposal_id" = 3$q$, '23514');
SELECT pg_temp.expect_error('CHECK : error_message sur statut <> 5 refusé',
  $q$UPDATE "asst_proposal" SET "error_message" = 'x' WHERE "asst_proposal_id" = 6$q$, '23514');
ALTER TABLE "asst_proposal" ENABLE TRIGGER USER;

-- ===========================================================================
-- F2. TRUNCATE interdit
-- ===========================================================================
SELECT pg_temp.expect_error('TRUNCATE asst_proposal refusé', $q$TRUNCATE "asst_proposal"$q$, '23001');
SELECT pg_temp.expect_error('TRUNCATE asst_message refusé (avec CASCADE)', $q$TRUNCATE "asst_message" CASCADE$q$, '23001');
SELECT pg_temp.expect_error('TRUNCATE asst_conversation refusé (avec CASCADE)', $q$TRUNCATE "asst_conversation" CASCADE$q$, '23001');
SELECT pg_temp.expect_error('TRUNCATE des trois tables ensemble refusé',
  $q$TRUNCATE "asst_proposal", "asst_message", "asst_conversation"$q$, '23001');

-- ===========================================================================
-- G. asst_user_budget
-- ===========================================================================
SELECT pg_temp.expect_ok('budget : ligne valide insérée (défauts à 0, sans plafond)',
  $q$INSERT INTO "asst_user_budget" ("user_id","day") VALUES (9001, DATE '2026-11-22')$q$);
SELECT pg_temp.expect_error('budget : unique (user_id, day)',
  $q$INSERT INTO "asst_user_budget" ("user_id","day") VALUES (9001, DATE '2026-11-22')$q$, '23505');
SELECT pg_temp.expect_ok('budget : même utilisateur, autre jour accepté',
  $q$INSERT INTO "asst_user_budget" ("user_id","day") VALUES (9001, DATE '2026-11-23')$q$);
SELECT pg_temp.expect_error('budget : montant consommé négatif refusé',
  $q$UPDATE "asst_user_budget" SET "consumed_amount" = -1 WHERE "user_id" = 9001 AND "day" = DATE '2026-11-22'$q$, '23514');
SELECT pg_temp.expect_error('budget : jetons consommés négatifs refusés',
  $q$UPDATE "asst_user_budget" SET "consumed_tokens" = -1 WHERE "user_id" = 9001 AND "day" = DATE '2026-11-22'$q$, '23514');
SELECT pg_temp.expect_error('budget : nombre d''appels négatif refusé',
  $q$UPDATE "asst_user_budget" SET "call_count" = -1 WHERE "user_id" = 9001 AND "day" = DATE '2026-11-22'$q$, '23514');
SELECT pg_temp.expect_error('budget : plafond montant négatif refusé',
  $q$UPDATE "asst_user_budget" SET "cap_amount" = -1 WHERE "user_id" = 9001 AND "day" = DATE '2026-11-22'$q$, '23514');
SELECT pg_temp.expect_error('budget : plafond jetons négatif refusé',
  $q$UPDATE "asst_user_budget" SET "cap_tokens" = -1 WHERE "user_id" = 9001 AND "day" = DATE '2026-11-22'$q$, '23514');
SELECT pg_temp.expect_ok('budget : consommé > plafond accepté (le règlement peut dépasser l''estimation)',
  $q$UPDATE "asst_user_budget" SET "cap_amount" = 1.0000, "consumed_amount" = 1.2500, "cap_tokens" = 100, "consumed_tokens" = 120 WHERE "user_id" = 9001 AND "day" = DATE '2026-11-22'$q$);

-- ===========================================================================
-- Bilan
-- ===========================================================================
DO $$
DECLARE total int;
BEGIN
  SELECT n INTO total FROM asst_check_counter;
  RAISE NOTICE 'TOUS LES CAS PASSENT (% vérifications)', total;
END $$;

ROLLBACK;
