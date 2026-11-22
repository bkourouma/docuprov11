# Assistant « qui agit » — vue d'ensemble

Point d'entrée de la documentation de l'assistant. Il décrit le principe, l'architecture par lots (A0 à A4), le flux d'un message jusqu'à l'effet, les garde-fous, les états d'une proposition, ce qui n'existe pas, et l'environnement de test. Le détail est dans les guides listés en section 3. En cas d'écart, le code fait foi (`apps/api/src/modules/assistant/`, `packages/types/src/asst-*.ts`, `apps/web/app/components/assistant/`).

## 1. Principe

**L'assistant propose, l'utilisateur confirme, l'exécuteur applique avec les droits de l'utilisateur.**

1. L'utilisateur écrit une phrase dans un panneau de chat.
2. Le planificateur lit les données autorisées (outils de lecture), puis **propose** de 1 à 5 actions. Une proposition est une ligne en base au statut 0 : elle n'a aucun effet.
3. L'interface affiche une carte de confirmation (résumé construit par le serveur, actions, échéance).
4. L'utilisateur clique sur « Confirmer » (ou « Refuser »). La confirmation porte l'`argsHash` de la carte affichée.
5. L'exécuteur applique les actions dans une transaction, avec les droits de l'utilisateur seul (il tient les rôles de valideur et de lanceur), et trace chaque effet.

Le modèle de langage n'écrit jamais dans les données métier. Seul le code, après un clic explicite, applique un effet.

Actions de la v1 (liste blanche, `ASST_ACTION_TOOL_VALUES`) :

| Outil | Effet |
| --- | --- |
| `proposer_imputation_courrier` | Une imputation par destinataire, avec délai éventuel. |
| `proposer_relance` | Notification interne à l'imputé en retard. |
| `preparer_brouillon_reponse` | Document brouillon non publié (compensable). |

## 2. Architecture par lots

| Lot | Contenu | Sources principales |
| --- | --- | --- |
| A0 | Contrats et routes : schémas zod, énumérations, codes d'erreur et statuts HTTP, catalogue `ASST_ROUTES` (8 routes sous `/assistant`), garde de menu `/assistant`, filtre d'erreurs, résolution d'identité, migration et modèles de données (4 tables `asst_*`). | `packages/types/src/asst-dto.ts`, `asst-enums.ts` ; `assistant.contracts.ts`, `assistant.controller.ts`, `identity/` ; `packages/db/prisma/models/asst.prisma`, `sql/asst.sql` |
| A1 | Planificateur (boucle de tours, outils de lecture, validateur d'actions, garde d'intention), magasin Prisma de propositions, conversations (`postMessage`), porte de coût (plafond par utilisateur et par jour, puis porte globale des agents), limiteur de débit des messages, purge. | `planner/`, `store/`, `conversations/`, `gate/` |
| A2 | Exécuteur transactionnel : contrôles de confirmation, exécution (verrous, effets, traçabilité, transition 1 vers 2 dans une seule transaction), compensations des brouillons, issue ambiguë, expiration et reprise des exécutions interrompues. | `executor/` |
| A3 | Interface web : panneau global (Drawer), liste des échanges, fil, carte de confirmation, accessibilité, gestion des erreurs. | `apps/web/app/components/assistant/`, `apps/web/app/lib/assistant-api.ts` |
| A4 | Finitions : tous les ports liés à leurs implémentations dans `assistant.module.ts` (les ports par défaut « non implémenté » sont retirés), relecture de l'issue ambiguë sous verrou de ligne, test de bout en bout (`asst-e2e.integration.spec.ts`), documentation d'exploitation. | `executor/asst-effect-runner.ts`, `asst-e2e.integration.spec.ts`, `docs/assistant-deploiement.md` |

Le code d'erreur `not_implemented` (501) reste défini dans le contrat (`AsstErrorCode.NotImplemented`, `packages/types/src/asst-enums.ts`) et l'interface le traite (« Fonction indisponible pour l'instant »). Il n'est plus produit par aucun port du module.

## 3. Index des documents

| Document | Sujet |
| --- | --- |
| `docs/assistant.md` | Ce document : vue d'ensemble. |
| `docs/assistant-api.md` | Contrat HTTP : 8 routes, erreurs, carte de confirmation, règles de sécurité de l'interface. |
| `docs/assistant-donnees.md` | Modèle de données : 4 tables, états, déclencheurs SQL, conservation et purge, budget. |
| `docs/assistant-planificateur.md` | Planificateur : boucle, outils, anti-injection et intention, porte de coût, magasin, conversations, variables, hypothèses. |
| `docs/assistant-execution.md` | Exécuteur : contrôles, droits, verrous, compensations, traçabilité, balayage, issue ambiguë. |
| `docs/assistant-interface.md` | Interface web : panneau, carte, accessibilité, écarts du contrat. |
| `docs/assistant-deploiement.md` | Déploiement et exploitation : variables `ASST_*`, migration, sauvegarde, recette, questions métier, limites. |

## 4. Flux

```
Utilisateur              API (AssistantController)                Base
-----------              -------------------------                ----
message  ───────────►  menu /assistant ? identité relue ?
                        limiteur de débit (10 messages / min)
                        porte de coût : arrêt d'urgence, plafond du jour
                        planificateur : outils de lecture (droits de l'utilisateur)
                          ├─ intention : liste blanche, échec fermé par question
                          ├─ validateur d'actions (droits, existence, plafonds)
                          └─ résumé et argsHash calculés par le CODE
                        écrit message utilisateur, message assistant ───►  asst_message
                        écrit la proposition (statut 0, +15 min) ───────►  asst_proposal
        ◄─────────────  réponse + carte (aucun effet à ce stade)

« Confirmer » (argsHash)
         ───────────►  identité relue, plafond de confirmations (10 / min)
                        propriété, acteur, statut 0, échéance
                        revalidation des actions, comparaison des hash
                        CAS 0 → 1 (Confirmée) ──────────────────────────►  asst_proposal
                        transaction : verrous (courriers, imputations),
                          effets des applicateurs, data_change_audit
                          (« via assistant »), transition 1 → 2 ─────────►  données métier,
                                                                              audit, asst_proposal
        ◄─────────────  proposition au statut 2 (ou 5 en cas d'échec)

« Refuser » ─────────►  CAS 0 → 3, aucun effet
Échéance atteinte ───►  0 → 4 (à la lecture, à la confirmation ou au balayage)
```

## 5. Garde-fous

| Garde-fou | Mécanisme | Détail |
| --- | --- | --- |
| Liste blanche d'outils | Trois outils seulement ; tout autre outil, délégation comprise, est refusé avant toute écriture (`tool_not_allowed`). | `docs/assistant-execution.md` §1.1, §2.3 |
| Anti-injection d'intention | Seul le message courant établit l'intention. Une forme directe sur liste blanche est exigée ; une réserve (négation, hypothèse, doute, report) ou un doute donne une question, jamais une action. Les données lues (courriers, noms) sont isolées comme données ; les revendications d'action du modèle (« c'est fait ») sont remplacées par une phrase fixe ; le résumé, les valeurs et le type sont décidés par le code. | `docs/assistant-planificateur.md` §5 |
| Hash des actions | `argsHash` = SHA-256 du JSON canonique des actions. La confirmation doit renvoyer le hash de la carte affichée ; l'exécuteur le compare à celui de la proposition et au hash recalculé sur les actions stockées. La base interdit de modifier `actions` et `args_hash` après création. | `docs/assistant-execution.md` §3 |
| Droits | Identité relue en base à la confirmation ; effets appliqués avec `rightsFactory.create(user, user, tx)` : menus, visibilité des courriers et droits d'espace relus dans la transaction. Un droit retiré entre la proposition et la confirmation donne `effect_forbidden` (403). Visibilité : l'auteur seul ; une proposition d'autrui répond 404. | `docs/assistant-execution.md` §4 |
| Budget | Plafond par utilisateur et par jour UTC (`asst_user_budget`), puis porte globale des agents (`wf_budget`, ligne globale) ; arrêt d'urgence global = `assistant_unavailable` pour toute nouvelle proposition ; limiteurs en mémoire : 10 messages et 10 confirmations par minute et par utilisateur. | `docs/assistant-planificateur.md` §6, `docs/assistant-deploiement.md` §1 |
| Expiration | Une proposition vaut 15 minutes. L'échéance est contrôlée à la lecture, à la confirmation et au refus, et ne dépend pas du balayage ; le déclencheur SQL refuse de confirmer une proposition échue. | `docs/assistant-execution.md` §9 |
| Transaction unique | Effets, traçabilité et transition 1 vers 2 : tout ou rien. Compensation des brouillons seulement quand l'annulation est certaine. | `docs/assistant-execution.md` §2, §6, §11.1 |
| Confirmation concurrente | CAS sur `rowVersion` et statut : une seule confirmation gagne. | `docs/assistant-execution.md` §5 |

## 6. États d'une proposition

| Valeur | État | Terminal |
| --- | --- | --- |
| 0 | Proposée | non |
| 1 | Confirmée (exécution en cours) | non |
| 2 | Appliquée | oui |
| 3 | Refusée | oui |
| 4 | Expirée | oui |
| 5 | Échec | oui |

Transitions légales (déclencheur `asst_proposal_guard`, miroir `ASST_PROPOSAL_TRANSITIONS`) : 0 vers 1, 0 vers 3, 0 vers 4, 1 vers 2, 1 vers 5. Toute autre transition est refusée. Voir `docs/assistant-donnees.md` §3.

## 7. Ce qui n'existe pas

- **Aucun e-mail n'est envoyé.** `proposer_relance` crée une notification interne ; le brouillon est un document non publié.
- **Aucune délégation.** `proposer_delegation` existe au catalogue des agents mais est exclu de la liste blanche de l'assistant ; le schéma refuse tout autre outil.
- Pas de page `/assistant` : seulement le panneau. Le menu `/assistant` sert de droit d'accès.
- Pas d'exécution sans confirmation, pas d'exécution différée ni planifiée.
- Pas de réponse par « le dernier » à une question à choix (seuls les rangs 1 à 6 en message entier sont reconnus).
- Limiteurs et réservations en mémoire par processus : pas de partage entre instances d'API.

## 8. Environnement de test

Les suites d'intégration de l'assistant s'exécutent sur une **base PostgreSQL jetable**, jamais sur la base de développement ni de production.

1. Créer un cluster temporaire (`initdb` dans un dossier temporaire, démarrage sur un port libre) et une base vide. PostgreSQL 14 ou plus.
2. La migration GED `20261120120000_add_ged_ia_foundations` exige pgvector, absent d'un cluster temporaire. La marquer comme appliquée **sur cette base jetable seulement** :

```
DATABASE_URL=postgresql://<utilisateur>@localhost:<port>/<base jetable> \
  pnpm --filter @archivage/db exec prisma migrate resolve --applied 20261120120000_add_ged_ia_foundations
```

3. Appliquer les autres migrations (dont `20261122120000_add_assistant_foundations`) :

```
DATABASE_URL=postgresql://<utilisateur>@localhost:<port>/<base jetable> \
  pnpm --filter @archivage/db exec prisma migrate deploy
```

4. Définir `WF_TEST_DATABASE_URL` avec l'URL de la base jetable. Les suites refusent de s'exécuter si elle est égale à `DATABASE_URL`, et sont ignorées si elle est absente.

Suites d'intégration concernées, à lancer depuis `apps/api`, **toujours en série** (`--runInBand` : la ligne budgétaire globale `wf_budget` est partagée) :

| Suite | Commande |
| --- | --- |
| Exécuteur (17 tests) | `npx jest src/modules/assistant/executor/asst-executor.integration --runInBand` |
| Bout en bout (15 tests, 6 scénarios) | `npx jest src/modules/assistant/asst-e2e.integration --runInBand` |
| Porte de coût | `npx jest src/modules/assistant/gate/asst-gate.integration --runInBand` |
| Magasin de propositions | `npx jest src/modules/assistant/store/asst-proposal-store.integration --runInBand` |

```
WF_TEST_DATABASE_URL=postgresql://<utilisateur>@localhost:<port>/<base jetable> \
  npx jest src/modules/assistant --runInBand
```

Sous PowerShell : `$env:WF_TEST_DATABASE_URL = "postgresql://…"` avant la commande `npx jest …`.

Note sans lien avec l'assistant (préexistante) : `drafting.service.spec` (15 tests, « sanitizeEditorHtml is not a function ») et `drafting.masking.spec` (1 test) sont instables. Quand `drafting` et `collab` sont lancés ensemble avec `--maxWorkers=4`, ils échouent environ une exécution sur trois, alors que chaque suite lancée seule passe. Les fichiers drafting, collab et editor sont identiques à `main` (`git diff main` vide). Cause probable : les `jest.mock(..., { virtual: true })` de `drafting.service.spec.ts` et la doublure `collab/persistence/editor-server.fake.ts`, qui n'exporte pas `sanitizeEditorHtml` (réexporté seulement par `@archivage/editor/server`). Non corrigé ici (hors périmètre) : à traiter dans un lot dédié. Autre piège : `turbo run build` peut restituer un `dist` en cache ; ajouter `--force` en cas de doute.
