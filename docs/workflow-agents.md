# Docu-Flow — agents de workflow

Guide pour les développeurs des lots suivants (W3 déclencheurs, W4 interface, W6 rédacteur). Données et états :
`docs/workflow-donnees.md`. Moteur : `docs/workflow-moteur.md` (section 7.1, exécuteurs). Couche IA : `docs/ged-ia.md`.
Code : `apps/api/src/modules/workflow-agents/` (tout le code agent), modifications minimales dans
`apps/api/src/modules/workflows/` (moteur, définitions). En cas d'écart avec ce document, le code fait foi.

## 1. Architecture

```
 Moteur (WorkflowEngine, api)                      WorkflowAgentsModule
 -------------------------------                   -----------------------------------------------
 entrée dans une étape « agent »
 commit, puis exécuteur 'agent'  ---------------->  AgentTaskExecutor (executor/agent-executor.ts)
                                                     1. AgentConfigLoader : config de l'étape
                                                     2. AgentGateService : IA active ? arrêt d'urgence ? budget ?
                                                     3. AgentIdentityService : identité du LANCEUR (relue en base)
                                                     4. AgentRunner : boucle modèle + outils (runner/)
                                                         - prompt isolé par jeton (injection/)
                                                         - AiService.run (masquage cloud, ged_ai_decision)
                                                         - outils autorisés seulement (tools/)
                                                     5. decideDisposition (disposition.ts) + éligibilité autonome
 applyExecutorOutcome (même transaction) <---------  complete | propose | wait(escalation)
   + journal agent.acted / agent.proposed / agent.escalated
```

- **L'agent s'exécute dans l'api**, après commit, via `WF_EXECUTOR_REGISTRY` (jamais dans le worker). Le module
  enregistre l'exécuteur `agent` (et `generation`) à l'initialisation ; cela lève la restriction de publication de W1
  (`EXECUTOR_MISSING` n'échoue plus qu'en l'absence du module).
- Contrat partagé : `agent.contracts.ts` (ports, types, jetons `WF_AGENT_GATE`, `WF_AGENT_IDENTITY`, `WF_TOOL_REGISTRY`,
  `WF_AGENT_RUNNER`, `WF_AGENT_EVENT_SINK`).
- Le moteur ne connaît pas l'agent : il applique l'issue de l'exécuteur et journalise DANS la même transaction.

| Dossier | Rôle |
| --- | --- |
| `executor/` | Exécuteur `agent` : traduit le résultat du runner en issue moteur. |
| `runner/` | Boucle d'agent (modèle, outils, plafonds, délai). Ne lève jamais pour une cause métier. |
| `injection/` | Neutralisation du texte tiers, détection, schéma de sortie strict, constructeur de prompt. |
| `tools/` | Registre d'outils, cinq outils de base, adaptateur de données avec droits, autorisations (grants), synchronisation `wf_tool`. |
| `identity/` | Identité d'agent = lanceur, relue en base. |
| `budget/` | Garde (arrêt d'urgence, IA désactivée, plafonds atomiques) et routes d'administration. |
| `eval/` | Jeux d'évaluation, runs, éligibilité au niveau autonome. |
| `drafting/` | `WfGenerationSuggester` branché sur `DraftingService` (suggère seulement). |

## 2. Configuration d'une étape agent

Dans le graphe, `step.agent` : `objective`, `tools` (clés), `confidenceThreshold` (défaut 0,8), `autonomy`
(`suggere`, `agit_avec_validation`, `autonome`), `model`, `maxSteps`, `maxCostPerRun`.

- **Le graphe du brouillon est la source de vérité** des champs communs. La ligne `wf_agent_config` (+ `wf_agent_config_tool`)
  en est la copie d'exécution, avec ses champs propres `timeoutSeconds` (défaut 120) et `evalSetId`. Le SQL fige la
  configuration dès la mise à publication : tout se prépare sur le brouillon.
- Routes (menu Conception) : `GET /workflows/definitions/:id/draft/agents`, `PUT /workflows/definitions/:id/draft/agents/:stepKey`
  (met à jour graphe et lignes dans une transaction ; outils inconnus ou désactivés : 422 ; jeu d'un autre workflow : 422 ;
  refus du déclencheur d'autonomie : 409).
- **Publication** (`definitions-agents.ts`) : synchronisation graphe -> lignes AVANT la mise à publication, puis contrôles
  (422 avec liste d'issues) : `AGENT_TOOL_UNKNOWN`, `AGENT_TOOL_NOT_GRANTED` (outils de l'étape ⊆ `wf_tool_grant` du workflow),
  `AGENT_AUTONOMY_NOT_ELIGIBLE`, `AGENT_CONFIG_INVALID`. La config est aussi relue à l'exécution
  (`AgentConfigLoader` : outils déclarés ∩ actifs ∩ autorisés) : une autorisation retirée depuis la publication rend l'outil indisponible.
- Un nouveau brouillon copie la config de la version précédente ; une étape « autonome » y repasse au niveau 1 en base
  (le graphe garde « autonome ») : une nouvelle évaluation sera exigée à la publication.

## 3. Niveaux d'autonomie

Décision pure et testée : `disposition.ts` (`decideDisposition`).

| Situation | Issue moteur | Effet |
| --- | --- | --- |
| Arrêt du runner, résultat absent, **confiance absente ou sous le seuil** | `wait` + `escalation` | Retour à l'humain (élément de boîte kind 0, `agent.escalated`). Jamais d'action seule. |
| `suspicion_injection` | `propose` (signalée) | Proposition sans action préparée ; un humain tranche. Jamais `complete`, même autonome. |
| Niveau 0 « suggère » | `propose` | Élément kind 1 avec explication ; `suggestedActions` seulement ; rien n'est appliqué. |
| Niveau 1 « agit avec validation » | `propose` | L'agent prépare (`preparedActions`), l'humain valide en un clic ; la validation journalise `validation.accepted` / `.modified` / `.rejected` (valideur, date). |
| Niveau 2 « autonome » éligible, sans action à valider, confiance suffisante | `complete` | Agit seul ; `agent.acted` journalisé avant la clôture. |
| Niveau 2 non éligible, ou action d'écriture / irréversible préparée | `propose` | Validation humaine obligatoire. |

**Éligibilité au niveau autonome** (`eval/autonomy-eligibility.service.ts`, relue en base à CHAQUE exécution, échec fermé) :
workflow `is_low_risk`, jeu d'évaluation lié, du même workflow, actif, `min_accuracy >= 0,8`, run TERMINÉ réussi pour cette version et ce jeu
(`total_cases > 0`, `required_accuracy >= max(0,8 ; min_accuracy)`) et `results.agentSpecHash` égal à l'empreinte du comportement
courant (objectif, outils, seuil, modèle, plafonds : `workflows/agent-spec-hash.ts`). Le SQL garantit l'essentiel (faible risque, run réussi) ;
l'application ajoute le plancher, l'empreinte et le re-contrôle à la publication.

## 4. Outils

Interface `WfTool` (`agent.contracts.ts`) : clé, schéma d'entrée zod strict, JSON Schema, effet de bord (0 lecture, 1 écriture réversible,
2 irréversible), `requiresValidation`, `execute(ctx, input)` avec le principal du **lanceur**. Le registre refuse un outil de niveau 2 sans validation.

| Outil | Effet | Rôle |
| --- | --- | --- |
| `rechercher_documents` | 0 | Recherche sémantique (`SemanticSearchService`, filtre de droits dans la requête, utilisateur lanceur). |
| `lire_document` | 0 | Lecture bornée (`DraftingContextService`, `canAccess`) ; refus et inexistant : même réponse `found:false`. |
| `lire_courrier` | 0 | Lecture bornée d'un courrier (périmètre `mailScope` + confidentialité, voir ci-dessous). |
| `proposer_imputation` | 1, validation | Prépare une imputation ; **n'écrit rien**. |
| `proposer_reponse` | 1, validation | Prépare une réponse ; **n'écrit rien**. |

- Ce tableau ne liste que les cinq outils de base (W2). Les huit outils du catalogue W6 (`lister_courriers_similaires`, `lire_organigramme_imputable`,
  `lister_pieces`, `comparer_champs`, `proposer_imputation_courrier`, `preparer_brouillon_reponse`, `proposer_relance`, `proposer_delegation`)
  sont décrits dans `docs/workflow-agents-catalogue.md` (chapitre 6).
- Aucun outil, de base ou de catalogue, n'écrit lui-même : il prépare une action. `WfPreparedAction` voyage dans la proposition (kind 1) et n'est appliquée
  qu'à la validation humaine, par un applicateur (voir section 12 et `docs/workflow-agents-catalogue.md`, chapitre 3).
- Règle d'accès courrier (prudente, réversible, `tools/agent-data.adapter.ts`) : périmètre `none` refus ; `all` lisible ; `imputed` seulement
  si imputation au lanceur ou destinataire ; rang de confidentialité du lanceur >= rang requis (rapprochement par libellé avec les niveaux documentaires, refus si sans équivalent) ; administrateur exempté du seul contrôle de confidentialité.
- Autorisations : `wf_tool` est alimenté au démarrage (`WfToolSyncService`, jamais `is_enabled`). Routes admin :
  `GET /workflows/agents/tools`, `GET|PUT /workflows/agents/definitions/:id/tool-grants` (`maxCallsPerInstance`, comptés sur `agent.tool_called`).
  L'autorisation des outils par workflow s'administre à l'écran `/workflows/conception/<id>/outils` (voir `docs/workflow-interface.md`).
- Ajouter un outil : implémenter `WfTool`, l'enregistrer dans `toolRegistryProvider`, lancer l'application (synchronisation), l'autoriser par workflow.

## 5. Identité et droits

`AgentIdentityService.resolve(started_by)` relit en base : compte actif, droit de lancer (menu Lancer), `isAdmin` réel. Compte désactivé ou droit retiré :
`AgentIdentityError`, l'agent ne travaille pas et la tâche retourne à l'humain (`identity_*`). Aucune élévation : tout accès aux données passe par
l'`AuthUser` du lanceur (jamais un administrateur par défaut).

## 6. Traçabilité

| Événement (`wf_event_log`) | Écrit par | Contenu |
| --- | --- | --- |
| `agent.proposed` | moteur, même transaction que la proposition | instruction, sources, décision, confiance, autonomie, modèle, `ai_decision_id`, jetons, coût. |
| `agent.acted` | moteur, avant la clôture (autonome) | idem. |
| `agent.escalated` | moteur, avant le passage à l'humain | `decision.reason` (`low_confidence`, `emergency_stop_*`, `budget_*`, `ai_disabled`, `identity_*`, `stopped`, `tool_denied`…) FUSIONNÉ avec le détail de l'audit : `suspicion_injection`, `suspicionReasons`, `stopReason`, `toolCalls` (dont le nom, tronqué et assaini, de l'outil refusé), `rejectedTools`, seuil, actions préparées ; plus instruction, sources, confiance, modèle, jetons, coût. |
| `validation.accepted` / `.modified` / `.rejected` | moteur, à la validation humaine | `validated_by`, `validated_at`, confiance de l'élément. |
| `agent.tool_called` | `AgentEventSink` (hors moteur) | outil, effet, empreinte des arguments, nombre de sources (lectures : pas un effet). |
| `agent.tool_called` (refus) | `AgentEventSink` | appel REFUSÉ (outil non autorisé, arguments invalides, plafond) : `decision.deniedTool` (nom tronqué, assaini), `denied`, `suspicion_injection: true` ; la clé `tool` est absente, le refus ne compte donc pas dans le plafond d'appels. |

Avant de conclure (`complete` ou proposition), l'exécuteur relit la garde (arrêt d'urgence, IA) et l'identité du lanceur : une révocation survenue pendant le dernier appel modèle renvoie la tâche à l'humain (`agent.escalated`). Règle : aucun effet n'est appliqué sans événement dans la même transaction. Les appels modèle sont aussi dans `ged_ai_decision` (via `AiService`,
tâche `Autre`, `prompt_version = wf-agent-v1`). Aucun contenu de document dans le journal ni les logs : identifiants, empreintes, extraits courts de sources.

## 7. Résistance à l'injection

1. Le texte entrant (courrier, document, OCR, résultat d'outil) est de la **donnée** : bloc balisé par un jeton aléatoire PAR APPEL
   (`<<DONNEES n libellé JETON>>`), chevrons et caractères invisibles neutralisés, jeton retiré du contenu (`injection/untrusted.ts`).
2. Le message système (application) pose les règles ; l'objectif de l'étape est dans son propre bloc ; rappel des règles après les données.
3. Sortie du modèle : JSON borné (64 Kio, profondeur), schéma zod strict (`tool_call` ou `final`), clés `__proto__`/`constructor` refusées.
4. L'agent n'appelle que les outils de l'étape, avec arguments validés ; tout autre appel n'est pas exécuté et lève `suspicion_injection`.
5. Sources déclarées filtrées sur celles réellement renvoyées par un outil. Confiance hors [0,1] ramenée à `null` (jamais d'autonomie).
6. Détection heuristique (`injection/suspicion.ts`) sur les entrées, résultats d'outils et sorties : elle SIGNALE (drapeau, actions préparées supprimées,
   proposition avertissant l'humain) ; la défense réelle est l'isolation, le schéma strict, la liste blanche et la validation humaine.
Corpus d'attaques testé : `injection/injection.corpus.ts`, `runner/agent-runner.injection.spec.ts`.

## 8. Plafonds, arrêt d'urgence, IA désactivée

- `AgentGateService` : avant CHAQUE appel modèle et outil, `assertRunnable` ; `reserve` incrémente ATOMIQUEMENT (un UPDATE conditionnel par ligne, global puis
  workflow, rollback complet si l'une refuse) `consumed_amount` et `consumed_tokens` ; `settle` / `release` ajustent. Refus avant dépassement, échec fermé
  (`budget_unavailable`) : la tâche retourne à l'humain, l'instance n'est pas bloquée. Remise à zéro de période (mensuel, journalier ; cumulé jamais).
- Arrêt d'urgence global ou par workflow : plus aucun appel modèle ; un agent en cours s'arrête au pas suivant ; les tâches retournent à l'humain.
- `ged_ai_setting.mode = 0` : aucun agent ne tourne, le workflow fonctionne en mode humain (`ai_disabled`).
- Coût : tarif par 1000 jetons, variables d'environnement `WF_AGENT_COST_PER_1K_PROMPT` (défaut 5) et `WF_AGENT_COST_PER_1K_COMPLETION` (défaut 15), dans la devise du budget.
  Le solde utilise les jetons RÉELS du fournisseur quand `AiService.run` les renvoie (`promptTokens`, `completionTokens`), sinon l'estimation (prudent). Ces variables ne sont pas dans les fichiers `.env*` d'exemple : les définir dans l'environnement de l'api si le tarif par défaut ne convient pas.
- Routes admin (menu Administration, journalisées par `AuditService.dataChange`) : `GET /workflows/agents/status`, `GET|PUT /workflows/agents/budget`,
  `POST /workflows/agents/emergency-stop`.

## 9. Masquage

Tout passe par `AiService.run` : en mode cloud, masquage obligatoire (échec fermé : `masking_required`, tâche à l'humain) et aucune pièce jointe binaire n'est jamais transmise.

## 10. Évaluation

Routes (menu Conception) sous `/workflows/agents` : `eval-sets` (liste, création, lecture, modification), `eval-sets/:id/cases` (ajout, modification, désactivation),
`eval-sets/:id/runs` (liste, lancement : 202, exécution en arrière-plan), `eval-runs/:runId`,
`GET eval-status?definitionId=` (lecture seule : éligibilité à l'autonomie de chaque étape agent de la dernière version, `{ definitionId, definitionVersionId, versionNumber, steps: [{ stepKey, evalSetId, eligible, reason }] }` ; 404 workflow inconnu, 422 sans version).

- Cas : `input` (blocs de données, objet lié, contexte) et `expected` (`result` par sous-ensemble, `returnsToHuman`, `suspicionInjection`, `minConfidence`). Maximum 500 cas actifs.
- Run : exécute l'agent en `dry_run` (aucun événement d'instance, aucune écriture), avec l'identité de l'évaluateur ; précision = cas réussis / total (le poids n'entre pas : le SQL impose `accuracy = passed/total`) ;
  `passed` calculé sur la précision EXACTE ; arrêt budget ou arrêt d'urgence : run en erreur (statut 2), jamais réussi.
- Plancher : `min_accuracy >= 0,8` (`WF_EVAL_ACCURACY_FLOOR`, `packages/types/src/wf-dto.ts`) à la création ET à la modification ; un jeu ne change jamais de workflow ; version d'un autre workflow refusée. Les cas actifs sont empreints (`results.casesHash`, `workflows/agent-spec-hash.ts`) : ajouter, modifier ou désactiver un cas après un run réussi invalide l'éligibilité autonome (exécution et publication) tant qu'un nouveau run n'est pas fait.
- Runs « en cours » depuis plus d'une heure : clôturés en erreur au démarrage.

## 11. Tests

```
pnpm --filter @archivage/api exec jest src/modules/workflow-agents src/modules/workflows
```

Intégration PostgreSQL (base jetable, voir `docs/workflow-moteur.md` section 8.2) : définir `WF_TEST_DATABASE_URL` puis lancer EN SÉRIE (la ligne budgétaire globale est partagée) :

```
pnpm --filter @archivage/api exec jest -i engine.integration budget.integration eval.integration agent.integration
```

`agent.integration.spec.ts` : bout en bout moteur + exécuteur + garde + boîte + journal (proposition, autonome, sous le seuil, injection, arrêt d'urgence, plafond, lanceur désactivé, IA désactivée).

## 12. Limites connues

- **Les outils d'écriture ne font que préparer.** Les effets sont appliqués après validation humaine par les applicateurs du lot W6, dans la transaction de validation (voir `docs/workflow-agents-catalogue.md`). Port du moteur : `WfEffectApplierPort`, conteneur `WfEffectApplierHolder`, appel dans `closeTaskAndAdvance`. **Sans applicateur branché (module catalogue absent), la validation d'une proposition portant des actions est REFUSÉE** : `INVALID_INPUT`, HTTP 422, code `no_applier`, rien n'est enregistré (la tâche reste ouverte) ; ce n'est pas un « rien n'est appliqué » silencieux. Sont sans effet de ce refus : le rejet de la proposition ; l'acceptation d'une proposition sans action préparée ; une proposition de niveau 0 (`suggestedActions`, jamais appliquées) ; une proposition signalée `suspicion_injection`. Une action sans applicateur enregistré pour son outil, ou rendue en effet ignoré (`skipped`) par l'applicateur, provoque le même refus, même mêlée à des actions valides (rollback complet). Un utilisateur peut donc refuser la proposition ou la modifier en retirant l'action.
- **Schéma JSON non strict côté fournisseur** : le tour d'agent contient des objets libres (`arguments`, `result`) ; le runner envoie `strictSchema: false` (option additive de `AiCompletionRequest`, honorée par les deux fournisseurs ; strict par défaut pour tous les autres appelants). La validation zod stricte côté serveur reste la référence.
- `AiService.run` ne prend pas de modèle : `spec.model` est ignoré (`audit.model` reçoit le modèle renvoyé par le fournisseur).
- La détection d'injection est heuristique (faux positifs et négatifs possibles) ; elle ne remplace pas la validation humaine.
- Les runs d'évaluation tournent dans le processus de l'api (un redémarrage les laisse « en cours » jusqu'au nettoyage).
- La règle de confidentialité du courrier repose sur l'égalité de libellé avec les niveaux documentaires (`mail_confidentialite` n'a pas de rang).
- **Pas d'alerte de seuil pour l'instant** : `alert_threshold` est exposé en lecture (routes admin) mais aucun événement `budget.threshold_reached` n'est émis (le journal exige une instance).
