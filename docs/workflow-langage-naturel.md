# Docu-Flow — créer un workflow en langage naturel (lot W5)

L'utilisateur décrit son besoin en français ; l'IA propose un **brouillon** de workflow que l'on corrige dans l'éditeur
graphique. Rien n'est jamais publié automatiquement, aucun déclencheur n'est créé, aucun niveau d'autonomie n'est accordé.
Complète `docs/workflow-agents.md` (garde budget, anti-injection, masquage), `docs/workflow-interface.md` (éditeur) et
`docs/workflow-declencheurs.md` (catalogue d'événements). Aucun nouveau modèle Prisma, aucune migration. Sans IA, le reste
de Docu-Flow fonctionne : la route répond 409 « IA désactivée pour ce client ».

Code : `apps/api/src/modules/workflow-authoring/` ; web : `apps/web/app/workflows/conception/_components/authoring/`,
`apps/web/app/workflows/_lib/authoring-logic.ts`, appels dans `apps/web/app/lib/workflows-api.ts` ; types partagés :
fin de `packages/types/src/wf-dto.ts` (`WfAuthoring*`, `WfTemplateSummary`).

## 1. Routes (menu `/workflows/conception`, refus par défaut)

| Route | Effet |
| --- | --- |
| `POST /workflows/authoring/generate` | `{ description (10 à 4000 car.), triggerHint? }` (un type d'événement du catalogue W3). 201 : `{ definitionId, name, graph, issues[], assumptions[], toComplete[], triggerSuggestion }`. |
| `POST /workflows/authoring/explain/:definitionId` | Résumé en français de la dernière version (brouillon sinon la plus récente), déterministe, sans IA : `{ definitionId, versionNumber, summary, steps[], toComplete[] }`. |

Statuts de `generate` : 403 acteur non identifié ou identité machine ; 409 IA désactivée, arrêt d'urgence, masquage requis,
nom indisponible ; 422 brouillon inutilisable (`code: 'AUTHORING_INVALID'`, `issues[]`, rien n'est créé) ; 429 limite de débit
(5 par minute et par utilisateur, `Retry-After`) ou budget IA atteint ; 502 fournisseur en échec ; 503 budget illisible
(échec fermé).

## 2. Déroulé d'une génération

1. IA désactivée (`ged_ai_setting.mode = 0`) : 409, sans appel à la garde.
2. Garde de W2 (`WF_AGENT_GATE`) avant CHAQUE appel modèle : `assertRunnable` puis `reserve` (estimation prudente), `settle`
   avec les jetons réels, `release` si aucun appel n'a eu lieu. Échec fermé. Le périmètre est `definitionId: 0` : il n'y a
   pas encore de workflow, donc seul le budget **global** est débité (aucune ligne de budget de workflow n'existe pour 0).
3. Catalogue d'outils : `wf_tool.is_enabled` ; tout autre outil est retiré du graphe.
4. Prompt (`authoring.prompt.ts`) : message système FIXE (format, types d'étape, conditions, règles), description de
   l'utilisateur isolée par un jeton aléatoire par appel et neutralisée (chevrons, jeton, invisibles), rappel des règles après la
   donnée. `AiService.run` : masquage cloud obligatoire, aucune pièce jointe, schéma non strict côté fournisseur.
5. Sortie : JSON borné (128 Kio, profondeur 12, clés `__proto__`/`constructor`/`prototype` refusées),
   `authoring.output.ts`.
6. Garde-fous (`authoring.guardrails.ts`, section 3), puis `validateWorkflowGraph`.
7. Invalide : UNE seule passe de réparation (nouvelle garde, nouveau jeton, graphe précédent et problèmes comme données).
   Après réparation : forme invalide => 422 sans rien créer ; seule la sémantique en défaut (atteignabilité…) => le brouillon est
   créé et les problèmes sont renvoyés dans `issues` (à corriger dans l'éditeur).
8. Brouillon : `wf_definition` (statut brouillon, `source` = langage naturel, jamais faible risque) + version 1 brouillon avec
   `source_prompt` (description assainie, 2000 car. au plus). Nom généré, unique parmi les non-archivés (suffixe « (2) »…).
9. Audit (`data_change_audit`, `wf_authoring:definition:<id>` ou `wf_authoring:generate`) pour TOUT résultat : acteur, résultat,
   taille de la description, jetons, réparation, nombre de problèmes, compteurs des garde-fous. Jamais le texte.

## 3. Garde-fous (jamais appliqués, quoi que dise la description ou le modèle)

| Garde-fou | Effet |
| --- | --- |
| Types d'étape | Seuls les 7 types existants (sinon la validation échoue et la réparation s'applique). |
| Outils | Seulement ceux du catalogue actif ; les autres sont retirés et signalés. Ils doivent encore être autorisés pour le workflow (Administration) avant publication (`AGENT_TOOL_NOT_GRANTED`). |
| Autonomie | Toujours `suggere` ; seuil de confiance au moins 0,8 ; `model`, `maxCostPerRun` retirés ; `maxSteps` au plus 10. |
| Faible risque | Jamais posé ; toute clé `isLowRisk`/`lowRisk` est retirée. |
| Affectations | Jamais d'identifiant inventé : `assignee` n'est gardé que pour `initiator` et `subject_owner`. Une étape humaine à désigner reçoit `config.authoring = { toComplete: ['assignee'], assigneeHint: 'DAF' }` et un préfixe « À compléter : affectation (DAF). » dans sa description. Le graphe reste enregistrable (schéma partagé inchangé). **Publication bloquée** : tant qu'une étape porte le marqueur ET n'a pas d'`assignee`, `validate` et `publish` renvoient le problème `AUTHORING_TO_COMPLETE` (« Affectation à compléter à l'étape « X » », 422 à la publication ; `definitions.service.ts`, `hasAssigneeToComplete`). Renseigner une affectation (même « lanceur ») lève le blocage, le marqueur résiduel est ignoré. L'éditeur explique ce code en français (`graph-issues.ts`). |
| Escalade | `config.escalation` retirée (son schéma exige un identifiant) ; à ajouter à la main. |
| Configuration | Liste blanche de clés (`priority`, `maxAttempts`, `fields`, `items`, `choices`, `manual`) ; un marqueur `authoring` forgé est supprimé. |
| Texte | Chaînes nettoyées (invisibles, chevrons) ; une chaîne qui ressemble à une consigne détournée est remplacée par un texte neutre. |
| Taille | 30 étapes au plus. |

Les montants, seuils, délais et pourcentages lus dans la description sont listés dans `assumptions[]` (« Seuil lu dans la
description : « 5 M FCFA » soit 5 000 000 FCFA — à vérifier avant publication. »).

## 4. Suggestion de déclencheur

`triggerSuggestion` (jamais créée) : `{ eventType, label, conditions, reason, incomplete[] }`. Choix de l'événement : indice
`triggerHint`, puis événement du modèle s'il est au catalogue, puis mots-clés de tournure d'événement (« quand un courrier
arrive », « dès qu'un document est déposé », « à l'approche de l'échéance »…). Un simple mot ne suffit pas ; un workflow lancé à la
main ne donne pas de suggestion. Les conditions passent par `parseTriggerConditions` de W3 ; les champs qui sont des
identifiants de référentiel (`mailNatureId`…) ne sont jamais inventés : ils sont listés dans `incomplete` (« à choisir »), de même
que `threshold.metaDataId`. Le lanceur (`runAsUserGroupId`) reste à choisir par l'humain.

## 5. Interface

- « Décrire le besoin » (page de conception, droit de conception) : dialogue avec compteur, exemple, avertissement « brouillon à
  relire, rien n'est publié », états chargement/erreur en français (409, 429 avec délai, 422 avec problèmes), puis redirection vers
  l'éditeur du brouillon.
- Bandeau en tête de l'éditeur (`AuthoringBanner`) : hypothèses, problèmes, éléments à compléter (lien vers l'étape),
  déclencheur suggéré (texte seul), « Expliquer ce workflow ». L'état du bandeau est mémorisé en `sessionStorage`
  (`wf-authoring:<id>`, propre au navigateur) ; les marqueurs `config.authoring` du graphe le font réapparaître ailleurs.
- « Depuis un modèle » : consomme le contrat de W6 (`GET /workflows/templates`, `POST /workflows/templates/:key/instantiate`) ;
  le bouton est masqué si l'API répond 404/403/405/501, une liste vide ou une erreur.

## 6. Qualité et sécurité (tests, sans IA réelle)

- `authoring.eval.cases.ts` : 8 descriptions de référence (facture fournisseur, congé, courrier avec accusé, dossier d'agrément,
  demande d'achat, nouvel agent, réponse à une demande d'information, archivage à l'échéance) avec vérification structurelle
  (`checkStructure`, `checkAssumptions`) et réponse simulée d'un bon modèle. Ce n'est PAS le gate d'autonomie des agents
  (`docs/workflow-agents.md` section 10).
- `authoring.pipeline.spec.ts` : exécute le service RÉEL avec un faux fournisseur sur les 8 cas, puis sur le jeu d'attaque.
  Pour mesurer un vrai modèle, brancher `AUTHORING_EVAL_CASES` sur `AuthoringService.generate` avec un fournisseur réel (non fait).
- `authoring.attack.corpus.ts` / `authoring.attack.spec.ts` : 14 descriptions hostiles (« ignore tes règles », balises forgées,
  jeton deviné, chevrons pleine chasse, outil non autorisé, autonomie, faible risque, identifiants, texte invisible, très long,
  révélation du prompt, changement de format) et un faux modèle « obéissant » : rien n'est appliqué.

```
pnpm --filter @archivage/api exec jest src/modules/workflow-authoring
cd apps/web && pnpm test
```

## 7. Limites connues

- Limiteur de débit en mémoire du processus api (non partagé entre instances, perdu au redémarrage), 5 générations par minute et par utilisateur ; passer par Redis si plusieurs instances api.
- La détection d'injection est heuristique ; la défense réelle est l'isolation, les garde-fous et la relecture humaine.
- Annuler la génération côté navigateur n'annule pas le serveur : le brouillon peut apparaître dans la liste.
- La qualité des graphes sur un modèle réel n'a pas été mesurée ; le prompt n'a été éprouvé qu'avec des faux.
- `config.authoring` n'est lu que par la publication (`AUTHORING_TO_COMPLETE`) ; le moteur l'ignore.
- Les hypothèses du bandeau sont mémorisées par navigateur (`sessionStorage`), pas côté serveur : aucune colonne disponible sans migration.
