# Docu-Flow — moteur de workflow

Guide pour les développeurs des lots suivants (W2 agents, W3 déclencheurs, W4 interface). Tables, états et règles d'or :
`docs/workflow-donnees.md`. Schéma complet : `docs/schema-base-de-donnees.md`, section 10. Contrat public :
`apps/api/src/modules/workflows/engine/engine.types.ts`. Ce document décrit le comportement implémenté au lot W1 ;
en cas d'écart, le code fait foi.

Sources : `apps/api/src/modules/workflows/engine/` (`interpreter.ts`, `engine.ts`, `executor-registry.ts`),
`apps/api/src/modules/workflows/` (contrôleurs, services, `workflows.module.ts`, `workflows.menus.ts`),
`apps/api/src/modules/workflows/extension/`, `apps/worker/src/processors/workflow-timers.*.ts`,
`packages/types/src/wf-graph.ts`, `wf-enums.ts`, `wf-dto.ts`.

## 1. Vue d'ensemble

```
 Clients (web)            apps/api (NestJS)                                  PostgreSQL
 ---------------          ----------------------------------------------     ------------------------
 /workflows/*   --->      Contrôleurs (garde de menus)                       wf_definition(_version)
                          -> Services (droits, principal, événements)        wf_instance
                          -> WorkflowEngine  (classe SANS Nest)  ----------> wf_task
                               interpreter.ts : fonctions pures              wf_timer  (créées ici)
                               engine.ts : transactions, verrou, journal     wf_inbox_item
                               exécuteurs appelés APRÈS commit               wf_event_log
                                 -> WfExecutorRegistry (« agent » en W2)

 apps/worker (BullMQ)     workflow-timers.scheduler.ts   (tick toutes les 15 s)
                          workflow-timers.processor.ts   ---------------->  wf_timer (consommées ici)
                          relance, échéance, escalade, expiration           wf_task, wf_inbox_item,
                                                                           wf_instance, wf_event_log,
                                                                           notification
```

| Composant | Fichier | Rôle |
| --- | --- | --- |
| Interprète | `engine/interpreter.ts` | Fonctions pures, sans E/S : chemins et conditions, choix d'arête, construction de tâche, validation du résultat, droit d'agir. |
| Moteur | `engine/engine.ts` | Transitions transactionnelles, verrou optimiste, journal, création des minuteries, exécution des exécuteurs. |
| Registre | `engine/executor-registry.ts` | Un exécuteur au plus par type de tâche. |
| Services | `instances.service.ts`, `inbox.service.ts`, `definitions.service.ts`, `principal.service.ts` | Droits applicatifs, construction du `WfPrincipal`, publication des événements. |
| Extensions | `extension/*.ts` | Contrôle d'accès aux objets liés, démarrage par déclencheur, événements, notifications, suggestion. |
| Minuteries | `apps/worker/src/processors/workflow-timers.*.ts` | Consommation des lignes `wf_timer`. |
| Types partagés | `packages/types/src/wf-graph.ts`, `wf-enums.ts`, `wf-dto.ts` | Schéma du graphe, validateur, énumérations, schéma d'escalade. |

**Pourquoi le moteur est dans l'api.** Les transitions viennent des requêtes HTTP et des exécuteurs (W2). L'api détient
les droits (`PrincipalService`) et les services qui connaissent les objets liés. Le moteur n'a pas de dépendance NestJS :
il est construit avec un `PrismaClient` et une horloge injectable. Il pourrait donc être relocalisé dans un package
(section 9), mais W1 ne crée pas de package partagé.

**Pourquoi les minuteries sont dans le worker.** Une échéance doit être traitée sans qu'aucune requête ne soit en cours.
Le worker dispose déjà de la file BullMQ et d'un processus de fond. La minuterie est une ligne en base, donc durable.
Le moteur de l'api crée les lignes ; le worker les consomme. **Le worker n'importe pas le moteur** : il applique les
effets des minuteries directement sur les tables, avec ses propres requêtes.

## 2. Cycle de vie

Les états numériques sont définis dans `packages/types/src/wf-enums.ts`. Les transitions ci-dessous sont celles du code.

### 2.1 Instance (`wf_instance.status`)

| Depuis | Vers | Cause | Effets principaux |
| --- | --- | --- | --- |
| (création) | 0 | `startInstance` | `instance.started` ; entrée dans l'étape de départ. |
| 0 ou 1 | 0 ou 1 | Clôture d'une tâche, entrée dans l'étape suivante | Statut 0 pendant l'enchaînement, puis 1 si une tâche humaine est ouverte, 0 sinon. |
| 0 ou 1 | 2 | Étape sans arête sortante | `instance.completed`, `finished_at`, minuteries annulées. |
| 0 ou 1 (5 lors d'une reprise) | 3 | Erreur : routage sans arête, boucle dépassée, plus de 50 enchaînements automatiques, étape agent sans exécuteur, `fail` d'un exécuteur, étape introuvable | `instance.failed`, `error_message`, `finished_at` ; tâches ouvertes annulées, boîte annulée. |
| 0, 1 ou 5 | 4 | `cancelInstance` (refusé si terminale) | `instance.cancelled`, `finished_at` ; tâches ouvertes -> 3, boîte -> 5, minuteries -> 2. |
| 0 ou 1 | 5 | `suspendInstance` ; refus sans voie de correction ; échéance dépassée sans escalade (worker) | `instance.suspended` avec la raison. |
| 5 | 0 ou 1 | `resumeInstance` | `instance.resumed` ; échéances décalées (section 4.6). |

Les états terminaux sont 2, 3 et 4. Le CHECK `ck_wf_instance_finished` exige `finished_at` si et seulement si le statut
est 2, 3 ou 4.

### 2.2 Tâche (`wf_task.status`)

| Depuis | Vers | Cause | Effets principaux |
| --- | --- | --- | --- |
| (création) | 0 | Étape humaine, ou étape agent avec un exécuteur | `task.created`, `task.assigned`. |
| (création) | 2 | Décision automatique (tâche de traçabilité, `completed_by` nul) | `task.created`, `task.completed`. |
| (création) | 5 | Étape agent sans exécuteur `agent` enregistré | `task.created`, `task.failed`, instance échouée. |
| 0 | 1 | `claimTask` | `task.claimed` ; éléments de boîte -> 1. |
| 0 ou 1 | 2 | `completeTask` ; `rejectTask` (le refus clôt aussi la tâche à 2, résultat `{ rejected: true, approved: false }`) | `task.completed` ou `task.rejected` ; boîte -> 2 ou 3. |
| 0 ou 1 | 0 | `delegateTask` (la prise est retirée) | `task.delegated` ; boîte -> 0. |
| 0 ou 1 | 0 | Escalade (worker) : même tâche, nouveau bénéficiaire | `task.escalated` ; boîte -> 0. |
| 0 ou 1 | 4 | Échéance dépassée sans escalade (worker) | `task.expired` ; boîte -> 4. |
| 0 ou 1 | 3 | Annulation ou échec de l'instance | `task.cancelled` ; boîte -> 5. |
| 0 ou 1 | 5 | Exécuteur qui renvoie `fail` | `task.failed`, instance échouée. |

Un exécuteur d'agent qui ne conclut pas ne passe pas la tâche à 5 : elle reste ouverte et passe à son bénéficiaire
humain (section 7.1).

### 2.3 Élément de boîte (`wf_inbox_item.status`, `kind`)

`kind` 0 = tâche humaine, 1 = validation d'une proposition d'agent. Une tâche a au plus un élément ouvert de chaque kind
(index unique partiel `ux_wf_inbox_item_open`).

| Depuis | Vers | Cause |
| --- | --- | --- |
| (création) | 0 | Tâche humaine (kind 0), proposition d'exécuteur (kind 1), agent repris par un humain (kind 0). |
| 0 | 1 | `claimTask` (`claimed_by`, `claimed_at`). |
| 0 ou 1 | 2 | `completeTask`. Pour kind 1, `resolution.outcome` vaut `accepted` si le résultat égale la proposition, sinon `modified`. |
| 0 ou 1 | 3 | `rejectTask`. |
| 0 ou 1 | 0 | `delegateTask` ou escalade : `claimed_by` vidé. |
| 0 ou 1 | 4 | Expiration (worker). |
| 0 ou 1 | 5 | Annulation ou échec de l'instance. |

### 2.4 Minuterie (`wf_timer.status`, `kind`)

`kind` : 0 attente, 1 relance, 2 échéance, 3 reprise. Le moteur en crée seulement de nature 1 et 2 en W1.

| Depuis | Vers | Cause |
| --- | --- | --- |
| (création) | 0 | Entrée dans une tâche : `dueInHours` crée une échéance (kind 2) à `now + h` ; `reminderAfterHours` crée une relance (kind 1). `timer.scheduled`. |
| 0 | 1 | Réclamée et traitée par le worker (CAS, `timer.fired`). |
| 0 | 1, puis nouvelle ligne 0 | Relance suivante si elle tombe avant l'échéance ; escalade avec `dueInHours` (nouvelle échéance). |
| 0 | 2 | Étape quittée ou ré-entrée (`cancelStepTimers`), instance terminée (`cancelAllTimers`), tâche expirée, abandon après 5 tentatives (`timer.failed`). |
| 0 | 0 | Instance suspendue : la minuterie n'est pas réclamée ; à la reprise, `fire_at` est décalé. |

## 3. Modèle d'exécution

### 3.1 Contexte d'instance

`wf_instance.context` (JSON) a la forme suivante, construite par `normalizeContext` et `applyStepResult` :

```json
{
  "input":      { "...": "données de lancement (context.input, 256 Kio au plus)" },
  "steps":      { "<stepKey>": "dernier résultat de cette étape" },
  "last":       "résultat de la dernière étape humaine ou agent terminée",
  "assignedTo": { "userGroupId": 12 }
}
```

- `steps.<key>` est remplacé à chaque clôture de l'étape. Une décision automatique y écrit `{ decision: { chosen, edgeLabel, matchedCondition } }`.
- `last` est remplacé par les clôtures humaines et agent. Une décision automatique ne le modifie pas (`setLast: false`) : les conditions suivantes peuvent encore lire le dernier résultat humain.
- `assignedTo` est fixé par une étape `affectation` (section 3.6).

### 3.2 Conditions d'arêtes

Une arête peut porter `condition: { field, op, value? }`. `field` est un chemin pointé dans le contexte (`last.approved`,
`steps.controle.values.montant`, `input.priorite`). Un segment numérique indexe un tableau. Les segments `__proto__`,
`prototype` et `constructor` sont refusés.

| Opérateur | Vrai si |
| --- | --- |
| `eq`, `neq` | Égalité ou inégalité (section ci-dessous). |
| `gt`, `gte`, `lt`, `lte` | Les deux côtés sont des nombres ou des chaînes numériques, et la comparaison est vraie. Sinon faux. |
| `in` | `value` est un tableau et la valeur y figure. |
| `exists` | La valeur est définie et non `null` (`value` ignorée). |

Règles communes :

- Chemin absent : faux pour tous les opérateurs, y compris `neq`. Seul `exists` renvoie faux sans erreur.
- Égalité stricte (`===`), sauf si un côté est un nombre : comparaison numérique, l'autre côté pouvant être une chaîne
  numérique (`"10"` égale `10`). Objets et tableaux : égalité structurelle.
- Opérateur inconnu : faux.

Exemple (arêtes de l'étape `valider`) :

```json
"next": [
  { "to": "archiver", "label": "Accepté",
    "condition": { "field": "last.approved", "op": "eq", "value": true } },
  { "to": "corriger", "label": "À corriger",
    "condition": { "field": "last.approved", "op": "eq", "value": false } },
  { "to": "direction", "label": "Autre cas", "isDefault": true }
]
```

Le refus par `rejectTask` produit `last.approved = false` et `last.rejected = true` : il emprunte donc la branche
`corriger` (section 3.8). Une validation complétée avec `approved: false` par `completeTask` suit les règles
normales, donc la branche de repli `direction` peut aussi s'appliquer si aucune condition ne correspond.

Autre exemple, sur un résultat de formulaire : `{ "field": "steps.controle.values.montant", "op": "gt", "value": 1000 }`.

### 3.3 Choix de l'arête sortante (`chooseNextEdge`)

1. Les arêtes conditionnées sont évaluées dans l'ordre de déclaration ; la première vraie gagne.
2. Sinon, la première arête de repli (sans condition, ou `isDefault: true`) est suivie.
3. Sinon, erreur de routage : l'instance échoue, avec un message explicite.
4. Aucune arête déclarée : étape terminale.

En mode rejet (`rejectTask`), seules les arêtes conditionnées comptent : le repli n'est jamais suivi. Si aucune ne
correspond, la tâche est close et l'instance est suspendue.

### 3.4 Types de tâche et résultat attendu

Le type d'étape (`step.type`) détermine le type de tâche (`wf_task.task_type`). La validation est faite par
`validateTaskResult`, qui refuse toute clé inattendue.

| `step.type` | `task_type` | Résultat attendu | Règles supplémentaires |
| --- | --- | --- | --- |
| `formulaire` | 0 | `{ values: {…} }` | `config.fields: [{ key, required? }]` : les champs requis doivent être présents et non vides. Si `fields` est déclaré, aucune clé inconnue. |
| `generation` | 1 | `{ content: string non vide, documentId?: entier > 0 }` | Une suggestion d'exécuteur n'est jamais appliquée seule : elle devient une proposition (kind 1) ; le texte suggéré est aussi rangé dans `task.input.suggestion`. |
| `checklist` | 2 | `{ checked: string[] }` | `config.items: [{ key, required? }]` : tous les éléments requis cochés ; aucune clé inconnue ; aucun doublon. |
| `affectation` | 3 | `{ assignee: { userGroupId } \| { groupId } \| { roleId } }` | Exactement un identifiant. Un `userGroupId` est vérifié dans l'annuaire (compte actif). Mémorisé dans `context.assignedTo`. |
| `validation` | 4 | `{ approved: boolean, comment?: string }` | Journalise `validation.accepted` ou `validation.rejected` avec `validated_by` et `validated_at`. |
| `decision` | 5 | Automatique par défaut : aucun résultat à saisir. Avec `config.manual: true` : `{ choice: string }` | `config.choices` (liste) restreint le choix. Voir section 3.5. |
| `agent` | 6 | Objet JSON quelconque, produit par l'exécuteur | Exécuteur `agent` obligatoire (section 7.1). Configuration `step.agent` obligatoire. |

Un résultat dépassant 64 Kio (65 536 octets) est refusé. Les messages d'erreur sont en français et renvoient
`INVALID_INPUT` (HTTP 422).

Les champs de configuration reconnus sont : `priority` (0/1/2 ou « basse », « normale », « haute »), `maxAttempts`,
`escalation` (section 4.5), `fields`, `items`, `choices` et `manual`. Les champs de premier niveau d'une étape sont
`key`, `name`, `type`, `description`, `assignee`, `dueInHours`, `reminderAfterHours`, `config`, `agent` et `next`.

### 3.5 Décision automatique et décision manuelle

- **Automatique** (par défaut, `type: decision` sans `config.manual`) : à l'entrée, le moteur évalue les arêtes sur le
  contexte. Il crée une tâche déjà close (statut 2, `completed_by` nul) pour la traçabilité, journalise le choix
  (`decision` : `chosen`, `edgeLabel`, `matchedCondition`) et enchaîne dans la même transaction. Il ne crée ni boîte, ni
  attente. Une décision automatique sans arête applicable fait échouer l'instance.
- **Manuelle** (`config.manual: true`) : tâche humaine. Le résultat `{ choice }` alimente `last.choice`.

Le validateur impose au moins deux arêtes sortantes à toute étape `decision` (`DECISION_NEEDS_BRANCHES`).

### 3.6 Affectation

Le bénéficiaire d'une tâche humaine n'est jamais vide. Ordre de résolution (`resolveAssignee`) :

1. `step.assignee` :
   - `user`, `group`, `role` : l'identifiant fourni ;
   - `initiator` : le lanceur ;
   - `subject_owner` : le propriétaire de l'objet lié, si `WfDirectory.resolveSubjectOwner` le fournit ; sinon le lanceur
     (événement `subject_owner_fallback` expliqué dans le journal).
2. Sinon, `context.assignedTo`, mémorisé par une étape `affectation` antérieure.
3. Sinon, le lanceur (`default_initiator`).

Une affectation mal formée dans un graphe publié donne le lanceur, jamais personne.

Un `assignee` désigne une seule cible : `assignee_user_group_id`, `assignee_group_id` ou `assignee_role_id`
(CHECK `ck_wf_task_assignee`). Pour un groupe ou un rôle, tous les membres voient la tâche dans leur boîte.

### 3.7 Boucles de correction et plafonds

Une arête vers une étape déjà visitée est une boucle de correction. La nouvelle tâche reçoit
`attempt = max(attempt de l'étape pour cette instance) + 1`, et le titre reçoit « (passage n) ». L'index unique
`(instance, step_key, attempt)` garantit l'unicité.

Le validateur refuse une arête vers l'étape elle-même (`SELF_LOOP`), mais pas une boucle plus longue. Le plafond d'exécution
borne les boucles :

| Garde-fou | Valeur par défaut | Constante |
| --- | --- | --- |
| Passages par étape | 25 (la 26e entrée échoue) ; `config.maxAttempts` entier, borné à [1, 100] | `WF_DEFAULT_MAX_ATTEMPTS`, `WF_MAX_ATTEMPTS_CEILING` |
| Enchaînements automatiques dans une transition | 50 | `WF_AUTO_CHAIN_LIMIT` |
| Résultat de tâche | 65 536 octets | `WF_RESULT_MAX_BYTES` |
| Données de lancement (`context.input`) | 262 144 octets | `WF_CONTEXT_INPUT_MAX_BYTES` |
| Journal, champ `decision` | 8 192 octets (résumé tronqué au-delà) | `WF_LOG_DECISION_MAX_BYTES` |
| Consigne journalisée | 2 000 caractères | `WF_LOG_INSTRUCTION_MAX` |
| Titre de tâche ou d'élément | 300 caractères | `WF_TITLE_MAX` |
| Résumé d'élément de boîte | 500 caractères | `WF_INBOX_SUMMARY_MAX` |
| Commentaire (refus, délégation) | 4 000 caractères | `WF_COMMENT_MAX` |
| Clé d'idempotence | 200 caractères | `parseIdempotencyKey` (engine.ts) |

Dépasser le plafond de passages fait échouer l'instance (« Boucle de correction dépassée… »). Dépasser le plafond
d'enchaînement fait de même (« boucle probable dans le graphe »).

### 3.8 Rejet

`rejectTask` ferme la tâche avec le résultat `{ rejected: true, approved: false, comment? }`, passe les éléments de boîte à
3 (rejetés) et annule les minuteries de l'étape. Seules les arêtes conditionnées s'appliquent (section 3.3). S'il n'y a
pas de voie de correction, l'instance est suspendue (`instance.suspended`) et attend une reprise manuelle. Une étape
`validation` journalise alors `validation.rejected`.

### 3.9 Règles de graphe à la publication

`validateWorkflowGraph` (`packages/types/src/wf-graph.ts`) et les contrôles du service `definitions.service.ts` :

| Code | Signification |
| --- | --- |
| `SCHEMA_INVALID` | Forme du graphe non conforme au schéma (une issue par erreur). |
| `DUPLICATE_STEP_KEY`, `START_NOT_FOUND`, `EDGE_TARGET_NOT_FOUND` | Clés et références. |
| `SELF_LOOP`, `DUPLICATE_EDGE_TARGET` | Arête vers soi-même, ou deux arêtes vers la même cible. |
| `AMBIGUOUS_BRANCHING` | Plus d'une arête de repli dans une même étape. |
| `UNREACHABLE_STEP`, `NO_TERMINAL_STEP`, `STEP_CANNOT_REACH_TERMINAL` | Atteignabilité et fin de workflow. |
| `DECISION_NEEDS_BRANCHES` | Étape `decision` avec moins de deux arêtes. |
| `AGENT_SPEC_MISSING`, `AGENT_SPEC_ON_NON_AGENT` | Configuration `agent` présente ou absente à tort. |
| `AUTONOMY_REQUIRES_LOW_RISK` | Autonomie « autonome » sans marquage faible risque du workflow. |
| `ESCALATION_INVALID` | `config.escalation` non conforme à `wfEscalationConfigSchema`. |
| `EXECUTOR_MISSING` | Étape `agent` alors qu'aucun exécuteur `agent` n'est enregistré. |

Un graphe qui échoue renvoie HTTP 422 avec la liste `issues`. La publication archive la version publiée précédente avant
d'en publier une nouvelle (une seule version publiée à la fois), calcule le `graph_hash` (SHA-256 du JSON canonique) et
passe la définition au statut 1.

## 4. Durabilité

### 4.1 Transactions et verrou

Toute transition suit le même schéma (`engine.ts`) :

1. Transaction interactive, isolation READ COMMITTED, délai de 15 s (`transactionTimeoutMs`).
2. `SELECT "row_version" FROM "wf_instance" … FOR UPDATE` : le verrou de l'instance est pris en premier. Les lectures qui
   décident d'une écriture sont faites après ce verrou.
3. Vérifications : droit d'agir (`isTaskAssignee`), état de l'instance (suspendue ou terminale refusée), `expectedRowVersion`
   si fourni, état de la tâche, prise en charge par un autre membre.
4. Écritures et journal, dans la même transaction.
5. `UPDATE "wf_instance" … WHERE "row_version" = <valeur lue>` avec `row_version + 1`. Si zéro ligne est touchée, la
   transaction est annulée et l'erreur `CONFLICT` est renvoyée.

`expectedRowVersion` est fourni par le client (corps de `complete`). Il permet de refuser une action fondée sur un état
périmé.

**Conséquence.** Toutes les transitions d'une même instance sont sérialisées par le verrou. Une escalade du worker prend
ce même verrou et incrémente aussi `row_version` : un client qui a lu la version précédente reçoit `CONFLICT`.

### 4.2 Journal (`wf_event_log`)

Chaque transition écrit ses événements dans la transaction, sans écriture ultérieure. Le journal est en ajout seul.

| Acteur (`actor_kind`) | Valeur |
| --- | --- |
| Système | 0 (moteur, minuteries) |
| Utilisateur | 1 (`actor_user_group_id` obligatoire) |
| Agent | 2 (exécuteurs) |

Types d'événements émis :

| Famille | Types |
| --- | --- |
| Instance | `instance.started`, `instance.completed`, `instance.failed`, `instance.cancelled`, `instance.suspended`, `instance.resumed` |
| Tâche | `task.created`, `task.assigned`, `task.claimed`, `task.completed`, `task.rejected`, `task.delegated`, `task.failed`, `task.cancelled`, `task.expired`, `task.escalated` |
| Validation | `validation.accepted`, `validation.rejected` |
| Agent | `agent.proposed`, `executor.error` |
| Minuterie | `timer.scheduled`, `timer.fired`, `timer.cancelled`, `timer.failed` |

Contenu : identifiants, consigne (2 000 caractères au plus), résultat résumé et borné à 8 Kio, explication. Le contenu
rédigé d'une étape `generation` n'est jamais journalisé : seulement sa longueur et `documentId`. Aucun contenu de document
n'entre dans le journal.

### 4.3 Idempotence

- `startInstance` avec `idempotencyKey` : l'unicité est `(definition_id, idempotency_key)` (index partiel
  `ux_wf_instance_idempotency`). Si l'instance existe pour le même lanceur, elle est renvoyée avec `created = false`
  (HTTP 200), sans aucune écriture.
- Si le lanceur diffère, `IDEMPOTENCY_CONFLICT` est renvoyé (HTTP 409), sans révéler l'instance existante.
- Course entre deux lancements simultanés : la violation d'unicité (P2002) déclenche une relecture.
- Déclencheurs (section 7.2) : la clé est obligatoire, 1 à 200 caractères, et doit identifier l'événement source.

### 4.4 Exécution des exécuteurs

Les exécuteurs s'exécutent après commit, hors transaction (`dispatchExecutor`). Leur résultat est appliqué par une
nouvelle transition verrouillée (`applyExecutorOutcome`), qui ne fait rien si l'une des conditions suivantes ne tient pas :

- la tâche est toujours ouverte ;
- son `attempt` n'a pas changé ;
- l'instance est active ;
- un humain n'a pas repris l'étape (élément kind 0 ouvert, pour une étape agent).

Une erreur d'exécuteur est journalisée (`executor.error`) et ne fait pas échouer l'instance. Les erreurs d'arrière-plan
sont remontées au module par `onBackgroundError`. Les événements d'arrière-plan sont publiés par `onEvents`.

**Aucun délai maximal n'encadre `execute()`.** Un exécuteur qui ne rend pas la main laisse la tâche ouverte. W2 doit borner
la durée de ses appels.

### 4.5 Minuteries (worker)

**Planification.** Le planificateur BullMQ `wf-timers-tick` s'exécute toutes les 15 s (`upsertJobScheduler`, idempotent).
Un tick immédiat est ajouté au démarrage, ce qui traite les minuteries échues pendant un arrêt. Concurrence : 1.

**Réclamation.** Un tick réclame jusqu'à 50 minuteries (`batchSize`). Il enchaîne les lots tant qu'un lot est plein, au
plus 20 lots par tick. La requête est paramétrée :

- `status = 0`, `fire_at <= now`, bail libre ou expiré (`locked_until`) ;
- instance en statut 0 ou 1 (les instances suspendues, terminées ou annulées sont écartées) ;
- `FOR UPDATE OF t SKIP LOCKED` : deux workers ne prennent jamais la même ligne.

Le bail dure 120 s. Chaque réclamation incrémente `attempts`.

**Traitement.** Une transaction par minuterie (délai 30 s, attente maximale 5 s) :

1. verrou `FOR UPDATE` de l'instance ; si elle n'est plus active, le bail est levé et la minuterie est ignorée (`skipped`) ;
2. CAS `status 0 -> 1` avec `locked_by` égal à ce worker ; zéro ligne donne `lost` ;
3. effet selon la nature ; `timer.fired` est journalisé (acteur système).

Une minuterie est traitée exactement une fois, même avec deux workers. Un échec lève la transaction : le bail expire et la
minuterie est reprise. À la 6e réclamation (`attempts > 5`), la minuterie est abandonnée : statut 2 et événement
`timer.failed`.

**Effets par nature.**

- **Relance (1)** : notification « Relance : la tâche … est en attente » au bénéficiaire (groupe ou rôle étendu à ses membres
  actifs, plafond 200). Une nouvelle relance est armée si la suivante tombe avant l'échéance de la tâche. Si la tâche n'est
  plus ouverte : `noop` (événement `timer.fired` avec `{ noop: true }`).
- **Échéance (2)** : voir ci-dessous.
- **Attente (0) et reprise (3)** : `timer.fired`, puis le gestionnaire enregistré par `registerTimerHandler(kind, handler)`
  s'il existe. Aucun gestionnaire en W1.

**Échéance, escalade et expiration.** Si la tâche est toujours ouverte et que `step.config.escalation` est valide (le schéma
`wfEscalationConfigSchema` est lu dans la version publiée ; une configuration invalide est traitée comme absente) :

```json
"escalation": {
  "assignee": { "kind": "user", "id": 42 },
  "dueInHours": 24,
  "maxEscalations": 2,
  "message": "Texte ajouté à la notification (500 caractères au plus)."
}
```

- `dueInHours` est obligatoire (entier positif) : sans lui, aucune minuterie d'échéance ne serait recréée après l'escalade.
- `maxEscalations` vaut 1 par défaut, borné à [1, 5]. Le compte est fait sur les événements `task.escalated` de la tâche.
- **Escalade** tant que le compte est inférieur au plafond : même tâche réaffectée à un seul bénéficiaire, statut 0,
  `due_at = now + dueInHours`, tous les éléments de boîte ouverts de la tâche (nature 0 ou 1) rouverts (statut 0, prise retirée), `row_version` de l'instance
  incrémenté, nouvelle minuterie d'échéance, événements `timer.fired` et `task.escalated`,
  notification au nouveau bénéficiaire.
- La cible est revérifiée à l'exécution (compte non désactivé, groupe actif, rôle actif) : sinon repli sur l'expiration, avec
  `escalation: target_inactive` dans la décision de `timer.fired`.
- **Expiration** sinon : tâche en statut 4, éléments de boîte en statut 4, autres minuteries de la tâche annulées,
  instance passée à 5 (`instance.suspended`, raison `deadline_exceeded`), événement `task.expired`, notification au lanceur.
  La reprise est manuelle.

### 4.6 Suspension et reprise

- **Suspendre** : les tâches restent ouvertes, mais toute action est refusée (`INVALID_STATE`). Les minuteries de cette
  instance ne sont pas réclamées.
- **Reprendre** : la durée de suspension est calculée depuis le dernier événement `instance.suspended`. Elle est appliquée
  (arrondie à la seconde) à `fire_at` des minuteries actives, à `due_at` des tâches ouvertes, et à `due_at` des éléments de
  boîte ouverts qui en ont un.
- Si des tâches restent ouvertes, l'instance repasse à 1 (humain en attente) ou 0 (agent seul).
- Si aucune tâche n'est ouverte (cas d'une expiration ou d'un refus sans voie de correction), la dernière étape est rouverte
  avec `attempt + 1`.

## 5. Permissions

Les menus sont déclarés dans `workflows.menus.ts` et répertoriés dans `roles/menu-catalog.ts`. Ils sont attribués à un rôle.
Accès refusé par défaut : `MenuPermissionGuard` contrôle les contrôleurs qui portent `@RequireMenu`.

| Menu | Clé | Donne accès à |
| --- | --- | --- |
| Conception | `/workflows/conception` | Lecture et écriture des définitions : création, brouillon, validation, publication, archivage, versions. |
| Lancer | `/workflows/lancer` | Lancement, liste de ses propres instances, annulation, suspension et reprise de ses propres instances. |
| Administration | `/workflows/administration` | Liste de toutes les instances, lecture de toute instance, annulation, suspension et reprise de toute instance. **Aucun pouvoir sur les tâches d'autrui.** |
| Faible risque | (administrateur uniquement) | `POST /workflows/definitions/:id/low-risk`, avec `@RequireAdmin()`. Pas un menu. |

Règles appliquées par le code :

- **Administrateur et rôle système actif** : tous les menus (`effectiveMenuKeys`, et `isAdmin` passe le garde). Pour les
  actions sur les tâches, l'administrateur est traité comme tout autre utilisateur.
- **Principal construit depuis la base** (`PrincipalService.buildPrincipal`) : le compte doit être actif et correspondre au
  jeton. Le rôle n'est retenu que s'il est actif. L'identité machine (agent de numérisation) et tout jeton sans
  `userGroupId` sont refusés (403).
- **Boîte** : pas de menu. Le périmètre est l'assignation (utilisateur, groupe ou rôle actif). Hors périmètre : 404, pour ne
  pas révéler l'existence de l'élément. Le moteur (`isTaskAssignee`) reste l'autorité finale.
- **Détail d'une instance** : pas de menu. Accès pour le lanceur, pour un assigné de l'une de ses tâches, et pour le
  détenteur du menu administration (lecture seule). Sinon 404.
- **Annulation, suspension, reprise** : lanceur ou détenteur du menu administration. Un assigné qui peut lire l'instance mais
  n'est pas lanceur reçoit 403.
- **Objets liés** : `SubjectAccessRegistry` refuse tout type sans contrôleur enregistré (403). La vérification se fait au
  lancement et au démarrage par déclencheur, pour le compte exécutant.
- **Déclencheur** : `run_as` est le `startedBy`. Le démarrage exige que ce compte existe, soit actif et possède le menu
  lancer (administrateur compris). Un déclencheur n'a jamais plus de droits que son `run_as`.
- **Exécuteurs** : `runAs` vaut le lanceur de l'instance, jamais davantage.
- **Marquage faible risque** : réservé à l'administrateur (`isAdmin`, contrôle au service et au garde). Le retrait est refusé
  (HTTP 409) tant qu'une étape agent autonome existe (déclencheur SQL `wf_definition_low_risk_guard`).

## 6. Référence des routes REST

Préfixe : `/workflows`. Toutes les routes exigent un utilisateur authentifié (`JwtAuthGuard` global).

### 6.1 Définitions (`/workflows/definitions`)

| Méthode | Chemin | Droit requis |
| --- | --- | --- |
| GET | `/` | Conception |
| GET | `/launchable` | Lancer ou conception |
| GET | `/:id` | Conception |
| GET | `/:id/versions/:versionNumber` | Conception |
| POST | `/` | Conception (201) |
| PUT | `/:id/draft` | Conception |
| POST | `/:id/validate` | Conception (200) : renvoie les issues sans publier |
| POST | `/:id/publish` | Conception (200) : 422 si le graphe n'est pas publiable |
| POST | `/:id/archive` | Conception (200) |
| POST | `/:id/low-risk` | Administrateur (`@RequireAdmin`) (200) |

### 6.2 Instances (`/workflows/instances`)

| Méthode | Chemin | Droit requis |
| --- | --- | --- |
| POST | `/` | Lancer (201 si créée, 200 si rejeu d'une clé d'idempotence). Corps : `definitionId`, `context?`, `subjectType` et `subjectId` (ensemble), `idempotencyKey?`. |
| GET | `/` | Lancer ou administration. Sans `mine=true`, la liste complète n'est visible que pour le menu administration. |
| GET | `/:id` | Aucun menu ; lanceur, assigné d'une tâche ou administration ; sinon 404. |
| POST | `/:id/cancel` | Lancer ou administration, puis lanceur ou administration (403). Corps : `reason?`. |
| POST | `/:id/suspend` | Idem. Corps : `reason?`. |
| POST | `/:id/resume` | Idem. |

### 6.3 Boîte (`/workflows/inbox`)

Aucun menu : le périmètre est l'assignation. Les identifiants de chemin sont des **identifiants d'élément de boîte**, pas de
tâche.

| Méthode | Chemin | Corps | Effet |
| --- | --- | --- | --- |
| GET | `/` | Query `status` (liste de 0 à 5, défaut `0,1`), `limit`, `offset` | Éléments assignés à l'utilisateur, à ses groupes ou à son rôle actif. |
| POST | `/:itemId/claim` | Aucun | Prise en charge. |
| POST | `/:itemId/complete` | `{ result, expectedRowVersion? }` | Clôture avec un résultat validé par le type de tâche. |
| POST | `/:itemId/reject` | `{ comment? }` | Refus : voies conditionnées uniquement. |
| POST | `/:itemId/delegate` | `{ toUserGroupId, comment? }` | Réaffectation à un utilisateur actif (pas à soi-même). |

Réponses des actions : un `WfTransitionResult` (`instance`, `closedTasks`, `openedTasks`). Erreurs moteur : `NOT_FOUND` 404,
`FORBIDDEN` 403, `CONFLICT` 409, `INVALID_STATE` 409, `INVALID_INPUT` 422, `DEFINITION_NOT_PUBLISHED` 409,
`IDEMPOTENCY_CONFLICT` 409 (`workflow-errors.ts`).

## 7. Points d'extension

Les jetons d'injection sont dans `workflows.tokens.ts`. `WorkflowsModule` exporte `WF_ENGINE`, `WF_EXECUTOR_REGISTRY`,
`WF_TRIGGER_STARTER`, `WorkflowEventsPublisher` et `SubjectAccessRegistry`. Un module qui les utilise doit importer
`WorkflowsModule`.

### 7.1 Exécuteurs de tâches (W2 : type `agent`)

**Interface** (`engine.types.ts`) :

```ts
interface WfTaskExecutor {
  readonly taskType: string;                       // une clé de WF_TASK_TYPE_KEYS, ex. 'agent'
  execute(ctx: WfExecutorContext): Promise<WfExecutorOutcome>;
}
// ctx : { instanceId, taskId, attempt, step, context (lecture seule), runAs: { userGroupId } }
```

**Enregistrement.** Injecter `WF_EXECUTOR_REGISTRY` (type `WfTaskExecutorRegistry`) puis appeler `register(executor)`. Le
registre refuse un type inconnu, et un double enregistrement pour un même type (aucun remplacement silencieux). L'exécuteur
d'un type n'est appelé que si le registre le contient à l'entrée de l'étape. La publication d'un graphe qui contient une étape
`agent` est refusée tant que `has('agent')` est faux (`EXECUTOR_MISSING`). Au démarrage, `rescanExecutors()` relance les
exécuteurs des tâches ouvertes éligibles. Depuis W2, `WorkflowAgentsModule` enregistre l'exécuteur `agent` à l'initialisation
(`workflow-agents/executor/agent-executor.ts`) : `EXECUTOR_MISSING` n'échoue plus que si ce module est absent.
`WfExecutorContext` porte aussi `definitionId`, `definitionVersionId` et `subject`, et l'issue d'un exécuteur peut porter un
`audit` (`complete`, `propose`) ou une `escalation` (`wait`) journalisés par le moteur dans la même transaction.

Exemple d'enregistrement (illustratif) :

```ts
onModuleInit(): void {
  this.registry.register({ taskType: 'agent', execute: (ctx) => this.runAgent(ctx) });
}
```

**Résultats et effets** (`applyExecutorOutcome`) :

| Résultat | Étape agent | Étape humaine (`generation`, etc.) |
| --- | --- | --- |
| `wait` | La tâche passe à son bénéficiaire (élément kind 0, instance en attente, `task.assigned`). | Rien. La tâche reste à l'humain. |
| `complete` | Clôture immédiate, acteur `agent`, résultat validé par le type. Un résultat invalide devient une erreur (`executor.error`), puis passage à l'humain. | Converti en proposition (`propose`). |
| `propose` | Élément kind 1 : `proposal`, `explanation`, `sources`, `confidence` ; instance en attente ; tâche ouverte. `agent.proposed` est journalisé. | Idem ; pour `generation`, la suggestion est rangée dans `task.input.suggestion`. |
| `fail` | Tâche en statut 5 et instance échouée. | Idem : **quel que soit le type**, le moteur échoue l'instance. |
| Exception, réponse invalide | `executor.error` ; passage à l'humain. | `executor.error` seulement ; la tâche reste ouverte. |

Une proposition déjà en attente n'en crée pas une seconde. La proposition est acceptée telle quelle ou modifiée lors de la
clôture (`resolution.outcome`). La taille est bornée à 64 Kio. L'autonomie (`agent.autonomy`) n'est **pas** appliquée par le
moteur : W2 ne doit renvoyer `complete` que si le niveau configuré le permet.

### 7.2 Démarrage par déclencheur (W3)

Jeton `WF_TRIGGER_STARTER`, interface `WfTriggerStarter`. L'implémentation `WorkflowTriggerStarterService` existe déjà en W1 :

```ts
starter.start({
  definitionId,            // définition dont la version publiée est lancée
  startedBy,               // run_as : user_group_id
  idempotencyKey,          // obligatoire, stable pour l'événement source (1 à 200 caractères)
  triggerId,               // wf_trigger.wf_trigger_id
  subjectType, subjectId,  // facultatifs, contrôlés par SubjectAccessRegistry
  context,                 // données de lancement, rangées dans context.input
});
```

Le démarreur vérifie le `run_as` (compte actif, menu lancer), puis l'accès à l'objet lié pour ce compte. Les événements ne
sont publiés que si l'instance est créée. Le rejeu d'une même clé renvoie l'instance existante sans doublon. W3 fournit
l'événement source et la clé ; il ne contourne pas ces contrôles.

### 7.3 Contrôle d'accès aux objets liés

```ts
interface SubjectAccessChecker {
  readonly subjectType: string;
  canAccess(actor: { userGroupId: number; userId?: number }, subjectId: string): Promise<boolean>;
}
```

Enregistrer le contrôleur via `SubjectAccessRegistry.register(checker)` (module propriétaire de l'objet). Sans contrôleur,
le type est refusé. W1 ne déclare aucun contrôleur ; W3 enregistre `mail` et `document` (`workflow-triggers/access/`, voir
`docs/workflow-declencheurs.md` section 4). Un contrôleur peut aussi fournir `resolveOwner(subjectId)` (propriétaire de l'objet,
compte actif ou `null`), utilisé par `PrincipalService.resolveSubjectOwner` via `SubjectAccessRegistry.resolveOwner`.

### 7.4 Événements et notifications

`WorkflowEventsPublisher.subscribe(listener)` reçoit les `WfEngineEvent[]` après commit, et renvoie une fonction de
désabonnement. Un écouteur qui échoue est journalisé et ignoré. Types : `instance.*`, `task.assigned`, `task.completed`,
`task.rejected`, `task.delegated`.

`WorkflowNotificationsListener` (W1) s'abonne à l'initialisation :

- `task.assigned` et `task.delegated` : notification au bénéficiaire (groupe ou rôle étendu à ses membres actifs, plafond 200) ;
- `instance.completed`, `instance.failed`, `instance.cancelled`, `instance.suspended` : notification au lanceur.

Les notifications sont écrites après commit. Il n'existe pas de table d'envoi différé (outbox) : voir section 9.

### 7.5 Suggestion de rédaction (`generation`)

Interface `WfGenerationSuggester` (`suggest({ instanceId, taskId, stepKey, context, runAs })` renvoyant
`{ content, explanation?, sources?, confidence? }`). Brancher une implémentation en fournissant le jeton facultatif
`WF_GENERATION_SUGGESTER` dans `WorkflowsModule` (ou dans un module importé qui l'exporte). Le module enregistre alors
l'exécuteur `generation`. Une erreur du fournisseur ou une suggestion vide laisse la tâche à l'humain (`wait`).

La suggestion ne fait que **proposer** : elle devient un élément kind 1 que l'humain accepte, modifie ou ignore.

**Implémentation (W2).** `DraftingModule` exporte `DraftingService` et `DraftingContextService` ; `DraftingGenerationSuggester`
(`workflow-agents/drafting/`) implémente `WfGenerationSuggester` et `WorkflowAgentsModule` enregistre l'exécuteur `generation`
(voir `docs/workflow-agents.md`). `suggest` reçoit aussi `definitionId` (facultatif).

### 7.6 Annuaire (`WfDirectory`)

`PrincipalService` implémente `WfDirectory` : `isUserGroupActive`, `describeUserGroup` (libellé « lancé par … »). La méthode
facultative `resolveSubjectOwner` est implémentée depuis W3 : elle délègue au `resolveOwner` du contrôleur d'accès de l'objet
(courrier : destinataire nominatif, à défaut créateur ; document : créateur ; compte actif seulement, sinon `null`).

## 8. Tests

### 8.1 Tests unitaires (sans base)

| Fichier | Couvre |
| --- | --- |
| `apps/api/src/modules/workflows/engine/interpreter.spec.ts` | Chemins, conditions, choix d'arête, validation par type, affectation, droit d'agir. |
| `apps/api/src/modules/workflows/engine/engine.spec.ts` | Entrées refusées avant tout accès à la base ; liste de la boîte (périmètre d'assignation). |
| `apps/api/src/modules/workflows/engine/executor-registry.spec.ts` | Registre d'exécuteurs : enregistrement, refus de type inconnu et de double enregistrement. |
| `apps/api/src/modules/workflows/extension/extension.spec.ts` | Publication d'événements, notifications (expansion groupe et rôle, plafond), démarreur par déclencheur. |
| `apps/api/src/modules/workflows/definitions.service.spec.ts`, `definitions.controller.spec.ts` | Empreinte du graphe, droits d'acteur, lecture, création et brouillon ; garde de menus des définitions. |
| `apps/api/src/modules/workflows/instances.service.spec.ts`, `inbox.service.spec.ts`, `principal.service.spec.ts` | Lecture, lancement, annulation, suspension, reprise ; périmètre de la boîte ; construction du principal. |
| `apps/api/src/modules/workflows/workflow-errors.spec.ts`, `workflows.dto.spec.ts`, `workflows.module.spec.ts`, `workflows.routes.spec.ts` | Traduction des erreurs, DTO, câblage du module, accès par défaut des routes. |
| `apps/worker/src/processors/workflow-timers.spec.ts` | Relance, échéance, escalade, expiration, configuration d'escalade invalide, sur base simulée (`workflow-timers.fake-db.ts`). |

### 8.2 Tests d'intégration PostgreSQL

Deux suites, ignorées tant que `WF_TEST_DATABASE_URL` n'est pas définie :

- `apps/api/src/modules/workflows/engine/engine.integration.spec.ts` : verrous, CHECK, uniques partiels, déclencheurs.
- `apps/worker/src/processors/workflow-timers.integration.spec.ts` : réclamation `SKIP LOCKED`, CAS, effets des minuteries.

Ces suites ne suppriment rien : le journal est en ajout seul. Utiliser une **base jetable**, jamais la base de développement.
La suite du moteur refuse de tourner si `WF_TEST_DATABASE_URL` est identique à `DATABASE_URL` ; la suite des minuteries
ne contient pas ce garde et doit donc être lancée avec la même vigilance.

Créer la base :

1. Créer une base PostgreSQL 14 ou plus, vide, dédiée aux tests (serveur local jetable, par exemple `initdb` puis
   `pg_ctl start`, ou un conteneur éphémère). Créer la base avec `CREATE DATABASE docu_flow_wf_test;`.
2. Appliquer les migrations, dont `packages/db/prisma/migrations/20261121120000_add_workflow_foundations`, en pointant
   `DATABASE_URL` sur la base jetable pour cette seule commande :

   ```
   DATABASE_URL="postgresql://<utilisateur>:<mot-de-passe>@localhost:<port>/docu_flow_wf_test" pnpm --filter @archivage/db prisma:deploy
   ```

   `prisma migrate deploy` applique toutes les migrations non appliquées. La migration W1 est additive.
3. Lancer les suites avec `WF_TEST_DATABASE_URL` (même URL). Sous PowerShell :

   ```
   $env:WF_TEST_DATABASE_URL = "postgresql://<utilisateur>:<mot-de-passe>@localhost:<port>/docu_flow_wf_test"
   pnpm --filter @archivage/api test -- engine.integration
   pnpm --filter @archivage/worker test -- workflow-timers.integration
   ```

Ne jamais écrire de mot de passe réel dans le dépôt. Une base qui a déjà servi peut être recréée pour repartir d'un état propre.

### 8.3 Commandes

Depuis la racine de la copie de travail :

```
pnpm --filter @archivage/api test -- workflows
pnpm --filter @archivage/api test -- engine
pnpm --filter @archivage/worker test -- workflow-timers
pnpm --filter @archivage/api exec tsc --noEmit -p tsconfig.json
pnpm --filter @archivage/api lint
pnpm --filter @archivage/worker lint
pnpm --filter @archivage/types build      # après toute modification de packages/types
```

## 9. Limites connues et décisions

- **Le moteur vit dans `apps/api`.** Il n'existe pas de package partagé pour le moteur. Le worker n'importe pas le moteur :
  les règles de minuterie sont donc dupliquées (lecture de l'escalade, requêtes sur les tables). Toute modification d'une
  règle de transition ou d'échéance doit être reportée des deux côtés. Ce qui est partagé passe par `@archivage/types` (graphe,
  validateur, énumérations, `wfEscalationConfigSchema`).
- **Relocalisation possible.** Le moteur n'a pas de dépendance NestJS. Il dépend de `PrismaClient`, de l'horloge injectée
  et des types de `@archivage/types`. Un package dédié est donc envisageable sans réécriture.
- **Pas de blocs parallèles.** Le graphe v1 n'a qu'un seul passage actif à la fois. Une étape ne peut pas ouvrir deux
  branches simultanées.
- **Pas d'outbox.** Les notifications et événements sont publiés après commit. Un arrêt du processus entre le commit et la
  publication fait perdre cette notification. Aucune relance n'est prévue en W1.
- **`subject_owner` (résolu depuis W3).** Pour un courrier ou un document, `PrincipalService.resolveSubjectOwner` renvoie le
  propriétaire ; pour un autre type d'objet, un propriétaire introuvable ou désactivé, l'étape retombe sur le lanceur
  (`subject_owner_fallback`). Un courrier destiné à un rôle n'a pas de propriétaire nominatif : on prend son créateur.
- **Aucune étape ne crée de minuterie de nature 0 ou 3.** Les gestionnaires `registerTimerHandler` existent, mais aucun producteur
  n'est branché en W1.
- **Autonomie non appliquée par le moteur.** La règle « autonome » est contrôlée à la publication
  (`AUTONOMY_REQUIRES_LOW_RISK`) et par la base. Depuis W2, l'exécuteur `agent` la respecte à l'exécution
  (éligibilité relue en base, `docs/workflow-agents.md` section 3).
- **`fail` d'un exécuteur humain fait échouer l'instance.** Seul `complete` est converti en proposition pour un type humain.
- **Pas de délai maximal sur `execute()`.** Voir section 4.4.
- **Escalade et `expectedRowVersion`.** L'escalade incrémente `row_version`. Un client qui agit avec une version antérieure
  reçoit `CONFLICT` et doit relire la tâche.
- **Décision automatique sans voie.** Un graphe publié qui atteint une décision automatique sans arête applicable échoue
  l'instance. Le validateur ne peut pas le détecter à coup sûr pour les conditions qui dépendent des données.
- **Verrou par instance.** Toutes les transitions d'une même instance sont sérialisées. La transaction est limitée à 15 s.
