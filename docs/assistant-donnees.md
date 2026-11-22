# Assistant qui agit — données

Guide pour les développeurs des lots suivants. Parcours : l'utilisateur discute avec l'assistant (chat), l'assistant
**propose** une ou plusieurs actions, l'utilisateur **confirme**, l'application **exécute**. Schéma complet (colonnes,
contraintes, relations) : `docs/schema-base-de-donnees.md`, section 11. Sources :
`packages/db/prisma/models/asst.prisma` (modèles), `packages/db/prisma/sql/asst.sql` (CHECK, index partiels,
déclencheurs), `packages/db/prisma/sql/asst.checks.sql` (vérification rejouable), `packages/types/src/asst-enums.ts`
(miroir TypeScript des états).

## 1. Vue d'ensemble

Migration additive `20261122120000_add_assistant_foundations` : **4 tables** préfixées `asst_`, aucune table existante
modifiée, aucune clé étrangère vers une table existante.

| Table | Rôle |
| --- | --- |
| `asst_conversation` | Un échange, propre à un utilisateur. Porte la date de purge (90 jours). |
| `asst_message` | Les messages (utilisateur ou assistant) d'une conversation, ordonnés par `position`, contenu append-only. |
| `asst_proposal` | Une proposition d'actions faite par un message assistant, son cycle de vie (confirmation, exécution, résultat). |
| `asst_user_budget` | Consommation et plafond d'un utilisateur pour un jour UTC. |

Liens : `asst_message.conversation_id`, `asst_proposal.conversation_id` et `asst_proposal.message_id` sont de vraies
clés étrangères en `ON DELETE CASCADE`. Tout le reste (utilisateur, groupe, décision IA) est une colonne sans FK.

## 2. Identifiants

`asst_conversation_id`, `asst_message_id` et `asst_proposal_id` sont des `BIGINT` auto-incrémentés : à exposer en
**chaîne** côté API (comme `wf_instance_id`). `asst_user_budget_id` est un `INTEGER`.

## 3. États et transitions de `asst_proposal`

`status` (`SMALLINT`, CHECK 0 à 5) :

| Valeur | État | Terminal | `confirmed_at` | `finished_at` | `result` | `error_code` / `error_message` |
| --- | --- | --- | --- | --- | --- | --- |
| 0 | proposée | non | NULL | NULL | NULL | NULL |
| 1 | confirmée (exécution en cours) | non | renseignée | NULL | NULL | NULL |
| 2 | appliquée | oui | renseignée | renseignée | objet `{ effects: [...] }` (facultatif) | NULL |
| 3 | refusée | oui | NULL | renseignée | NULL | NULL |
| 4 | expirée | oui | NULL | renseignée | NULL | NULL |
| 5 | échec | oui | renseignée | renseignée | NULL | `error_code` obligatoire (`^[a-z0-9_.]+$`), `error_message` facultatif |

Transitions légales (déclencheur `asst_proposal_guard`) :

| De | Vers | Condition |
| --- | --- | --- |
| 0 proposée | 1 confirmée | `expires_at` strictement dans le futur (sinon refus : on ne confirme pas une proposition expirée) |
| 0 proposée | 3 refusée | aucune |
| 0 proposée | 4 expirée | `expires_at` atteinte (sinon refus : on n'expire pas avant l'heure) |
| 1 confirmée | 2 appliquée | aucune |
| 1 confirmée | 5 échec | aucune |

Le compare-and-set de confirmation (0 vers 1) exige en plus que l'échange ne soit PAS masqué (`deleted_at IS NULL`),
dans la même instruction : la conversation est verrouillée en partage (`FOR SHARE`) par une CTE, puis la mise à jour
n'a lieu que si le verrou est obtenu. Un échange masqué entre la lecture de la proposition et la confirmation fait
perdre le CAS (aucune ligne touchée, résultat `null`, que l'exécuteur traduit en conflit 409 « confirmation
concurrente ») ; la proposition reste au statut 0. Les autres transitions (1 vers 2, 1 vers 5, 0 vers 3, 0 vers 4)
ne dépendent PAS du masquage : une exécution en cours doit pouvoir se terminer et les propositions d'un échange masqué
peuvent expirer ou être refusées.

Toute autre transition est refusée (par exemple 0 vers 2, 0 vers 5, 1 vers 3, 1 vers 4, tout retour en arrière).
Sans changement de statut (0 vers 0, 1 vers 1), seuls `row_version` et `updated_at` peuvent changer.
Les mises à jour qui changent de statut doivent renseigner dans la même instruction les dates et le résultat
exigés par le tableau (les CHECK `ck_asst_proposal_*` les contrôlent).

## 4. Garde-fous SQL

| Objet | Règle |
| --- | --- |
| `asst_proposal_guard_insert` (BEFORE INSERT) | Une proposition naît « proposée » : `status` 0, `row_version` 0, sans `confirmed_at`, `finished_at`, `result`, `error_*` (erreur `check_violation`). Le message doit appartenir à la conversation, et `user_id` / `user_group_id` doivent être ceux de la conversation (`check_violation`) ; un parent inexistant est laissé aux clés étrangères. |
| `asst_proposal_guard` (BEFORE UPDATE) | Une proposition terminée (2, 3, 4, 5) est figée : tout UPDATE refusé. Immuables : `conversation_id`, `message_id`, `user_id`, `user_group_id`, `actions`, `args_hash`, `summary`, `expires_at`, `created_at`. Transitions et expiration : voir §3. `row_version` ne décroît jamais (`check_violation`) ; CHECK `ck_asst_proposal_row_version` >= 0. |
| `asst_proposal_guard_delete` (BEFORE DELETE) | Suppression directe refusée pour une proposition confirmée (1), appliquée (2) ou en échec (5). Les propositions 2 et 5 ne disparaissent que si leur conversation n'existe plus (purge en cascade). |
| `asst_conversation_guard_delete` (BEFORE DELETE) | Suppression d'une conversation refusée (1) tant qu'une de ses propositions est confirmée (exécution en cours) ; (2) tant qu'elle porte une proposition appliquée ou en échec ET que `purge_at` > `now()`. Le masquage d'un échange sans trace d'exécution ramène `purge_at` à `now()` (purge permise) ; avec une trace, `purge_at` est conservée (voir §5). |
| `asst_conversation_immutable` (BEFORE UPDATE) | `user_id`, `user_group_id` et `created_at` ne changent jamais ; `title`, `page_context`, `deleted_at`, `purge_at`, `updated_at`, `last_message_at` restent modifiables. |
| `asst_conversation_no_truncate`, `asst_message_no_truncate`, `asst_proposal_no_truncate` (BEFORE TRUNCATE) | TRUNCATE interdit (`restrict_violation`), y compris avec CASCADE : il contourne les déclencheurs de ligne. |
| `asst_message_immutable` (BEFORE UPDATE) | `conversation_id`, `role`, `position` et `content` ne changent jamais (le contenu est append-only). Les jetons et `ai_decision_id` restent modifiables. |

CHECK notables : `actions` est un tableau JSON de 1 à 5 éléments ; `args_hash` ~ `^[0-9a-f]{64}$` ; `summary` non vide
et au plus 2000 caractères ; `expires_at` > `created_at` ; `result` est un objet et seulement si `status` = 2 ;
`content` d'un message non vide et au plus 20000 caractères ; jetons et lien de décision IA réservés aux messages
assistant (`role` = 1).

**Test de cascade dans `asst_proposal_guard_delete`.** Lors d'un `DELETE` de conversation, PostgreSQL supprime
d'abord la ligne parente, puis exécute la cascade (déclencheurs de contrainte) : au moment où le déclencheur
`BEFORE DELETE` d'une proposition s'exécute, le test `NOT EXISTS (SELECT 1 FROM asst_conversation WHERE
asst_conversation_id = OLD.conversation_id)` voit déjà la conversation supprimée. C'est vérifié en réel par
`asst.checks.sql` (conversation avec propositions appliquée, en échec et refusée supprimée en cascade). Le test
`pg_trigger_depth()` n'a donc pas été nécessaire. Conséquence voulue : supprimer un **message** (ou une proposition)
alors que la conversation existe est refusé si une proposition appliquée ou en échec en dépend.

## 5. Conservation 90 jours et purge

- `asst_conversation.purge_at` vaut par défaut `now() + 90 jours` (CHECK `purge_at >= created_at`).
- **Suppression par l'utilisateur = masquage immédiat** : l'application renseigne `deleted_at` (et `updated_at`).
  La base ne le fait pas elle-même. La liste de l'utilisateur filtre `deleted_at IS NULL`
  (index partiel `ix_asst_conversation_user_active`).
  - **Sans trace d'exécution** (aucune proposition confirmée, appliquée ou en échec) : `purge_at` est aussi ramenée
    à `now()`, l'échange est purgé au passage suivant du job.
  - **Avec une trace d'exécution** (proposition appliquée (2) ou en échec (5) ; une confirmée (1) est traitée de même,
    car elle deviendra l'un ou l'autre) : l'échange est SEULEMENT masqué ; `purge_at` n'est PAS abaissée. Il disparaît
    des listes mais la trace reste en base jusqu'à l'échéance d'origine (90 jours), puis la purge la supprime.
  - La décision est prise dans une transaction : verrou exclusif de la ligne de l'échange (`SELECT ... FOR UPDATE`),
    puis `UPDATE` conditionnel (sous-requête `EXISTS` sur `asst_proposal`) lancé après le verrou. Il se met en file
    derrière une confirmation concurrente (verrou partagé du CAS 0 vers 1, voir §3) et voit alors le statut 1 :
    jamais « échange masqué ET proposition confirmée avec `purge_at` abaissée ». Si le masquage gagne, la
    confirmation perd son CAS et la proposition reste au statut 0.
- **Suppression d'un message** (`deleteMessage`) : un seul `DELETE ... WHERE ... AND NOT EXISTS (proposition)`, limité
  aux échanges non masqués de l'utilisateur. Un message qui porte une proposition (quel que soit son statut) n'est
  jamais supprimé (la cascade emporterait une trace) ; retour `false`, jamais d'exception.
- La **purge physique** (job qui supprime les conversations dont `purge_at` est échue, index `purge_at`) supprime la
  conversation, et la cascade emporte messages et propositions, y compris les propositions appliquées ou en échec.
  Elle ne sélectionne que les échanges échus : un échange masqué dont l'échéance n'est pas atteinte n'est ni purgé ni
  compté en erreur. Elle échoue (et est retentée) tant qu'une proposition est confirmée.
- Propositions encore ouvertes (0 ou 1) : l'index partiel `ix_asst_proposal_expiry` (`status`, `expires_at`)
  sert au job d'expiration (0 vers 4 quand `expires_at` est échue).

## 6. Visibilité : l'auteur seul

La base ne porte aucune règle de lecture. **Seul l'utilisateur propriétaire** (`asst_conversation.user_id`) voit
une conversation, ses messages et ses propositions ; tout accès applicatif filtre sur `user_id` (le compte
connecté), sans exception administrateur. `user_group_id` est l'acteur effectif au moment de la création : les
actions proposées s'exécutent avec ses droits. Index d'appui : `(user_id, updated_at DESC)` partiel sur les
conversations, `(user_id, created_at DESC)` sur les propositions.

## 7. Budget par utilisateur et par jour

`asst_user_budget` : une ligne par `(user_id, day)` (unique), `day` étant le jour **UTC**.

- `consumed_amount`, `consumed_tokens`, `call_count` : consommation du jour (>= 0, 0 par défaut).
- `cap_amount`, `cap_tokens` : plafond appliqué CE JOUR-LÀ, copié de la configuration à la création de la ligne.
  NULL = pas de plafond. Modifier la configuration ne change pas les lignes déjà créées.
- **Pas de CHECK « consommé <= plafond »** : le règlement (settle) peut dépasser légèrement ce que la
  réservation avait estimé, comme le moteur `wf_budget`. Le contrôle du plafond est applicatif (réserver avant
  l'appel, régler après).
- Création de la ligne du jour : `INSERT ... ON CONFLICT (user_id, day) DO NOTHING`, puis mise à jour
  atomique (`consumed_amount = consumed_amount + ...`).

## 8. Écarts assumés

- **Pas de clé étrangère vers les tables existantes** (`app_user`, `app_user_group`, `ged_ai_decision`) : Prisma
  exigerait le champ inverse sur les modèles cibles (hors périmètre). `user_id`, `user_group_id` et
  `ai_decision_id` (`ged_ai_decision.ged_ai_decision_id`) sont des colonnes sans FK ; l'intégrité est applicative.
- **`args_hash` calculé par l'application** (SHA-256 hex du JSON canonique des actions) : la base en vérifie la forme
  (64 hexadécimaux minuscules), pas la valeur. Elle garantit en revanche qu'il ne change plus après création.
- **`actions` validé par zod côté application** : la base ne contrôle que « tableau de 1 à 5 éléments ».
- **Suppression d'un échange applicable à la purge seulement** : aucune suppression directe d'une trace d'exécution
  (proposition appliquée ou en échec), et une conversation qui en porte ne se supprime qu'une fois `purge_at` échue ;
  l'utilisateur masque (`purge_at` n'est abaissée à `now()` que s'il n'y a aucune trace d'exécution ; sinon la trace
  reste jusqu'à l'échéance de 90 jours), le job purge à l'échéance.
- **Messages non figés** (hors périmètre) : seuls rattachement, rôle, position et contenu sont immuables.
- **Propriétaire de la base** : il peut retirer les déclencheurs, y compris ceux qui interdisent TRUNCATE (`DROP TRIGGER`, `ALTER TABLE ... DISABLE
  TRIGGER`). Les garde-fous sont une barrière applicative forte, pas une preuve cryptographique.
- **Limite du garde-fou de suppression** : il protège contre la suppression directe d'une conversation portant une trace d'exécution avant `purge_at`, pas contre un acteur qui abaisse `purge_at` (puis renseigne `deleted_at`) avant de supprimer. Même niveau que la limite « propriétaire de la base » : barrière applicative, pas preuve cryptographique.
- **Heure de référence** : `now()` est l'heure de début de transaction. Une confirmation faite dans une longue
  transaction ouverte avant l'échéance reste acceptée.

## 9. Commandes de vérification

Depuis `packages/db`, sur une base où la migration est appliquée (PostgreSQL 14 ou plus) :

```
psql -v ON_ERROR_STOP=1 -f prisma/sql/asst.checks.sql <base>
```

Le script s'exécute dans une transaction, affiche « OK : ... » pour chaque cas, termine par « TOUS LES CAS
PASSENT » et **annule tout** (aucune donnée conservée). Il doit être lancé par le propriétaire des tables.

Si la base a été créée par `prisma db push`, les CHECK, index partiels et déclencheurs n'existent pas. Les
appliquer (script ré-exécutable : blocs `DO` qui ignorent `duplicate_object`, `IF NOT EXISTS`, `CREATE OR REPLACE`) :

```
prisma db execute --file prisma/sql/asst.sql --schema prisma
```

Contrôles du schéma Prisma : `pnpm --filter @archivage/db exec prisma validate` puis `prisma generate`.
