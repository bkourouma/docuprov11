# Docu-Flow — vue d'ensemble

Point d'entrée de la documentation de Docu-Flow, le module de workflows de l'application. Il résume à quoi il sert, comment il est construit, le parcours
d'un utilisateur et les garde-fous, puis renvoie vers le document détaillé de chaque sujet. Le code fait foi en cas d'écart.

## 1. À quoi sert Docu-Flow

Docu-Flow fait circuler un travail (un courrier, un document, une demande) entre des personnes et, au choix, des agents d'IA, selon un graphe d'étapes
conçu à l'écran :

- des **étapes humaines** (formulaire, validation, décision, affectation, liste de vérification, génération) confiées à une personne, un groupe, un rôle,
  au lanceur ou au propriétaire de l'objet lié ;
- des **étapes d'agent** : l'agent lit des données avec les droits de la personne qui a lancé le workflow, puis propose ou prépare une action. Sauf
  niveau « autonome » éligible, une personne valide avant tout effet ;
- des **minuteries durables** (relance, échéance, escalade, expiration) et un **journal** de chaque décision (qui, quoi, quand, sources, confiance, valideur).

Un workflow est versionné : une version publiée est immuable, les instances en cours restent sur leur version.

## 2. Architecture en une page

| Brique | Rôle | Où |
| --- | --- | --- |
| Moteur | Transitions transactionnelles, verrou optimiste, journal, création des minuteries, appel des exécuteurs après commit. Dans l'api, classe sans dépendance Nest. | `apps/api/src/modules/workflows/` (`engine/`) |
| Worker | Consomme les minuteries (relance, échéance, escalade, expiration) toutes les 15 s ; balaie les échéances de courriers et les seuils toutes les 5 min pour émettre des événements. N'importe pas le moteur. | `apps/worker/src/processors/workflow-timers.*`, `workflow-deadlines.*` |
| Module agents (W2) | Exécuteur `agent` (dans l'api, après commit), runner modèle + outils, garde (arrêt d'urgence, budget, IA active), identité du lanceur, évaluation, éligibilité à l'autonomie. | `apps/api/src/modules/workflow-agents/` |
| Catalogue d'agents (W6) | Quatre agents prêts à l'emploi et trois modèles sans agent, huit outils, applicateurs d'effets appelés à la validation humaine. | `apps/api/src/modules/workflow-agent-catalog/` |
| Déclencheurs (W3) | Un événement métier (`mail.arrived`, `document.deposited`, `deadline.reached`, `threshold.crossed`) démarre une instance avec une identité explicite, sans élargir l'accès. | `apps/api/src/modules/workflow-triggers/` |
| Langage naturel (W5) | L'IA propose un brouillon de workflow à partir d'une description ; jamais publié ni autonome automatiquement. | `apps/api/src/modules/workflow-authoring/` |
| Interface (W4, W7) | Écrans `/workflows/*` : boîte, suivi, lancement, conception, administration, outils autorisés, évaluation, plafonds. | `apps/web/app/workflows/` |
| Couche IA de la GED | Point d'appel unique vers le modèle (désactivé, local, cloud), masquage cloud, journal `ged_ai_decision`. Tous les appels d'agent y passent. | `docs/ged-ia.md` |
| Journal | `wf_event_log`, append-only, écrit dans la même transaction que l'effet qu'il décrit. | table `wf_event_log` |

```
  Navigateur (web)                    apps/api (NestJS)                                   PostgreSQL
  ----------------     HTTP          -------------------------------------------         ----------------------
  /workflows/*   ------------------> Contrôleurs (garde de menus)                        wf_definition(_version)
  boite, lancer,                      -> Moteur (workflows/engine)  ------------------>   wf_instance, wf_task
  conception,                              |  exécuteurs APRÈS commit                     wf_inbox_item
  administration                           v                                              wf_event_log (journal)
                                      Module agents ---> Couche IA GED (AiService.run)    wf_budget, wf_tool_grant
                                       (garde, outils,   -> modèle local ou cloud         wf_eval_*, wf_trigger
                                        identité du      -> ged_ai_decision               wf_timer
                                        lanceur)
                                      Catalogue W6 : applicateurs d'effets
                                       (appelés à la validation humaine, même transaction)
                                      Déclencheurs W3 <---------- file BullMQ « wf-events »
                                                                          ^
  apps/worker (BullMQ)  -----------------------------------------------------+          Redis
   - minuteries (toutes les 15 s) : relance, échéance, escalade, expiration   ---------> (files BullMQ)
   - balayages d'échéances et de seuils (toutes les 5 min) : émission d'événements
```

Choix structurants (détail dans `docs/workflow-moteur.md`) : le moteur est dans l'api, car les transitions viennent des requêtes HTTP et des exécuteurs ;
les minuteries sont des lignes en base consommées par le worker, donc durables ; l'agent s'exécute dans l'api, jamais dans le worker.

## 3. Parcours utilisateur

Les routes sont celles de l'interface web ; chaque écran n'est proposé qu'aux utilisateurs qui détiennent le menu correspondant, et le serveur reste seul juge
des droits.

1. **Concevoir** : `/workflows/conception` (liste, création, archivage) puis `/workflows/conception/<id>` (éditeur graphique, versions, publication). On peut
   partir d'un modèle du catalogue ou décrire le besoin en français (brouillon généré, à corriger). Les problèmes de validation sont expliqués en français.
2. **Autoriser les outils** (administrateur) : `/workflows/conception/<id>/outils`. Sans autorisation d'un outil pour CE workflow, la publication d'une étape
   agent qui l'utilise est refusée (`AGENT_TOOL_NOT_GRANTED`).
3. **Évaluer** : `/workflows/conception/<id>/evaluation`. Jeux d'évaluation, cas, lancement d'un run. Le niveau « autonome » n'est accordé qu'à un workflow
   marqué à faible risque (par un administrateur) dont l'étape a réussi son évaluation avec les réglages actuels.
4. **Publier** : depuis l'éditeur, après vérification ; la configuration des agents est figée à la publication.
5. **Lancer ou déclencher** : `/workflows/lancer` (lancement manuel d'un workflow publié) ; ou un déclencheur par événement, créé en conception, qui lance
   avec l'identité et les droits d'un compte désigné.
6. **Traiter en boîte** : `/workflows/boite`. Tâches humaines et validations d'agent réunies ; l'utilisateur remplit, valide, rejette ou délègue.
7. **Valider une proposition d'agent** : dans la boîte, l'explication, la proposition, les sources et la confiance sont affichées. Accepter ou modifier
   applique les actions préparées (niveau « agit avec validation »), dans la transaction de validation ; refuser n'applique rien.
8. **Suivre au journal** : `/workflows/instances` (mes instances) et le détail d'une instance (étapes franchies, journal lisible, annulation, suspension,
   reprise). `/workflows/administration` donne la vue de toutes les instances.
9. **Plafonds et arrêt d'urgence** (administrateur) : `/workflows/administration/plafonds`. Plafonds de coût global et par workflow, état de l'IA, arrêt
   d'urgence global ou par workflow : plus aucun appel au modèle, un agent en cours s'arrête au pas suivant, les tâches reviennent à une personne.

## 4. Garde-fous

| Garde-fou | Règle | Détail |
| --- | --- | --- |
| Liste blanche d'outils par workflow | Un agent n'appelle que les outils de son étape, actifs et autorisés pour le workflow (`wf_tool_grant`). Contrôlé à la publication et relu à l'exécution. | `workflow-agents.md` sections 2 et 4 |
| Niveaux d'autonomie | « suggère » (rien n'est appliqué), « agit avec validation » (l'agent prépare, une personne applique), « autonome » (réservé au faible risque évalué). Confiance sous le seuil : retour à l'humain. | `workflow-agents.md` section 3 |
| Validation humaine | Les actions préparées ne sont appliquées qu'à la validation par une personne ; un outil irréversible exige toujours une validation, quel que soit le niveau. Sans applicateur branché, la validation d'une proposition portant une action est refusée (`no_applier`, 422). | `workflow-agents.md` section 12, `workflow-agents-catalogue.md` chapitre 3 |
| Évaluation | « Autonome » exige un jeu d'évaluation lié, un run réussi pour la version et l'empreinte du comportement courant, et une précision d'au moins 0,8. Relue à chaque exécution et à la publication. | `workflow-agents.md` sections 3 et 10 |
| Plafonds de coût | Réservation atomique avant chaque appel modèle ; refus avant dépassement, échec fermé : la tâche retourne à l'humain. | `workflow-agents.md` section 8 |
| Arrêt d'urgence | Global ou par workflow, et IA désactivée : aucun appel modèle, workflow en mode humain. | `workflow-agents.md` section 8 |
| Isolation anti-injection | Le texte tiers est une donnée : bloc balisé par un jeton aléatoire par appel, sortie du modèle au schéma strict, outils en liste blanche, détection qui signale (jamais seule défense). Une proposition signalée n'applique aucune action. | `workflow-agents.md` section 7, `workflow-agents-catalogue.md` chapitre 7 |
| Identité du lanceur | L'agent agit avec les droits du lanceur, relus en base ; compte désactivé ou droit retiré : la tâche retourne à l'humain. Aucune élévation. | `workflow-agents.md` section 5 |
| Journal | Append-only, écrit dans la même transaction que l'effet ; aucun contenu de document dans le journal. | `workflow-donnees.md` section 3, `workflow-agents.md` section 6 |

## 5. Documents de référence

| Document | Contenu |
| --- | --- |
| `docs/workflow-donnees.md` | Tables du workflow (définitions, exécution, journal, agents, évaluation, budget, déclencheurs), états numériques et règles d'or (droits de l'instance, version immuable, journal append-only). |
| `docs/workflow-moteur.md` | Moteur de l'api : cycle de vie des instances et tâches, minuteries du worker, routes, points d'extension (exécuteurs, démarrage par déclencheur, applicateur d'effets). |
| `docs/workflow-agents.md` | Module agents : configuration d'étape, niveaux d'autonomie, outils de base, identité, traçabilité, anti-injection, plafonds et arrêt d'urgence, évaluation, limites. |
| `docs/workflow-agents-catalogue.md` | Catalogue W6 : quatre agents et trois modèles sans agent, huit outils, applicateurs d'effets, mise en service, hypothèses et limites. |
| `docs/workflow-declencheurs.md` | Déclencheurs par événement (W3) : catalogue d'événements, conditions, identité de lancement, idempotence, API de conception, limites. |
| `docs/workflow-interface.md` | Interface web : écrans et routes, navigation, client d'API, boîte, suivi, éditeur, écrans de garde-fous du lot W7, points non vérifiés. |
| `docs/workflow-langage-naturel.md` | Création d'un workflow en langage naturel (W5) : routes, déroulé d'une génération, garde-fous, suggestion de déclencheur, limites. |
| `docs/workflow-deploiement.md` | Déploiement et exploitation de Docu-Flow : variables d'environnement, files, ordre de démarrage, sauvegarde, arrêt d'urgence, supervision, recette et limites connues consolidées. |
| `docs/ged-ia.md` | Socle IA de la GED : modes désactivé, local et cloud, masquage, journal des décisions, file `ged-ai`. Tous les appels d'agent y passent. |
| `docs/ged-deploiement.md` | Mise en production des lots GED et IA (pile, variables, points bloquants) ; Docu-Flow s'appuie sur ce socle. |
