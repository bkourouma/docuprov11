# Déploiement et exploitation de l'assistant « qui agit »

Guide pour l'équipe d'exploitation. Vue d'ensemble : `docs/assistant.md`. Même structure que `docs/workflow-deploiement.md` : variables, migration, sauvegarde, recette, exploitation, questions métier, limites. Les valeurs ci-dessous sont lues dans le code ; en cas d'écart, le code fait foi. Les références `fichier:ligne` sont celles de la rédaction (22 novembre 2026).

## Points à retenir avant la mise en production

- Aucune variable `ASST_*` n'est obligatoire : tout a une valeur par défaut. Les deux plafonds par utilisateur (section 1) méritent une décision métier avant l'ouverture.
- Le menu `/assistant` n'est accordé à aucun rôle par défaut (refus par défaut). L'assistant n'apparaît que pour les rôles auxquels la clé est donnée explicitement.
- La migration `20261122120000_add_assistant_foundations` est additive : 4 tables `asst_*`, aucune table existante modifiée.
- L'assistant ne s'appuie que sur les budgets et l'arrêt d'urgence du workflow (`wf_budget`, ligne globale) : voir `docs/workflow-deploiement.md` §5.
- Aucun e-mail n'est envoyé. Les effets sont des imputations, des notifications internes et des brouillons non publiés.
- Les limiteurs de débit et les réservations de budget sont en mémoire, par processus d'API.

## 1. Variables d'environnement `ASST_*`

Relevé par `grep process.env.ASST_` dans `apps/api/src` (hors tests), plus les lectures par paramètre `env` (valeur par défaut `process.env`). Toutes se renseignent comme les autres variables de l'API (fichier d'environnement du service `api`, voir `docs/workflow-deploiement.md` §1.1). Un changement exige le redémarrage de l'API, sauf indication contraire.

| Variable | Défaut | Rôle | Valeurs invalides | Lue où (`fichier:ligne`) et quand |
| --- | --- | --- | --- | --- |
| `ASST_USER_DAILY_CAP_AMOUNT` | `3000` | Montant maximal consommé par utilisateur et par jour UTC, dans la devise du budget. `none` (insensible à la casse) : pas de plafond. | Illisible ou négatif : défaut. | `gate/asst-gate.service.ts:122` et `:224` ; à chaque création de la ligne du jour dans `asst_user_budget` (une ligne existante garde son plafond). |
| `ASST_USER_DAILY_CAP_TOKENS` | `500000` | Jetons maximaux par utilisateur et par jour UTC. `none` : pas de plafond. | Illisible ou négatif : défaut. | `gate/asst-gate.service.ts:123` et `:225` ; même règle. |
| `ASST_MESSAGES_PER_MINUTE` | `10` | Messages acceptés par minute et par utilisateur (fenêtre glissante de 60 s), par processus. | Non entier, `0`, plus de 6 chiffres : défaut. | `conversations/asst-message-rate-limiter.ts:19-23` ; à la construction du service (démarrage). |
| `ASST_EXPIRY_SWEEP_MS` | `60000` | Période du balayage qui clôt les propositions échues et reprend les exécutions interrompues (en millisecondes). | `0`, négatif ou non numérique : balayage **désactivé** (l'expiration paresseuse continue de protéger). Désactivé aussi si `NODE_ENV=test`. | `executor/asst-expiry-sweeper.ts:26-29` ; au démarrage du module. |
| `ASST_PURGE_INTERVAL_MINUTES` | `60` | Intervalle de la purge physique des échanges dont `purge_at` est échue. `0` : purge désactivée. | Illisible ou négatif : 60. Désactivée si `NODE_ENV=test`. | `store/asst-purge.service.ts:7-13` et `:32` ; au démarrage. |
| `ASST_PLANNER_MAX_ACTIONS` | `3` | Nombre maximal d'actions par proposition (1 à 5). | Illisible ou inférieur à 1 : 3 ; supérieur à 5 : 5. | `planner/planner.types.ts:50-55` ; à chaque planification (sans redémarrage). |

Constantes non configurables par l'environnement (à ne pas chercher dans les variables) :

| Constante | Valeur | Où |
| --- | --- | --- |
| `ASST_CONFIRM_MAX_PER_MINUTE` | 10 confirmations par utilisateur et par minute glissante, par processus | `executor/asst-confirm-limiter.ts:5` |
| `ASST_PROPOSAL_TTL_MINUTES` | 15 minutes | `packages/types/src/asst-enums.ts:104` |
| `ASST_RETENTION_DAYS` | 90 jours (conservation d'un échange) | `packages/types/src/asst-enums.ts:106` ; défaut SQL `purge_at` dans la migration |
| `ASST_PROPOSAL_ACTIONS_MAX` | 5 actions au plus par proposition | `packages/types/src/asst-enums.ts:108` |
| `ASST_EFFECT_TX_OPTIONS` | attente 5 s, durée 15 s de la transaction d'exécution | `executor/asst-effect-runner.ts:31` |
| `ASST_AMBIGUOUS_LOCK_TIMEOUT_MS` | 2 000 ms (attente du verrou de ligne à la relecture d'une issue ambiguë) | `executor/asst-effect-runner.ts:37` |
| `ASST_DELETE_LOCK_TIMEOUT_MS` | 2 000 ms (masquage d'un échange) | `store/asst-proposal-store.service.ts:41` |
| Délai de grâce des exécutions interrompues | 120 s | `executor/asst-executor.service.ts:43` |

Variables du workflow dont l'assistant dépend (porte globale des agents) : `WF_AGENT_COST_PER_1K_PROMPT` et `WF_AGENT_COST_PER_1K_COMPLETION` (tarif, défauts 5 et 15, voir `docs/workflow-deploiement.md` §1.2), et la configuration du fournisseur d'IA. Sans IA activée ou avec l'arrêt d'urgence actif, l'assistant répond `assistant_unavailable` (503). `WF_TEST_DATABASE_URL` sert aux tests seulement et ne se définit jamais en production.

## 2. Migration `20261122120000_add_assistant_foundations`

Fichier : `packages/db/prisma/migrations/20261122120000_add_assistant_foundations/migration.sql`.

- **Additive** : l'en-tête et le contenu ne comportent que des `CREATE TABLE`, `CREATE INDEX`, `ADD CONSTRAINT` (blocs `DO` qui ignorent `duplicate_object`), des fonctions et déclencheurs sur des objets neufs. Aucun `DROP`, aucun `ALTER` d'une table existante, aucune clé étrangère vers une table existante.
- **Quatre tables** : `asst_conversation`, `asst_message`, `asst_proposal`, `asst_user_budget`.
- **Index** : `asst_conversation_purge_at_idx`, `asst_message_conversation_id_position_key` (unique), `asst_proposal_user_id_created_at_idx`, `asst_proposal_conversation_id_idx`, `asst_proposal_message_id_idx`, `asst_user_budget_day_idx`, `asst_user_budget_user_id_day_key` (unique), et les index partiels `ix_asst_conversation_user_active` et `ix_asst_proposal_expiry` (propositions ouvertes, statuts 0 et 1).
- **Déclencheurs** : `asst_message_immutable`, `asst_proposal_guard_insert`, **`asst_proposal_guard`** (transitions légales, clôture figée, échéance), `asst_proposal_guard_delete`, `asst_conversation_guard_delete`, `asst_conversation_immutable`, et trois déclencheurs `*_no_truncate` (conversation, message, proposition). Détail : `docs/assistant-donnees.md` §3 et §4.
- **PostgreSQL 14 ou plus** (`CREATE OR REPLACE TRIGGER`). L'image du compose convient (`docs/workflow-deploiement.md` §3.1).
- Ne demande ni superutilisateur ni extension propre.

### 2.1 Application

Même séquence que `docs/workflow-deploiement.md` §3.2 : sauvegarde, migration, API, worker, web. `infra/scripts/deploy.sh` applique la migration avant le démarrage. À la main :

```
pnpm --filter @archivage/db exec prisma migrate deploy
```

Base créée par `prisma db push` : les CHECK, index partiels et déclencheurs n'existent pas. Appliquer :

```
prisma db execute --file prisma/sql/asst.sql --schema prisma
```

(depuis `packages/db`, script ré-exécutable). Contrôle rejouable, qui annule tout : `psql -v ON_ERROR_STOP=1 -f prisma/sql/asst.checks.sql <base>` (affiche « TOUS LES CAS PASSENT »), à lancer par le propriétaire des tables.

### 2.2 Retour arrière

- **Pas de migration inverse.** Le retour arrière sûr est la restauration de la sauvegarde faite avant migration (section 3), dans une base vide.
- La version précédente de l'application ignore les tables `asst_*` : si l'assistant seul pose problème, retirer la clé de menu `/assistant` des rôles suffit à le rendre inaccessible, sans toucher à la base.
- Suppression manuelle des objets (non essayée, à ne faire qu'en l'absence de toute donnée à conserver) : supprimer les quatre tables (`DROP TABLE … CASCADE`, ce qui retire leurs déclencheurs), puis les fonctions `asst_message_immutable`, `asst_proposal_guard_insert`, `asst_proposal_guard`, `asst_proposal_guard_delete`, `asst_conversation_guard_delete`, `asst_conversation_immutable` et `asst_no_truncate`, puis la ligne correspondante de `_prisma_migrations`. Noter que `TRUNCATE` est interdit par les déclencheurs sur ces trois tables.

## 3. Sauvegarde avant migration

Reprendre la sauvegarde complète de `docs/ged-deploiement.md` §1.4 et `docs/workflow-deploiement.md` §4.1. Au minimum :

```
pg_dump -Fc -h <hôte> -U <utilisateur> -d <base> -f sauvegarde-avant-assistant-<AAAAMMJJ>.dump
pg_restore --list sauvegarde-avant-assistant-<AAAAMMJJ>.dump | head
```

Points propres à l'assistant, après mise en service :

- Les tables `asst_*` ne portent **aucune clé étrangère** vers `app_user`, `app_user_group` ou `ged_ai_decision` : une restauration partielle produit des identifiants orphelins. Ne restaurer que depuis une sauvegarde complète d'un même instant.
- Les effets de l'assistant vivent dans les tables métier (`mail_inputation`, `notification`, `document`) et dans `data_change_audit`, pas dans `asst_*`. Les binaires des brouillons sont dans le volume `ARCHIVES`.
- Une restauration remet `asst_user_budget` et `wf_budget` à l'état de la sauvegarde (consommation du jour oubliée, **arrêt d'urgence levé** si activé après la sauvegarde : contrôler `wf_budget` dès la restauration).
- Une restauration peut ramener des propositions en statut 0 ou 1 dont l'effet a pourtant été appliqué ailleurs ; ne pas les rejouer (section 5.4).

## 4. Recette pas à pas

Environnement : base de recette migrée, IA activée, un compte A avec le menu `/assistant` et le droit d'imputer, un compte B sans le menu, un courrier lisible par A, un destinataire imputable. Cocher chaque ligne.

### 4.1 Droits et accès

- [ ] **Menu accordé.** Dans l'écran des rôles, accorder `/assistant` (section Docu-Flow) au rôle de A seulement. Vérifier que `/auth/me` de A renvoie `/assistant` dans `menuKeys`, que le bouton (étincelle) apparaît dans la barre supérieure et que Alt+Maj+A ouvre le panneau.
- [ ] **Menu refusé.** Compte B : aucun bouton ; `GET /assistant/conversations` répond 403 sans `errorCode`.
- [ ] **Identité machine.** Un jeton d'agent de numérisation reçoit `identity_refused` (403).

### 4.2 Message et proposition

- [ ] Envoyer « Impute le courrier n° <id> à <nom du destinataire> pour traitement sous 5 jours ». Une carte apparaît : résumé, action, « Valable jusqu'à », compte à rebours, bandeau « Cette proposition n'a aucun effet tant que vous ne l'avez pas confirmée. »
- [ ] Contrôle SQL : aucun effet à ce stade.

```sql
SELECT asst_proposal_id, status, user_id, expires_at, left(args_hash, 12) AS hash
FROM asst_proposal ORDER BY asst_proposal_id DESC LIMIT 5;                 -- status = 0
SELECT count(*) FROM mail_inputation WHERE mail_id = <id du courrier>;     -- inchangé
```

- [ ] Message flou (« impute ce courrier ») : une question de précision, aucune proposition.
- [ ] Phrase réservée (« n'impute pas ce courrier à la DAF ») : aucune proposition directe.

### 4.3 Confirmer

- [ ] Cliquer sur « Confirmer ». La carte passe à « Appliquée » et liste l'effet.

```sql
SELECT asst_proposal_id, status, confirmed_at, finished_at, result
FROM asst_proposal WHERE asst_proposal_id = <id>;                          -- status = 2
SELECT mail_inputation_id, mail_id, user_id, deadline, created_by
FROM mail_inputation WHERE mail_id = <id du courrier> ORDER BY 1 DESC LIMIT 3;
SELECT changed_at, object_ref, new_value FROM data_change_audit
WHERE new_value LIKE 'via assistant ; proposition <id> ;%' ORDER BY 1;     -- une ligne par effet
```

- [ ] Deuxième confirmation de la même carte : 409 `proposal_not_pending`, aucun second effet.

### 4.4 Refuser

- [ ] Nouvelle proposition, clic sur « Refuser » : « Refusée — aucune action n'a été appliquée. » `status = 3`, `finished_at` renseignée, aucune imputation créée. Confirmer ensuite est impossible.

### 4.5 Expirer

- [ ] Nouvelle proposition, attendre plus de 15 minutes sans agir (`expires_at` est immuable : le déclencheur interdit de l'avancer, il faut attendre réellement). Cliquer sur « Confirmer » : 409 `proposal_expired`, `status = 4`, aucun effet.
- [ ] Balayage : avec `ASST_EXPIRY_SWEEP_MS` actif, une proposition échue jamais ouverte passe à 4 dans la minute.

```sql
SELECT status, count(*) FROM asst_proposal GROUP BY status ORDER BY status;
SELECT asst_proposal_id FROM asst_proposal WHERE status IN (0,1) AND expires_at < now(); -- doit se vider
```

### 4.6 Budget

- [ ] Régler un plafond bas pour la recette (`ASST_USER_DAILY_CAP_TOKENS=1000`, redémarrer, supprimer la ligne du jour de l'utilisateur de test ou utiliser un nouvel utilisateur), envoyer des messages jusqu'au refus : 429 `budget_exceeded`, aucune proposition créée, bandeau « Réessayez… » côté interface.

```sql
SELECT user_id, day, consumed_amount, cap_amount, consumed_tokens, cap_tokens, call_count
FROM asst_user_budget ORDER BY day DESC, user_id LIMIT 10;
```

- [ ] Rafale de plus de 10 messages en une minute : 429 `budget_exceeded` (« Trop de messages en peu de temps », limiteur de débit). Plus de 10 confirmations en une minute : 429 `budget_exceeded` (« Trop de confirmations en peu de temps », code réutilisé).
- [ ] Remettre les valeurs de production et redémarrer.

### 4.7 Arrêt d'urgence

- [ ] Activer l'arrêt global (`docs/workflow-deploiement.md` §5.2). Nouveau message : 503 `assistant_unavailable`, aucun appel au modèle, saisie désactivée avec explication.
- [ ] Une carte préparée **avant** l'arrêt peut encore être confirmée et s'applique (une ligne d'avertissement est journalisée) : comportement voulu et documenté (`docs/assistant-execution.md` §8).
- [ ] Lever l'arrêt : l'assistant répond de nouveau.

```sql
SELECT wf_budget_id, emergency_stop, emergency_stop_reason FROM wf_budget WHERE definition_id IS NULL;
```

### 4.8 Droit retiré entre la proposition et la confirmation

- [ ] Créer une proposition avec A, retirer le droit d'imputer au rôle de A, confirmer : 403 `effect_forbidden`, carte en « Échec », `status = 5`, aucune imputation.

### 4.9 Nettoyage

- [ ] Supprimer un échange sans trace d'exécution : il disparaît de la liste, puis de la base au passage de la purge. Un échange portant une proposition appliquée ou en échec reste en base jusqu'à son échéance de 90 jours.

## 5. Exploitation

### 5.1 Balayage d'expiration

`AsstExpirySweeper` (processus de l'API) : toutes les `ASST_EXPIRY_SWEEP_MS`, il clôt jusqu'à 200 propositions échues (0 vers 4) puis reprend jusqu'à 200 exécutions interrompues. Multi-instance sûr (chaque transition est un CAS). Vérification :

```sql
SELECT asst_proposal_id, status, expires_at FROM asst_proposal
WHERE status = 0 AND expires_at < now() - interval '5 minutes';            -- attendu : aucune ligne
```

Des lignes persistantes signifient que le balayage est désactivé ou arrêté (valeur de `ASST_EXPIRY_SWEEP_MS`, journaux « Expiration des propositions en échec »). La sécurité ne dépend pas du balayage : une proposition échue ne peut pas être confirmée.

### 5.2 Purge

`AsstPurgeService` supprime, toutes les `ASST_PURGE_INTERVAL_MINUTES`, les échanges dont `purge_at` est échue (messages et propositions en cascade). Un échange avec une proposition confirmée (statut 1) ou une trace d'exécution encore sous rétention est différé (compteur « différé(s) » dans le journal). Aucun contenu n'est journalisé.

```sql
SELECT count(*) AS dus FROM asst_conversation WHERE purge_at <= now();     -- doit rester faible
```

### 5.3 Reprise des exécutions interrompues (`recoverInterrupted`)

Une proposition restée en statut 1 depuis plus de 120 s passe en statut 5 avec `error_code = 'execution_interrupted'`. Le statut 1 ne persiste que si aucun effet transactionnel n'a été validé (effets, audit et transition 1 vers 2 forment une seule transaction). Le balayage ne supprime aucun brouillon.

```sql
SELECT asst_proposal_id, status, confirmed_at, error_code FROM asst_proposal
WHERE status = 1 OR error_code = 'execution_interrupted' ORDER BY asst_proposal_id DESC LIMIT 20;
```

Si un brouillon a pu être créé avant l'interruption : chercher un document non publié créé à l'heure de `confirmed_at` par l'utilisateur concerné et le supprimer à la main s'il est inutile.

### 5.4 Journal d'audit « via assistant »

Chaque effet applique une ligne `data_change_audit` dans la même transaction : `new_value` commence par `via assistant ; proposition <id> ; outil <outil> ;`, `object_ref` vaut `mail:<id>` ou `asst_proposal:<id>`, `actor_full_name` est le nom de l'utilisateur qui a confirmé. Aucun contenu de courrier ni de brouillon n'y figure.

```sql
SELECT changed_at, actor_full_name, object_ref, new_value FROM data_change_audit
WHERE new_value LIKE 'via assistant ;%' ORDER BY changed_at DESC LIMIT 50;
```

Cohérence : une proposition au statut 2 a au moins une ligne d'audit ; une proposition au statut 5 n'en a aucune.

```sql
SELECT p.asst_proposal_id, p.status FROM asst_proposal p
WHERE (p.status = 2 AND NOT EXISTS (SELECT 1 FROM data_change_audit a
        WHERE a.new_value LIKE 'via assistant ; proposition ' || p.asst_proposal_id || ' ;%'))
   OR (p.status = 5 AND EXISTS (SELECT 1 FROM data_change_audit a
        WHERE a.new_value LIKE 'via assistant ; proposition ' || p.asst_proposal_id || ' ;%'));   -- attendu : aucune ligne
```

### 5.5 Issue ambiguë (`uncertain`)

Cas rare : l'erreur survient APRÈS la fin du callback de la transaction (coupure pendant ou après le COMMIT). L'exécuteur relit le statut **sous verrou de ligne** (`SELECT status FROM asst_proposal … FOR UPDATE`, `lock_timeout` de 2 s, trois relectures espacées de 200, 500 et 1 000 ms) :

- statut 2 : succès, rien à faire ;
- statut 1 ou 5 lu sous verrou : annulation établie, brouillons compensés, échec normal (`effect_failed`) ;
- tout autre cas (statut 0, 3, 4 ou inconnu, ligne absente, `lock_timeout` sur tous les essais, lecture impossible) : **aucune compensation**. Réponse 422 `effect_failed` avec `details: { outcome: 'uncertain' }` et le message « Résultat incertain… ». La proposition n'est pas clôturée par l'exécuteur.

Vérifier l'issue en SQL (le résultat fait foi, pas l'écran) :

```sql
-- 1. Statut de la proposition
SELECT asst_proposal_id, status, error_code, confirmed_at, finished_at FROM asst_proposal WHERE asst_proposal_id = <id>;
-- 2. Effets réellement écrits
SELECT changed_at, object_ref, new_value FROM data_change_audit
WHERE new_value LIKE 'via assistant ; proposition <id> ;%';
```

| Constat | Interprétation | Action |
| --- | --- | --- |
| Statut 2, lignes d'audit présentes | La transaction a été validée. | Rien : informer l'utilisateur que l'action est appliquée. |
| Statut 1 puis, après 2 minutes, statut 5 `execution_interrupted`, aucune ligne d'audit | Rien n'a été validé. | Vérifier un brouillon orphelin (section 5.3) puis refaire la demande. |
| Statut 5 `execution_interrupted` **et** lignes d'audit | Ne devrait pas arriver (audit et transition 1 vers 2 sont atomiques). | Signaler à l'équipe de développement avec le numéro de proposition ; ne pas rejouer. |

Limite honnête : si la connexion du COMMIT est coupée sans que le serveur ait fini de la traiter, le verrou de ligne peut durer jusqu'à la détection de la coupure par PostgreSQL. La relecture reste alors en échec de verrou : on reste en `uncertain`, sans compensation (un brouillon supprimé à tort serait irréparable, un brouillon conservé à tort se supprime à la main).

## 6. Questions métier ouvertes

Chaque question a une option prudente **déjà retenue dans le code** (réversible : une constante ou une variable). À faire trancher par la direction avant l'ouverture à tous les utilisateurs.

| # | Question | Option prudente retenue | Où |
| --- | --- | --- | --- |
| Q1 | Quels plafonds d'usage par utilisateur et par jour (montant, jetons) ? Lesquels pour les profils avancés ? | 3 000 (montant, devise du budget) et 500 000 jetons ; `none` retire le plafond. Réglables par variable. | `gate/asst-gate.service.ts:34-35` ; section 1 |
| Q2 | Quel plafond global et quel tarif réel (la porte globale `wf_budget` n'a aucun plafond à l'installation) ? | Aucun plafond global par défaut ; le plafond par utilisateur agit seul. Voir `docs/workflow-deploiement.md` §9, Q1 et Q2. | `wf_budget` (ligne globale) |
| Q3 | Délai d'imputation : bornes et conversions (de 1 à 90 jours ; « demain » = 1, semaine = 7, huitaine = 8, quinzaine = 15, mois = 30 ; heures seulement si multiples de 24 ; jours calendaires, pas ouvrés) ? | Jours calendaires de 1 à 90 ; tout le reste (date, jours ouvrés, décimal, urgence sans nombre, plusieurs valeurs) devient une question ; aucun délai évoqué : imputation sans délai. | `packages/types/src/asst-dto.ts:48` ; `planner/intent-guards.ts:1250-1270` |
| Q4 | Type d'imputation par défaut quand l'utilisateur n'en cite pas ? | « Pour suivi », s'il est actif ; sinon question. | `planner/intent-guards.ts:1535-1536` |
| Q5 | Durée de conservation des échanges (`ASST_RETENTION_DAYS`) et des traces d'exécution ? | 90 jours ; un échange masqué portant une proposition appliquée ou en échec est conservé jusqu'à l'échéance. **Constante** (pas de variable d'environnement). | `packages/types/src/asst-enums.ts:106` ; migration (défaut de `purge_at`) |
| Q6 | Durée de validité d'une proposition ? | 15 minutes. | `packages/types/src/asst-enums.ts:104` |
| Q7 | Texte de la carte de confirmation (bandeau, avertissements « non annulable », « plusieurs actions », « expiration proche ») et libellés des états ? | Bandeau fixe « Cette proposition n'a aucun effet tant que vous ne l'avez pas confirmée. » ; avertissements déduits côté client. | `apps/web/app/components/assistant/ConfirmationCard.tsx:159` ; `_lib/proposal-logic.ts:230` |
| Q8 | Plafond de relances ? | 1 relance par cible et par jour UTC ; notification interne seulement (pas d'e-mail). | `workflow-agent-catalog/catalog.contracts.ts:68` ; `planner/action-validator.ts:774` |
| Q9 | Limites de débit ? | 10 messages par minute (variable) et 10 confirmations par minute (constante), par utilisateur et par processus. | `conversations/asst-message-rate-limiter.ts:2` ; `executor/asst-confirm-limiter.ts:5` |
| Q10 | Code d'erreur du plafond de confirmations ? | `budget_exceeded` (429) est réutilisé faute de code dédié : l'interface affiche le même message que pour un dépassement de budget. | `executor/asst-confirm-limiter.ts:25-26` ; `docs/assistant-execution.md` §8 |
| Q11 | Nombre d'actions par proposition ? | 3 par défaut (variable, 5 au plus). | `planner/planner.types.ts:47-55` |
| Q12 | L'arrêt d'urgence doit-il bloquer aussi la confirmation d'une proposition déjà préparée ? | Non : elle s'applique quand même, avec un avertissement dans les journaux (même logique que le workflow). L'arrêt bloque toute nouvelle proposition. | `executor/asst-executor.service.ts:128`, `:321-330` |
| Q13 | Décision IA du brouillon : laquelle rattacher à la réponse ? | La réponse porte l'identifiant du dernier appel du planificateur ; la décision de génération du brouillon n'apparaît que dans l'argument de l'action. | `planner/asst-planner.service.ts:360` |
| Q14 | Faut-il ouvrir l'envoi d'e-mail ou la délégation ? | Non, exclus de la liste blanche (v1). Les ouvrir demande un nouveau lot, y compris les codes de droits de `FORBIDDEN_CODES`. | `packages/types/src/asst-enums.ts:87` ; `executor/asst-effect-runner.ts:40-43` |
| Q15 | Qui reçoit le menu `/assistant` (refus par défaut) ? | Aucun rôle tant que la direction ne l'a pas décidé. | `assistant.menus.ts` ; écran des rôles |
| Q16 | Plusieurs instances d'API : les limiteurs et réservations en mémoire sont-ils acceptables ? | Oui pour une instance ; avec N instances, les limites sont multipliées par N. | Voir `docs/workflow-deploiement.md` §9, Q8 |

Écarts du contrat de l'interface à trancher avec l'équipe produit : champ `clarification` des questions à choix, noms des groupes et types affichés par identifiant, ordre de la liste des échanges (`docs/assistant-interface.md` §6).

## 7. Limites connues

Reprises de `docs/assistant-execution.md` §11.1 et `docs/assistant-planificateur.md` §5.8 et §11.2.

**Exécution**

- **Limiteurs en mémoire.** Débit des messages, plafond de confirmations et réservations de budget sont propres à chaque processus.
- **Brouillons non transactionnels.** Un arrêt du processus pendant l'exécution peut laisser un document orphelin ; la reprise ne le supprime pas. Une compensation en échec n'est pas rejouée (une seule passe, aucun journal persistant).
- **Issue ambiguë.** Voir section 5.5 : en cas de doute, aucune compensation et statut laissé au balayage.
- **Arrêt d'urgence.** Il n'arrête pas une proposition déjà confirmée ni la confirmation d'une proposition déjà préparée.
- **Plafond d'instance des relances.** Neutralisé pour l'assistant (la sentinelle `asst:<id>` n'est pas numérique) ; le plafond par imputé et par jour reste appliqué.
- **Délégation exclue.** Ses codes de droits ne figurent pas dans `FORBIDDEN_CODES`.
- **Heure de référence.** L'application juge l'échéance à son horloge, le déclencheur SQL à l'heure de la base : écart possible de quelques secondes.
- **Propriétaire de la base.** Il peut retirer les déclencheurs : barrière applicative forte, pas preuve cryptographique (`docs/assistant-donnees.md` §8).

**Planificateur**

- **Sortie invalide du modèle** : une seule tentative par tour.
- **Liste blanche d'intention** : faux positifs voulus (un ordre légitime atypique donne une question, jamais une action) ; lexique des réserves non exhaustif ; la carte de confirmation reste le dernier garde-fou.
- **Réponse par rang** : seuls les rangs 1 à 6 en message entier ; « le dernier » n'est pas pris en charge.
- **Recherche** : au plus 30 candidats lus avant filtre des droits ; texte de courrier tronqué à 6 000 caractères.
- **Écritures non atomiques** de `postMessage` (message utilisateur, message assistant, proposition en trois transactions) : une trace partielle est possible.
- **Corpus d'attaque scripté** : il valide le code, pas le comportement d'un vrai modèle.
- **Interface** : rendu visuel, lecteurs d'écran et parcours complet contre l'API réelle non vérifiés sur écran réel (`docs/assistant-interface.md` §8).
