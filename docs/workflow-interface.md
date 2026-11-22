# Docu-Flow — interface web (lot W4)

Guide pour les développeurs des lots suivants (W2 agents, W3 déclencheurs) et pour la recette. Moteur et routes :
`docs/workflow-moteur.md` ; données : `docs/workflow-donnees.md`. Le code fait foi en cas d'écart.

Code : `apps/web/app/workflows/**`, client d'API `apps/web/app/lib/workflows-api.ts`, navigation
`apps/web/app/components/nav.ts` (section « Docu-Flow »).

## 1. Écrans et routes

| Route | Écran | Droit d'affichage | Fichiers |
| --- | --- | --- | --- |
| `/workflows` | Redirection vers la boîte | aucun | `page.tsx` |
| `/workflows/boite` | Boîte de tâches unifiée (tâches humaines + validations d'agent) | aucun menu : périmètre = assignation | `boite/` |
| `/workflows/instances` | Suivi de mes instances | menu lancer ou administration (`GET /workflows/instances` l'exige ; la conception seule ne suffit pas) | `instances/` |
| `/workflows/instances/[instanceId]` | Détail : étapes franchies, journal, actions | lanceur, assigné ou administration (le serveur tranche) | `instances/[instanceId]/` |
| `/workflows/lancer` | Catalogue des workflows publiés, lancement manuel | menu `/workflows/lancer` | `lancer/` |
| `/workflows/administration` | Toutes les instances, actions | menu `/workflows/administration` | `administration/` |
| `/workflows/conception` | Liste des définitions, création, archivage | menu `/workflows/conception` | `conception/` |
| `/workflows/conception/[definitionId]` | Éditeur graphique, versions, publication | menu `/workflows/conception` | `conception/[definitionId]/`, `conception/_components/` |
| `/workflows/conception/[definitionId]/outils` | Outils autorisés du workflow (liste blanche), lot W7 | menu `/workflows/administration` (`canAdminister`) | `conception/[definitionId]/outils/`, `conception/_components/tools/` |
| `/workflows/conception/[definitionId]/evaluation` | Évaluation des agents : éligibilité, jeux, cas, runs, lot W7 (`?etape=<clé>` cible une étape) | menu `/workflows/conception` (`canDesign`) | `conception/[definitionId]/evaluation/`, `conception/_components/evaluation/` |
| `/workflows/administration/plafonds` | Plafonds de coût des agents et arrêt d'urgence, lot W7 | menu `/workflows/administration` (`canAdminister`) | `administration/plafonds/`, `administration/_components/budget/` |

Les droits d'affichage (`_lib/access.ts`, `useWorkflowAccess`) ne servent qu'à ne pas proposer ce qui sera refusé. Le
serveur reste seul juge : toute réponse 403, 404, 409 ou 422 est traduite en français par `workflowErrorMessage`.
Comme la barre latérale, un `menuKeys` absent de `/auth/me` désactive le filtre.

## 2. Navigation

Section « Docu-Flow » de `nav.ts`. Lot W7 : l'entrée « Plafonds et arrêt d'urgence » (`/workflows/administration/plafonds`) n'a pas de
menu propre dans le catalogue des rôles ; elle utilise `altKeys: ['/workflows/administration']` et n'apparaît donc que pour le menu
administration, celui qu'exigent les routes de budget. Les écrans « Outils autorisés » et « Évaluation » n'ont pas d'entrée de navigation : on y
accède depuis l'éditeur (lien « Outils autorisés » de la barre d'outils, liens du panneau de l'étape agent et du panneau des problèmes). Les clés des trois entrées de menu (`/workflows/conception`, `/workflows/lancer`,
`/workflows/administration`) sont celles du catalogue `apps/api/src/modules/roles/menu-catalog.ts`. La boîte de tâches et le
suivi n'ont pas de menu propre côté API : leurs entrées utilisent `altKeys`. La boîte s'ouvre dès qu'un menu Docu-Flow est détenu ; le suivi
exige le menu lancer ou administration (comme la route de liste), jamais la conception seule.
Conséquence : un utilisateur qui n'a reçu des tâches que par assignation, sans aucun menu Docu-Flow, ne voit pas l'entrée
« Boîte de tâches » mais peut ouvrir `/workflows/boite` (lien de notification). Voir les questions en fin de document.

## 3. Client d'API (`lib/workflows-api.ts`)

- `workflowsApi` : définitions, instances, boîte (les identifiants de la boîte sont ceux des ÉLÉMENTS), emplacements W2 et W3.
- `WorkflowApiError` conserve `status`, `code`, `issues` (liste d'une publication refusée, 422) et `details`.
- `launch` renvoie `{ instance, created }` : 201 = créée, 200 = rejeu d'une clé d'idempotence.
- Emplacements des lots W2 et W3, appelés par `requestOptional` : 403, 404, 405 ou 501 donnent `null` et l'interface se masque
  ou se replie :
  - `GET /workflows/agents/tools` (W2, **menu administration**) : catalogue d'outils, `WfToolCatalogEntry` = `WfToolDto` sans
    `wfToolId` ni `createdAt`. Un concepteur sans menu administration reçoit 403 : l'éditeur retombe sur la saisie manuelle des
    clés d'outil ;
  - `GET /workflows/triggers?definitionId=` (W3, chemin confirmé) : renvoie un sur-ensemble de `WfTriggerDto` ;
  - `GET /workflows/agents/eval-status?definitionId=` (W2, branché au lot W7, **menu conception**) : `getEvalStatus` ; 403, 404, 405
    ou 501 donnent `null` (statut « indisponible »). Les autres erreurs, dont le 422 d'un workflow sans version, sont relancées.
    Forme exacte : voir la section 9 (Garde-fous : écrans du lot W7).
- Lot W7 : méthodes STRICTES (elles lèvent `WorkflowApiError`) pour les autorisations d'outils (`getToolGrants`,
  `replaceToolGrants`, `getAgentToolCatalog`), l'évaluation (jeux, cas, runs), le budget et l'arrêt d'urgence (`getAgentStatus`,
  `getAgentBudget`, `updateAgentBudget`, `setEmergencyStop`) et la configuration des étapes agent du brouillon. Seuls `listAgentTools`,
  `listTriggers`, `listTemplates` et `getEvalStatus` sont tolérants (`requestOptional`). Le statut 429 a un message français.
  `getEvaluationStatus` subsiste comme compatibilité : `hasPassedEvalRun` vaut `true` si au moins une étape est éligible.
- Messages d'erreur (`workflowErrorMessage`) : 5xx = message français fixe ; 400 = message générique avec les champs concernés
  (jamais le texte Zod brut) ; les autres statuts reprennent le message français de l'API.
- Identifiants d'instance et d'élément de boîte : entiers décimaux de 1 à 18 chiffres, contrôlés puis encodés avant tout appel
  (404 local sinon).
- `directoryApi` (`/roles`, `/users/groups/all`) : listes réservées aux administrateurs ; 403 donne `null` et la saisie
  repasse en identifiant numérique.

## 4. Boîte de tâches (`boite/`, `_lib/inbox-logic.ts`)

- Cartes empilées (mobile-first) ; retards en évidence par bordure, icône et texte « En retard de … ».
- Filtre de statut envoyé à l'API (« À traiter » 0,1 par défaut) ; nature, échéance, texte et tri appliqués côté client.
- Tiroir de détail : charge `getInstance` pour `rowVersion` (envoyé en `expectedRowVersion`) et, si l'utilisateur détient le
  menu conception, la configuration de l'étape (`fields`, `items`, `choices`, `manual`) depuis la version du graphe.
  **Sans ce droit, un formulaire générique de repli est utilisé** : l'API de boîte n'expose pas la configuration d'étape.
- Formulaire par type de tâche : formulaire, génération, checklist, affectation, validation, décision, agent. Les résultats
  sont construits par les fonctions `build*` (pures, testées) au format attendu par `validateTaskResult`.
- Validation d'agent (kind 1) : `AgentProposalPanel` affiche l'explication, la proposition, les sources et le score de
  confiance, tous en texte brut ; accepter envoie la proposition telle quelle, modifier envoie la version éditée.
- « Ne pas approuver » (clôture avec `approved: false`) est distinct de « Rejeter » (endpoint `reject`).

## 5. Suivi des instances (`instances/`, `_lib/instances-logic.ts`)

- Liste partagée `InstancesView` (`scope` : `mine` ou `all`). Le nom du workflow est résolu par `listLaunchable` (et
  `listDefinitions` si menu conception), repli « Workflow n° X ».
- Détail : étapes franchies (dérivées des tâches), journal lisible (qui, quoi, quand, confiance, valideur, autonomie, modèle,
  explication ; `describeEvent` couvre tous les types d'événement), filtre par famille.
- Actions annuler, suspendre, reprendre selon `instanceActionRights` (lanceur avec le menu lancer, ou administration, et
  état compatible).
- Lancement : données JSON facultatives (256 Kio au plus), objet lié (identifiant numérique), clé d'idempotence générée à
  chaque ouverture de la modale.

## 6. Éditeur de définitions (`conception/`)

Source de vérité : un `WfGraph` immuable (`_lib/graph-model.ts`, opérations pures) ; React Flow
(`@xyflow/react` **12.12.1**, version exacte) n'est qu'une vue dérivée (`graphToFlow`). Le graphe serveur ne contient pas de
position : la mise en page est calculée (`layoutGraph`) puis mémorisée localement (`localStorage`, clé `wf-layout:<id>`).

- Palette des sept types d'étape (clic ou glisser-déposer), canevas, panneau de propriétés (étape, transition, fiche du
  workflow), panneau des problèmes, panneau des versions.
- Vérification en direct (`validateLive`, anti-rebond 250 ms) avec `validateWorkflowGraph` + contrôle d'escalade ; le serveur
  ajoute `EXECUTOR_MISSING` (impossible à calculer côté client) à « Vérifier » et à la publication. Les 21 codes (17 avant le lot W7, 4 contrôles d'agent ajoutés) sont expliqués
  en français (`graph-issues.ts` : titre, explication, comment corriger).
- Enregistrer le brouillon (`PUT draft`), vérifier (`validate`), publier (confirmation, note de version de 500 caractères au plus, `publish`).
  Avant l'envoi, `saveBlockers` détecte les problèmes de FORME que l'API refuserait en 400 (objectif d'agent vide, nom d'étape vide,
  affectation sans identifiant) et les explique en français sans rien envoyer.
  Une version publiée est **immuable** : l'éditeur est alors en lecture seule. « Créer un brouillon à partir de cette
  version » envoie le graphe de la version ouverte à `PUT draft` (l'API crée la version suivante, ou **écrase** le brouillon
  existant : confirmation demandée).
- Étape agent : objectif, outils (catalogue W2, sinon saisie des clés), seuil de confiance, niveau d'autonomie. « Autonome »
  est grisé tant que le workflow n'est pas marqué faible risque ET que l'étape n'est pas éligible selon
  `GET /workflows/agents/eval-status` (`_lib/autonomy.ts`, `hasPassedEvalFor` par étape ; lot W7). Route indisponible (403 ou 404) :
  l'éligibilité est inconnue et « Autonome » reste grisé. Le marquage faible risque est réservé aux administrateurs (`LowRiskToggle`).
  Le panneau de l'étape agent porte aussi le bandeau pédagogique et les liens de garde-fous (section 9).
- Escalade : `dueInHours` obligatoire, 1 à 8760.
- Accessibilité : vue liste (`StepOutline`) équivalente au canevas, utilisable au clavier et au lecteur d'écran, ouverte par
  défaut sous 768 px ; nœuds focusables avec nom accessible ; annonces `aria-live` ; aucune information portée par la
  couleur seule.
- Emplacements W3 : `TriggersSlot` se masque tant que l'API répond 404, 403 ou vide.

## 7. Intégrer W2 et W3

- W2 : le catalogue d'outils est branché sur `/workflows/agents/tools`, et le statut d'évaluation sur `GET /workflows/agents/eval-status`
  (`workflowsApi.getEvalStatus`, lot W7) ; `autonomyAvailability` autorise « Autonome » quand l'étape est éligible (`eligible`) et que le
  workflow est à faible risque. Les propositions d'agent arrivent dans la boîte (kind 1) ; le journal affiche `explanation`,
  `confidence` et `validatedBy`.
- W3 : `TriggersSlot` est en lecture seule ; la gestion (création, activation) reste à écrire.

## 8. Tests

Runner du dépôt (`node:test` via `tsx`) : `cd apps/web && pnpm test`. Les fichiers de test de `app/workflows/**` sont listés dans
le script `test` de `apps/web/package.json`. Logique : graphe, validation, filtres, droits, formats, navigation. Rendu serveur
léger (`renderToStaticMarkup`) pour la palette, la liste, les panneaux et la proposition d'agent. Le canevas React Flow
n'est pas testé en rendu.

Autres contrôles : `npx tsc --noEmit -p tsconfig.json`, `pnpm lint`, `npx next build` (depuis `apps/web`).

## 9. Garde-fous : écrans du lot W7

Logique pure (testée, sans React) : `_lib/guardrails-logic.ts` (outils, bandeau), `_lib/eval-logic.ts` (évaluation), `_lib/budget-logic.ts`
(plafonds), `_lib/guardrails-links.ts` (chemins figés), `_lib/graph-issues.ts` (explications), `conception/_components/panels/editor-guardrails.ts`
(état par étape dans l'éditeur). Le serveur reste juge : aucune règle n'est appliquée par l'écran seul.

- **Outils autorisés** (`/workflows/conception/<id>/outils`, administrateurs : menu administration ; sinon écran d'accès refusé). Charge le
  catalogue (`getAgentToolCatalog`) et les autorisations (`getToolGrants`), fusionnés en lignes (`buildGrantRows`) : case à cocher, effet de
  bord (lecture, écriture réversible, irréversible), validation requise, plafond d'appels par instance (vide = illimité, 1 à 2 147 483 647).
  Un outil autorisé mais absent du catalogue est une ligne « orpheline ». Le bouton « Autoriser les outils utilisés par ce workflow » coche les outils du
  graphe (avertit pour un outil irréversible, désactivé ou inconnu) ; une alerte liste les outils utilisés mais non autorisés
  (`AGENT_TOOL_NOT_GRANTED` à la publication). L'enregistrement (`replaceToolGrants`) remplace l'ensemble des autorisations après confirmation
  qui résume les différences ; les avertissements non bloquants de l'API sont affichés ; garde de sortie sur les modifications non enregistrées.
- **Bandeau pédagogique de l'étape agent** (`AutonomyBanner`, sous le sélecteur d'autonomie) : « suggère » = rien n'est appliqué (l'agent propose,
  aucun effet n'est exécuté) ; « agit avec validation » = l'agent prépare, une personne applique ; « autonome » = réservé aux workflows à faible
  risque dont l'évaluation a réussi, aucun effet irréversible sans validation humaine. Une clé inconnue retombe sur « suggère ». En lecture
  seule, l'éligibilité n'est pas affirmée. Le panneau affiche aussi la raison d'inéligibilité et les liens vers l'évaluation et les outils
  autorisés (ce dernier réservé aux administrateurs).
- **Évaluation** (`/workflows/conception/<id>/evaluation`, menu conception ; `?etape=<clé>` choisit l'étape). Éligibilité de l'étape (état, raison,
  action suivante, liste de conditions : faible risque, jeu lié, cas actifs, run réussi), jeux d'évaluation (création, modification, lien avec
  l'étape, seuil de précision d'au moins le plancher `WF_EVAL_ACCURACY_FLOOR` = 0,8), cas (500 actifs au plus, 64 Kio par cas), lancement d'un run
  et historique. Un run en cours est interrogé à intervalle croissant de 1,5 à 5 s, abandonné après 15 minutes ; verdict en texte (réussi, échoué,
  en cours, en erreur) avec le détail par cas. Pour le rôle du seuil et le calcul de l'éligibilité, voir `docs/workflow-agents.md` (sections 3 et 10).
- **Statut d'évaluation** : `GET /workflows/agents/eval-status?definitionId=<id>` (menu conception, `eval.controller.ts`) renvoie, pour la dernière version,
  `{ definitionId, definitionVersionId, versionNumber, steps: [{ stepKey, evalSetId, eligible, reason }] }` (`reason` : texte français si non éligible, `null`
  sinon ; `evalSetId` nul sans jeu lié). 404 : workflow inconnu ; 422 : workflow sans version. Côté client, `getEvalStatus` donne `null` pour 403, 404,
  405 ou 501. L'éditeur le charge à l'ouverture, au retour sur l'onglet ou la fenêtre (au plus un rafraîchissement par 1,5 s) et après un enregistrement ; une
  erreur réseau garde le dernier état connu. Une étape absente de la réponse (ajoutée depuis le dernier enregistrement) est « inconnue ».
- **Plafonds et arrêt d'urgence** (`/workflows/administration/plafonds`, administrateurs). Bandeau d'état (IA activée ou non, arrêt global avec auteur,
  date et motif, workflows à l'arrêt), carte de consommation du plafond global et de chaque workflow (barre et libellé texte : « Dans le budget »,
  « Seuil d'alerte atteint », « Plafond atteint ou dépassé », « Sans plafond »). Modification du plafond (vide = pas de plafond ; 4 décimales ; devise
  en trois lettres ; seuil d'alerte en pourcentage) avec confirmation quand le nouveau plafond bloque immédiatement. Arrêt d'urgence global ou par
  workflow : activer demande de saisir le mot « ARRÊT » et un motif ; le lever demande une confirmation simple. Le seuil d'alerte n'émet aucun événement
  côté serveur (voir `docs/workflow-agents.md`, section 12).
- **Explications des codes d'issue** (`graph-issues.ts`, panneau des problèmes ; la liste passe de 17 à 21 codes). `AGENT_TOOL_UNKNOWN` : outil absent du catalogue
  ou désactivé, à retirer de l'étape ou à faire réactiver. `AGENT_TOOL_NOT_GRANTED` : outil non autorisé pour CE workflow, lien « Ouvrir « Outils
  autorisés » » pour un administrateur, sinon « demandez à un administrateur ». `AGENT_AUTONOMY_NOT_ELIGIBLE` : « autonome » sans faible risque ni évaluation
  réussie avec les réglages actuels, lien « Ouvrir l'évaluation » vers l'étape. `AGENT_CONFIG_INVALID` : objectif vide, seuil hors de 0 à 1, nombre
  d'actions, délai ou coût hors limites. Après un refus de publication, le panneau des problèmes s'ouvre.
- **Navigation** : entrée « Plafonds et arrêt d'urgence » ajoutée (section 2) ; lien « Outils autorisés » dans la barre d'outils de l'éditeur
  (administrateurs seulement).

## 10. Non vérifié visuellement

Aucun rendu n'a été vu dans un navigateur : thèmes clair et sombre, bascule cartes/tableau à 768 px, canevas (glisser,
connecter, suppression au clavier), focus des tiroirs et modales, cibles tactiles, parcours réels contre l'API.

Lot W7, écrans non vus : outils autorisés, évaluation, plafonds et arrêt d'urgence, bandeau d'autonomie, liens du panneau des problèmes. Non
vérifiés : thèmes clair et sombre, mise en page à 360 px, focus et fermeture des modales (confirmation d'enregistrement, saisie du mot « ARRÊT », édition
des jeux et des cas), annonces `aria-live` (enregistrement, fin d'un run, arrêt d'urgence), cibles tactiles, et parcours réels contre l'API
(interrogation d'un run, enregistrement des autorisations, arrêt d'urgence).

## 11. Questions ouvertes pour le superviseur

1. Boîte de tâches sans menu propre : ajouter une clé de catalogue (ou un drapeau) côté API pour afficher l'entrée à tout
   assigné ?
2. L'entrée de boîte n'expose pas la configuration d'étape (`fields`, `items`, `choices`) : l'ajouter à `WfInboxEntry`
   éviterait le formulaire générique pour les utilisateurs sans menu conception.
3. Pas d'annuaire accessible aux non-administrateurs : un endpoint de recherche d'utilisateurs (user_group_id) améliorerait
   la délégation et l'affectation.
4. Les instances ne portent pas le nom du workflow : l'ajouter au DTO de liste.
5. Persister les positions du graphe côté serveur (non prévu par le schéma) ?
6. (Levée au lot W7) Statut d'évaluation : la route `GET /workflows/agents/eval-status` existe et dégrise « Autonome » par étape (section 9).
