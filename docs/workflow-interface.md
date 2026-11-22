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

Les droits d'affichage (`_lib/access.ts`, `useWorkflowAccess`) ne servent qu'à ne pas proposer ce qui sera refusé. Le
serveur reste seul juge : toute réponse 403, 404, 409 ou 422 est traduite en français par `workflowErrorMessage`.
Comme la barre latérale, un `menuKeys` absent de `/auth/me` désactive le filtre.

## 2. Navigation

Section « Docu-Flow » de `nav.ts`. Les clés des trois entrées de menu (`/workflows/conception`, `/workflows/lancer`,
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
  - évaluation d'une version (W2) : **aucune route à ce jour**. `getEvaluationStatus` renvoie `null` sans appel réseau et
    « Autonome » reste grisé.
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
  ajoute `EXECUTOR_MISSING` (impossible à calculer côté client) à « Vérifier » et à la publication. Les 16 codes sont expliqués
  en français (`graph-issues.ts` : titre, explication, comment corriger).
- Enregistrer le brouillon (`PUT draft`), vérifier (`validate`), publier (confirmation, note de version de 500 caractères au plus, `publish`).
  Avant l'envoi, `saveBlockers` détecte les problèmes de FORME que l'API refuserait en 400 (objectif d'agent vide, nom d'étape vide,
  affectation sans identifiant) et les explique en français sans rien envoyer.
  Une version publiée est **immuable** : l'éditeur est alors en lecture seule. « Créer un brouillon à partir de cette
  version » envoie le graphe de la version ouverte à `PUT draft` (l'API crée la version suivante, ou **écrase** le brouillon
  existant : confirmation demandée).
- Étape agent : objectif, outils (catalogue W2, sinon saisie des clés), seuil de confiance, niveau d'autonomie. « Autonome »
  est grisé tant que le workflow n'est pas marqué faible risque ET qu'une évaluation réussie n'est pas connue
  (`_lib/autonomy.ts`) : en W4 l'API d'évaluation n'existe pas, donc il reste grisé. Le marquage faible risque est réservé aux
  administrateurs (`LowRiskToggle`).
- Escalade : `dueInHours` obligatoire, 1 à 8760.
- Accessibilité : vue liste (`StepOutline`) équivalente au canevas, utilisable au clavier et au lecteur d'écran, ouverte par
  défaut sous 768 px ; nœuds focusables avec nom accessible ; annonces `aria-live` ; aucune information portée par la
  couleur seule.
- Emplacements W3 : `TriggersSlot` se masque tant que l'API répond 404, 403 ou vide.

## 7. Intégrer W2 et W3

- W2 : le catalogue d'outils est branché sur `/workflows/agents/tools` ; reste à brancher le statut d'évaluation quand une route existera (`workflowsApi.getEvaluationStatus`) ; `autonomyAvailability`
  autorisera « Autonome » dès que `hasPassedEvalRun` vaut `true` et que le workflow est à faible risque. Les propositions
  d'agent arrivent déjà dans la boîte (kind 1) ; le journal affiche `explanation`, `confidence` et `validatedBy`.
- W3 : `TriggersSlot` est en lecture seule ; la gestion (création, activation) reste à écrire.

## 8. Tests

Runner du dépôt (`node:test` via `tsx`) : `cd apps/web && pnpm test`. Les fichiers de test de `app/workflows/**` sont listés dans
le script `test` de `apps/web/package.json`. Logique : graphe, validation, filtres, droits, formats, navigation. Rendu serveur
léger (`renderToStaticMarkup`) pour la palette, la liste, les panneaux et la proposition d'agent. Le canevas React Flow
n'est pas testé en rendu.

Autres contrôles : `npx tsc --noEmit -p tsconfig.json`, `pnpm lint`, `npx next build` (depuis `apps/web`).

## 9. Non vérifié visuellement

Aucun rendu n'a été vu dans un navigateur : thèmes clair et sombre, bascule cartes/tableau à 768 px, canevas (glisser,
connecter, suppression au clavier), focus des tiroirs et modales, cibles tactiles, parcours réels contre l'API.

## 10. Questions ouvertes pour le superviseur

1. Boîte de tâches sans menu propre : ajouter une clé de catalogue (ou un drapeau) côté API pour afficher l'entrée à tout
   assigné ?
2. L'entrée de boîte n'expose pas la configuration d'étape (`fields`, `items`, `choices`) : l'ajouter à `WfInboxEntry`
   éviterait le formulaire générique pour les utilisateurs sans menu conception.
3. Pas d'annuaire accessible aux non-administrateurs : un endpoint de recherche d'utilisateurs (user_group_id) améliorerait
   la délégation et l'affectation.
4. Les instances ne portent pas le nom du workflow : l'ajouter au DTO de liste.
5. Persister les positions du graphe côté serveur (non prévu par le schéma) ?
6. Statut d'évaluation (W2) : route à définir pour dégriser « Autonome ».
