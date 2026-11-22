# Docu-Flow — données du workflow

Guide pour les développeurs des lots suivants. Schéma complet (colonnes, contraintes, relations) :
`docs/schema-base-de-donnees.md`, section 10. Sources : `packages/db/prisma/models/wf.prisma` (modèles),
`packages/db/prisma/sql/wf.sql` (CHECK, uniques et index partiels, déclencheurs), `packages/types/src/wf-enums.ts`
(miroir TypeScript des états).

## 1. Groupes de tables

| Groupe | Tables | Rôle |
| --- | --- | --- |
| Définitions | `wf_definition`, `wf_definition_version` | Workflow nommé, puis son graphe versionné ; une version publiée est immuable. |
| Exécution | `wf_instance`, `wf_task`, `wf_timer` | Une exécution, ses passages dans les étapes, ses minuteries durables. |
| Journal | `wf_event_log` | Trace append-only : décision, sources, confiance, validation. |
| Déclencheurs | `wf_trigger` | Événement qui crée une instance, avec les droits de `run_as_user_group_id`. |
| Agents, outils, autonomie | `wf_tool`, `wf_tool_grant`, `wf_agent_config`, `wf_agent_config_tool` | Registre d'outils, liste blanche par workflow, étapes agent et leurs outils. |
| Budget | `wf_budget` | Plafond et arrêt d'urgence : une ligne globale, une par workflow si besoin. |
| Évaluation | `wf_eval_set`, `wf_eval_case`, `wf_eval_run` | Jeux de test, cas, runs mesurant la précision d'une version. |
| Boîte unifiée | `wf_inbox_item` | Tâches humaines et validations d'agent, dans une seule boîte. |

## 2. Valeurs d'états

Les états sont des `SMALLINT` contrôlés par CHECK. Les constantes TypeScript (nom entre parenthèses) sont dans
`packages/types/src/wf-enums.ts`. Toute valeur ajoutée doit être reportée dans le CHECK correspondant.

| Colonne | Valeurs |
| --- | --- |
| `wf_definition.status` | 0 brouillon, 1 publié, 2 archivé (`WfDefinitionStatus`) |
| `wf_definition.source` | 0 manuel, 1 langage naturel (`WfDefinitionSource`) |
| `wf_definition_version.status` | 0 brouillon, 1 publiée (immuable), 2 archivée (`WfDefinitionVersionStatus`) |
| `wf_instance.status` | 0 en cours, 1 en attente, 2 terminée, 3 échouée, 4 annulée, 5 suspendue (`WfInstanceStatus`) ; terminales : 2, 3, 4 |
| `wf_task.task_type` | 0 formulaire, 1 génération, 2 checklist, 3 affectation, 4 validation, 5 décision, 6 agent (`WfTaskType`) |
| `wf_task.status` | 0 à faire, 1 en cours, 2 terminée, 3 annulée, 4 expirée, 5 échouée (`WfTaskStatus`) |
| `wf_task.priority`, `wf_inbox_item.priority` | 0 basse, 1 normale, 2 haute (`WfTaskPriority`) |
| `wf_timer.kind` | 0 attente, 1 relance, 2 échéance, 3 reprise (`WfTimerKind`) |
| `wf_timer.status` | 0 active, 1 déclenchée, 2 annulée (`WfTimerStatus`) |
| `wf_event_log.actor_kind` | 0 système, 1 utilisateur, 2 agent (`WfActorKind`) |
| `wf_event_log.autonomy_level`, `wf_agent_config.autonomy_level` | 0 suggère, 1 agit avec validation, 2 autonome (`WfAutonomyLevel`) |
| `wf_tool.side_effect` | 0 lecture, 1 écriture réversible, 2 externe ou irréversible (`WfToolSideEffect`) |
| `wf_budget.period_kind` | 0 mensuel, 1 journalier, 2 cumulé (`WfBudgetPeriodKind`) |
| `wf_eval_run.status` | 0 en cours, 1 terminé, 2 en erreur (`WfEvalRunStatus`) |
| `wf_inbox_item.kind` | 0 tâche humaine, 1 validation d'agent (`WfInboxItemKind`) |
| `wf_inbox_item.status` | 0 ouverte, 1 prise en charge, 2 traitée, 3 rejetée, 4 expirée, 5 annulée (`WfInboxItemStatus`) |

## 3. Règles d'or

- **Droits de l'instance** : une instance agit avec les droits de `started_by` (`user_group_id`) pendant toute
  son exécution. Pour un déclencheur, c'est `wf_trigger.run_as_user_group_id`. Il n'existe pas de droits
  « système » implicites.
- **Version publiée immuable** : dès que `published_at` est renseigné (même une fois archivée), graphe, hash,
  prompt source, numéro, `published_at` et `published_by` sont figés et la suppression est refusée
  (`wf_definition_version_immutable`) ; seul le passage 1 -> 2 (archivée) est permis, jamais un retour. La
  configuration agent (`wf_agent_config`, `wf_agent_config_tool`) d'une version publiée est figée aussi
  (`wf_agent_config_frozen`, `wf_agent_config_tool_frozen`) : **créer les configurations sur la version en
  brouillon, AVANT de la publier**. Modifier un workflow publié = créer une nouvelle version ; les
  instances en cours restent sur leur version.
- **Journal append-only** : ni UPDATE ni DELETE. Pour corriger, ajouter un événement `correction` dont
  `corrects_event_id` pointe sur l'événement corrigé.
- **Autonomie « autonome »** (niveau 2) : définition marquée faible risque (`is_low_risk`, par un administrateur)
  ET run d'évaluation réussi (`passed`) pour la même version et le même jeu. Imposé par
  `wf_agent_config_autonomy_guard`.
- **Outil irréversible** (`side_effect` = 2) : validation humaine obligatoire, quel que soit le niveau
  d'autonomie (CHECK `ck_wf_tool_irreversible_validated`).
- **Minuterie** : une ligne en base (`wf_timer`), jamais un `setTimeout`. Une seule minuterie active par
  (instance, étape, nature) (`ux_wf_timer_active`). Une relance crée une nouvelle ligne après déclenchement.
- **Idempotence des déclencheurs** : renseigner `wf_instance.idempotency_key` avec un identifiant stable de
  l'événement source. `(definition_id, idempotency_key)` est unique : rejouer un événement ne crée pas de doublon.
- **Pas de suppression d'instance** : on annule (4) ou on suspend (5). Les FK du cœur sont en RESTRICT.

## 4. Appliquer le SQL brut

La migration `20261121120000_add_workflow_foundations` contient déjà ces objets. Si la base a été créée par
`prisma db push`, les CHECK, uniques partiels, index partiels et déclencheurs n'existent pas. Les appliquer
depuis `packages/db` :

```
prisma db execute --file prisma/sql/wf.sql --schema prisma
```

Prérequis : PostgreSQL 14 ou plus (`CREATE OR REPLACE TRIGGER`), et les tables déjà créées (`prisma db push`
d'abord). Le script est ré-exécutable : les CHECK sont ajoutés dans des blocs `DO` qui ignorent
`duplicate_object`, les index utilisent `IF NOT EXISTS`, la ligne budgétaire `ON CONFLICT DO NOTHING`.

## 5. Limites connues et pistes

- **Pas de clé étrangère vers les tables existantes** (`app_user_group`, `app_group`, `role`, `document`,
  `dossier`, `mail`, `ged_ai_decision`). Piste : un lot dédié, avec les champs inverses dans `security.prisma`
  et `core.prisma`.
- **Pas de blocs parallèles dans le graphe v1** : un seul passage actif à la fois.
- **Devise par défaut `XOF`** (`wf_budget.currency`), une seule par installation. Le CHECK ne contrôle que la
  forme `^[A-Z]{3}$`, pas la liste ISO 4217.
- **Jeu d'évaluation lié à une étape autonome** : le `SET NULL` du modèle est refusé par
  `ck_wf_agent_config_autonomous_eval`. Piste : repasser l'étape en non autonome avant de supprimer le jeu,
  ou passer la liaison en RESTRICT.
- **Propriétaire de la base** : il peut retirer les déclencheurs. L'append-only est une barrière applicative.
