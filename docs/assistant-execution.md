# Assistant qui agit : exécution

Guide pour les développeurs de l'exécuteur (lot A2) et du magasin de propositions (lot A1). Contrat HTTP : `docs/assistant-api.md` (§2, §3.3 et §4). Données : `docs/assistant-donnees.md` (§3 et §4). Sources : `apps/api/src/modules/assistant/executor/` et `apps/api/src/modules/assistant/assistant.contracts.ts` (ajouts « AJOUT A2 »).

## 1. Vue d'ensemble

### 1.1 Principe

- **Aucune application sans confirmation explicite liée au contenu.** Une proposition ne s'applique que si `POST /assistant/proposals/:id/confirm` reçoit un `argsHash` égal à celui de la proposition et au hash recalculé sur ses actions stockées (section 3).
- **Effet avec les droits de l'utilisateur seul.** L'utilisateur qui confirme tient les deux rôles, valideur et lanceur (`rightsFactory.create(user, user, tx)`). Aucun droit n'est élevé et aucun droit n'est mémorisé dans la proposition.
- **Exécuteur propre à l'assistant.** Le service est `AsstExecutorService` (port `AsstExecutorPort`), avec `AsstEffectRunner` pour l'exécution. Il n'utilise ni le moteur de workflow `wf`, ni `EffectDispatcher.apply`.
- **Applicateurs du catalogue.** Les effets sont produits par les applicateurs résolus dans `ActionApplierRegistry`. `AssistantModule` importe `CatalogAppliersModule` et `CatalogExtraAppliersModule`.
- **Liste blanche.** Seuls les trois outils de `ASST_ACTION_TOOL_VALUES` sont exécutables : `proposer_imputation_courrier`, `proposer_relance`, `preparer_brouillon_reponse`. Tout autre outil, délégation comprise, est refusé avant toute écriture (`tool_not_allowed`).
- **Aucun e-mail.** `proposer_relance` crée une notification interne. Le brouillon est un document non publié.

### 1.2 Composants

| Fichier | Rôle |
| --- | --- |
| `asst-executor.service.ts` | Confirmer, refuser, lire, expirer en lot, reprendre les exécutions interrompues. |
| `asst-effect-runner.ts` | Exécution transactionnelle, traçabilité, compensations des brouillons. |
| `asst-confirm-limiter.ts` | Plafond de confirmations par utilisateur, en mémoire. |
| `asst-expiry-sweeper.ts` | Balayage périodique dans le processus. |
| `asst-actions-hash.ts` | `argsHash` : SHA-256 hexadécimal du JSON canonique des actions. |

`AssistantModule` déclare `AsstConfirmLimiter`, `AsstExecutorService` (fourni aussi sous `ASST_EXECUTOR`) et `AsstExpirySweeper`. Tous les ports (identité, porte de coût, planificateur, magasin, conversations, exécuteur) sont liés à leur implémentation dans `assistant.module.ts` ; le magasin Prisma (`AsstProposalStoreService`) existe depuis le lot A1. Les ports par défaut « non implémenté » (`not-implemented.ts`) ont été retirés en A4 ; le code d'erreur `not_implemented` reste dans le contrat et est géré par l'interface.

## 2. Cycle de vie d'une proposition

### 2.1 Statuts et transitions

```
0 Proposée ──► 1 Confirmée ──► 2 Appliquée    succès : dans la transaction des effets
    │              │
    │              └──────────► 5 Échec        échec : après rollback, ou balayage
    ├──► 3 Refusée                              refus (route refuse)
    └──► 4 Expirée                              échéance atteinte
```

Les statuts 2, 3, 4 et 5 sont terminaux. Les transitions légales sont celles de `ASST_PROPOSAL_TRANSITIONS`, miroir du déclencheur SQL `asst_proposal_guard`.

### 2.2 Qui fait quoi, dans quelle transaction

| Étape | Où | Écriture |
| --- | --- | --- |
| Confirmation 0 → 1 (CAS sur `rowVersion` et statut) | Hors transaction métier (`transitionProposal` sans `db`) | `status` 1, `confirmed_at`, `row_version` + 1 |
| Verrous de ligne (courriers, puis imputations, ordre croissant) | Transaction interactive (`maxWait` 5 s, `timeout` 15 s) | Aucune donnée métier |
| Effets des applicateurs | Même transaction | Données métier (imputations, notifications, documents) |
| Traçabilité `data_change_audit` (une ligne par effet) | Même transaction | Une ligne par effet |
| Transition 1 → 2 (CAS, dernière opération) | Même transaction (`db: tx`) | `status` 2, `result`, `finished_at` |
| Échec : rollback, puis compensation des brouillons | Hors transaction | Suppression des documents créés |
| Échec : transition 1 → 5 | Hors transaction, après compensation | `status` 5, `error_code`, `error_message` (1 000 caractères au plus) |
| Reprise des statuts 1 interrompus | Hors transaction (balayage) | 1 → 5, `execution_interrupted` |

Effets, traçabilité et transition 1 → 2 forment UNE transaction : tout ou rien. Un statut 1 qui persiste signifie donc qu'aucun effet transactionnel n'a été validé. Une proposition en statut 1 n'est jamais rejouée : toute nouvelle confirmation reçoit `proposal_not_pending`.

### 2.3 Pré-contrôles et échec

- **Pré-contrôles avant toute écriture** (`prepare`) : lot vide (`no_action`), outil hors liste blanche (`tool_not_allowed`), applicateur absent (`no_applier`), arguments refusés par le `parse` de l'applicateur (`invalid_arguments`). Les arguments de TOUTES les actions sont relus avant la première application, donc aucun brouillon n'est créé et il n'y a rien à compenser.
- **Échec avant la fin du callback de la transaction** (refus d'applicateur, erreur technique, transition 1 → 2 sans CAS, classé `proposal_state_changed`) : annulation certaine, rollback, compensations, puis transition 1 → 5.
- **Échec après la fin du callback** (erreur pendant ou après le COMMIT, dont la validation de la transaction) : issue ambiguë, traitée en section 11.1. Aucune compensation d'office.
- `run` ne lève jamais : le résultat porte l'échec explicable, que `confirm` traduit en `AsstError`.

## 3. Contrôles de la confirmation

Ordre de `AsstExecutorService.confirm`. La colonne HTTP est le statut de la réponse.

| # | Contrôle | `errorCode` | HTTP | Remarque |
| --- | --- | --- | --- | --- |
| 1 | Identité relue en base (`AsstIdentityService.resolve`) : identité machine, absence de groupe, acteur absent ou différent du jeton, compte désactivé | `identity_refused` | 403 | Seule l'identité relue sert ensuite. |
| 2 | Plafond de confirmations : 10 par utilisateur sur 60 s glissantes | `budget_exceeded` | 429 | Avant toute lecture du magasin, donc aussi pour un identifiant d'autrui. Une tentative refusée n'est pas comptée. Code réutilisé, voir section 8. |
| 3 | Propriété : proposition de l'utilisateur | `not_found` | 404 | Même réponse pour une proposition inexistante ou appartenant à un autre compte. |
| 4 | Acteur : `userId` et `userGroupId` de la ligne égaux à ceux de l'identité | `identity_refused` | 403 | Cas d'un autre profil du même compte. |
| 5 | Statut égal à 0 (« proposée ») | `proposal_not_pending` | 409 | |
| 6 | Échéance atteinte (`now >= expiresAt`) : clôture 0 → 4 en meilleur effort | `proposal_expired` | 409 | Le corps porte la proposition en statut 4 si la clôture a réussi. |
| 7 | Revalidation des actions stockées (`asstProposedActionsSchema`) | `conflict` | 409 | Contenu invalide : aucune écriture. |
| 8 | `argsHash` reçu égal à celui de la proposition | `conflict` | 409 | Contenu affiché différent. |
| 9 | `argsHash` stocké égal au hash recalculé sur les actions revalidées | `conflict` | 409 | Altération du contenu en base. |
| 10 | CAS 0 → 1 sur `rowVersion` et statut | `conflict` | 409 | Confirmation concurrente : une seule gagne. Si le déclencheur refuse 0 → 1 parce que la proposition a expiré entre-temps, la réponse est `proposal_expired`. |
| 11 | Journal de l'arrêt d'urgence global (`WfBudget`, `definitionId` nul) | aucun | aucun | Journalisé seulement, ne bloque pas. |
| 12 | Exécution (section 2.2) | `effect_forbidden` ou `effect_failed` | 403 ou 422 | Le corps porte la proposition en statut 5 (section 4.3). Issue ambiguë : pas de clôture, voir section 3.1 et section 11.1. |

Le refus (`refuse`) applique les contrôles 3, 4, 5 et 6, puis la transition 0 → 3 en CAS. Il n'est pas soumis au plafond de confirmations.

### 3.1 Codes de réponse de l'exécution

| Cas | `errorCode` HTTP | `proposal.errorCode` |
| --- | --- | --- |
| Refus de droits d'un applicateur (table 4.2) | `effect_forbidden` (403) | Code de l'applicateur |
| Refus métier d'un applicateur | `effect_failed` (422) | Code de l'applicateur |
| Pré-contrôle (section 2.3) | `effect_failed` (422) | `no_action`, `tool_not_allowed`, `no_applier` ou `invalid_arguments` |
| Erreur technique (exception non prévue) | `effect_failed` (422) | `effect_failed`, message générique |
| Transition finale 1 → 2 perdue | `effect_failed` (422) | `proposal_state_changed` |
| Issue ambiguë après COMMIT (section 11.1) | `effect_failed` (422), `details` = `{ outcome: 'uncertain' }` | Aucun : la proposition n'est pas clôturée par l'exécuteur, relue si possible |

## 4. Droits

### 4.1 Règles

- **Relecture au moment de la confirmation.** L'identité est relue en base (contrôle 1). Les menus, la visibilité des courriers et les droits sur les espaces sont relus dans la transaction, avec le client `tx` (`ApplierRightsService`).
- **Même utilisateur dans les deux rôles.** `JointApplierRights` reçoit le même utilisateur comme valideur et comme lanceur : les contrôles « valideur » et « lanceur » portent donc sur la même personne.
- **Compte inactif.** Le compte qui confirme, désactivé, est refusé à l'étape 1 (`identity_refused`). Un imputé ou un auteur d'imputation désactivé est refusé par l'applicateur (`account_inactive`, classé droits).
- **Menus relus en base.** Les menus sont calculés à partir de la base (administrateur, rôle actif, compte non désactivé). Un droit retiré entre la proposition et la confirmation produit `effect_forbidden` : la proposition ne garde aucune trace de droits.

### 4.2 Mapping des codes de refus des applicateurs

La classe est fixée par `FORBIDDEN_CODES` dans `asst-effect-runner.ts`. Tout autre code est classé « échec » (`effect_failed`).

| Code | Émis par | Classe | HTTP |
| --- | --- | --- | --- |
| `menu_denied` | `applier-rights.ts` (menu requis absent) | `effect_forbidden` | 403 |
| `mail_not_readable` | `applier-rights.ts` (courrier invisible pour l'un des deux) | `effect_forbidden` | 403 |
| `recipient_not_imputable` | `imputation.applier.ts` | `effect_forbidden` | 403 |
| `space_denied` | `draft-reply.applier.ts` (espace sans droit de contribution) | `effect_forbidden` | 403 |
| `relance_not_allowed` | `relance.applier.ts` (ni droit d'imputer, ni qualité d'auteur) | `effect_forbidden` | 403 |
| `account_inactive` | `relance.applier.ts` (imputé ou auteur inactif) | `effect_forbidden` | 403 |
| `mail_invalid` | `applier-rights.ts` (identifiant de courrier invalide) | `effect_failed` | 422 |
| `mail_not_found` | `imputation.applier.ts` | `effect_failed` | 422 |
| `duplicate_recipient`, `recipients_invalid`, `target_role_unsupported`, `inputation_type_invalid` | `imputation.applier.ts` | `effect_failed` | 422 |
| `inputation_not_found`, `inputation_treated`, `recipient_mismatch`, `not_late`, `escalation_not_author` | `relance.applier.ts` | `effect_failed` | 422 |
| `relance_cap_target`, `relance_cap_instance` | `relance.applier.ts` (plafonds) | `effect_failed` | 422 |
| `no_space`, `draft_too_large`, `draft_invalid`, `unknown_template` | `draft-reply.applier.ts` | `effect_failed` | 422 |
| `invalid_arguments` | `extra/extra-applier.utils.ts`, `imputation.applier.ts` | `effect_failed` | 422 |
| `cannot_impute`, `delegate_not_imputable`, `validator_no_profile`, `delegate_not_declared` | `delegation.applier.ts` | `effect_failed` | 422 |

La dernière ligne n'est pas atteignable : la délégation est exclue de la liste blanche. Si elle est ouverte un jour, ces codes de droits doivent être ajoutés à `FORBIDDEN_CODES`.

### 4.3 Corps `proposal` des réponses d'erreur

`effect_forbidden` et `effect_failed` renvoient la proposition en statut 5 (`AsstProposalDto`), avec `errorCode` et `errorMessage` renseignés. Le message est en français, sans contenu de courrier, tronqué à 1 000 caractères. Exception : l'issue ambiguë (section 11.1) ne clôture pas la proposition.

## 5. Verrous et concurrence

- **Ordre fixe.** `lockTargets` extrait les courriers et les imputations distincts des arguments, triés par ordre croissant. Dans la transaction, `lockMailRow` (`SELECT … FOR UPDATE`) est appliqué à chaque courrier, puis `lockMailInputationRow` à chaque imputation, avant le premier applicateur.
- **Identifiants ignorés.** Un identifiant qui n'est pas un entier positif sûr n'est pas verrouillé. Le contrôle d'existence reste à l'applicateur.
- **Double confirmation concurrente.** Le CAS 0 → 1 est hors transaction. Le second appel voit le statut 1 ou 2 (`proposal_not_pending`), ou perd son CAS (`conflict`, « traitée par une autre confirmation »). Aucun effet n'est donc exécuté deux fois.
- **Confirmation et refus concurrents.** Les deux transitions sont des CAS sur le statut 0. Le perdant reçoit `conflict`.
- **Instance sentinelle.** L'exécution ne reçoit pas d'instance de workflow. Elle porte `instanceId` et `taskId` = `asst:<proposalId>`, `stepKey` = `assistant`, `definitionVersionId` = 0 et `subject` = le premier courrier (ou `null`).
- **Conséquence sur les plafonds de relance.** Le plafond par instance compte les relances dans le journal du moteur (`wf_event_log`). `countInstanceRelancesToday` rejette tout identifiant non numérique et renvoie 0 : ce plafond est donc neutralisé pour l'assistant. Le compteur du lot en cours reste appliqué dans la même proposition. Le plafond par imputé et par jour, fondé sur les notifications de relance du jour, reste appliqué.

## 6. Compensations

- **Périmètre.** Seuls les effets non transactionnels sont compensés : les brouillons (`preparer_brouillon_reponse`). `createDocumentFromHtml` écrit hors de la transaction, sur la base et sur disque.
- **Mécanisme.** Un applicateur qui crée un brouillon renvoie une fonction `compensate` qui supprime le document et ses fichiers. Elle est idempotente et journalise sans contenu.
- **Déclenchement.** Après le rollback, dans la branche d'échec de `run`, en ORDRE INVERSE. Jamais tant que l'issue reste ambiguë (section 11.1) : la compensation n'est autorisée qu'après une relecture SOUS VERROU (`FOR UPDATE` avec `lock_timeout` court) qui établit que la transaction est annulée (statut 1 Confirmée ou 5 Échec). Chaque fonction est isolée (`try/catch`). Une seule passe est faite. Aucune exception ne remonte à l'appelant.
- **Compensation en échec.** Elle est journalisée (document à nettoyer à la main). Elle n'est pas rejouée.
- **Limite.** Si le processus s'arrête entre la création d'un brouillon et la fin de la compensation, le document reste en place. Aucun journal persistant de compensation n'existe pour le retrouver.

## 7. Traçabilité

- **`data_change_audit` dans la transaction.** Une ligne est écrite pour chaque effet, avec `tx.dataChangeAudit.create`. Elle est donc annulée avec l'effet.
- **Pourquoi pas `AuditService`.** `AuditService.dataChange` écrit via `this.prisma` et n'accepte pas de client transactionnel. Une ligne écrite hors transaction resterait même si l'effet était annulé.
- **Contenu.**

| Champ | Valeur |
| --- | --- |
| `userGroupId` | Groupe de l'utilisateur qui confirme. |
| `actorFullName` | Nom complet, ou identifiant à défaut (200 caractères au plus). |
| `objectRef` | `mail:<id>` si l'effet porte un `mailId` entier sûr, sinon `asst_proposal:<id>` (256 caractères au plus). |
| `newValue` | `via assistant ; proposition <id> ; outil <outil> ; <résumé JSON de l'effet>`. |

- **Pas de contenu de courrier.** Le résumé est celui que l'applicateur fournit. Aucun corps de brouillon ni de message n'est tracé.
- **Décision IA.** Pour un brouillon porteur d'un `decisionId`, seul l'identifiant est tracé (« décision IA <id> »). Il n'y a pas d'appel à `AiDecisionService.validate` ni à `reject` : la validation applique le patch de classement (type, date, résumé) au document, ce qui n'est pas voulu pour cette revue.
- **Journal applicatif du refus.** Le motif éventuel est écrit sur une ligne, sans caractères de contrôle, tronqué à 500 caractères.

## 8. Garde-fous

| Garde-fou | Valeur | Effet |
| --- | --- | --- |
| Plafond de confirmations | 10 par utilisateur sur 60 s (`ASST_CONFIRM_MAX_PER_MINUTE`) | 429 `budget_exceeded`. Compteur propre à chaque processus. |
| Transaction d'exécution | Attente 5 s, durée 15 s (`ASST_EFFECT_TX_OPTIONS`) | Au-delà, rollback puis échec. |
| Échéance | 15 minutes (`ASST_PROPOSAL_TTL_MINUTES`) | Contrôlée à la confirmation, indépendamment du balayage. |
| Actions par proposition | 1 à 5 (`ASST_PROPOSAL_ACTIONS_MAX`) | Contrôle de la validation de contenu. |
| Arrêt d'urgence global | `WfBudget` avec `definitionId` nul | Ne bloque pas la confirmation d'une proposition déjà préparée, qui s'applique quand même. La confirmation est journalisée (avertissement). Il bloque la création de nouvelles propositions par la porte de coût (`AsstGatePort`, lot A1). Même logique que le workflow. |
| Aucun e-mail | Non applicable | `proposer_relance` crée une notification interne ; le brouillon est un document non publié. |

**Plafond de confirmations : code réutilisé.** `budget_exceeded` (429) est le code renvoyé par le limiteur faute de code dédié. Ce plafond ne mesure pas un coût (aucun budget de dépense ni de jetons) : ce code ne doit pas être lu comme un dépassement de budget. Il devra être aligné au lot A4 (code dédié).

## 9. Expiration et balayage

### 9.1 Expiration paresseuse

`get`, `confirm` et `refuse` comparent `now` à `expiresAt`. Si l'échéance est atteinte, la proposition passe en 0 → 4 en meilleur effort, puis la réponse est `proposal_expired`. La sécurité ne dépend donc pas du balayage. Si la clôture échoue, `get` présente la proposition comme expirée, sans bouton Confirmer.

### 9.2 Balayage dans le processus

`AsstExpirySweeper` lance un passage à intervalle régulier.

- **Période.** `ASST_EXPIRY_SWEEP_MS`, 60 000 ms par défaut. La valeur 0, négative ou non numérique désactive le balayage. `NODE_ENV=test` le désactive aussi.
- **Passage.** `expireDue(now, 200)`, puis `recoverInterrupted(now, 200)`. Chaque étape est isolée. Un passage est ignoré si le précédent n'est pas terminé. La minuterie est `unref` et arrêtée à la destruction du module.

### 9.3 Décision de mise en œuvre

- Pas de `@nestjs/schedule` : cette dépendance n'est pas utilisée par le projet.
- Pas de BullMQ : le worker n'a pas accès aux services Nest.
- Multi-instance : chaque transition est un CAS sur `rowVersion`. Deux balayeurs concurrents ne traitent donc pas deux fois la même proposition.

### 9.4 Reprise des exécutions interrompues

`recoverInterrupted(now, limit, graceMs = 120 000)` retient les propositions en statut 1 confirmées avant `now - graceMs`. Chacune passe en 1 → 5 avec `error_code` = `execution_interrupted` et le message « L'exécution a été interrompue : aucun effet sur les courriers n'a été validé. Vérifiez l'état (un brouillon a pu être créé) puis refaites la demande. ». Le balayage ne supprime aucun brouillon. Le délai de grâce (120 s) dépasse le délai de transaction (15 s) et laisse le temps aux compensations.

## 10. Ajouts au contrat pour le lot A1

Le magasin Prisma (`AsstProposalStoreService`) doit implémenter les points suivants. Ils sont dans `assistant.contracts.ts`.

1. **`AsstProposalTransition.db`** (optionnel, `unknown`). Quand il est fourni, le magasin écrit la transition (CAS sur `row_version` et statut) via `(db ?? prisma).asstProposal…`, dans la transaction de l'exécuteur. Sans `db`, le comportement ne change pas. L'implémentation en mémoire l'ignore.
2. **`listStaleConfirmedProposals(before, limit)`**. Propositions au statut 1 avec `confirmed_at` antérieur à `before`, triées par `confirmed_at`, bornées. Index conseillé : `(status, confirmed_at)` partiel, `WHERE status = 1`.
3. **`getProposalActor(userId, proposalId)`**. Renvoie `{ userId, userGroupId }` de la ligne, ou `null` si la proposition est introuvable, masquée ou appartient à un autre utilisateur (même règle que `getProposal`).
4. **Rappels.** `transitionProposal` renvoie `null` si le CAS est perdu. Il peut lever une erreur, par exemple quand le déclencheur refuse 0 → 1 sur une proposition échue : l'exécuteur traite les deux cas. L'index `ix_asst_proposal_expiry` sert `listExpirableProposals` (`docs/assistant-donnees.md`, §5).

## 11. Limites connues et commandes de test

### 11.1 Limites

- **Limiteur en mémoire.** Le plafond de confirmations est propre à chaque processus. Il ne protège pas contre un client réparti sur plusieurs instances.
- **Brouillons non transactionnels.** En cas d'arrêt du processus pendant l'exécution, un document peut rester orphelin (section 6). La reprise (9.4) ne le supprime pas.
- **Une seule passe de compensation.** Une compensation en échec laisse le document en place.
- **Arrêt d'urgence.** Il n'arrête pas une proposition déjà confirmée.
- **Plafond d'instance des relances.** Neutralisé pour l'assistant (section 5).
- **Délégation exclue.** Ses codes de droits ne figurent pas dans `FORBIDDEN_CODES` (section 4.2).
- **Heure de référence.** La confirmation est jugée à l'horloge applicative (`clock`). Le déclencheur SQL se fonde sur l'heure de la base (`docs/assistant-donnees.md`, §3 et §8) : les deux peuvent différer de quelques secondes, et une confirmation dans une transaction ouverte avant l'échéance reste acceptée.
- **Issue ambiguë (erreur APRÈS la fin du callback).** Le runner distingue deux cas. Échec AVANT la fin du callback : annulation certaine, compensation permise (section 6). Échec APRÈS (COMMIT en erreur, coupure de la connexion côté client) : la transaction a pu être validée. `resolveAmbiguous` relit alors le statut de la proposition **sous verrou de ligne**.
  - **Relecture.** Chaque lecture est une transaction courte : `SET LOCAL lock_timeout` (constante `ASST_AMBIGUOUS_LOCK_TIMEOUT_MS` = 2 000 ms, champ d'instance `lockTimeoutMs`, modifiable en test), puis `SELECT status FROM asst_proposal WHERE asst_proposal_id = $1 FOR UPDATE`. Le verrou attend la fin (validation ou annulation) de la transaction encore en vol, donc la lecture ne voit jamais un statut 1 « en cours de COMMIT ». Une lecture immédiate, puis trois relectures espacées de 200, 500 et 1 000 ms (`retryDelaysMs`).
  - **Décision.**
    - **Statut 2 (« Appliquée »)** : succès. Le DTO est relu via le magasin ; s'il est illisible, nouvel essai, puis `uncertain`. Aucune compensation.
    - **Statut 1 (« Confirmée ») ou 5 (« Échec ») lu sous verrou** : transaction annulée. Compensation des brouillons (une seule passe), puis échec normal (`effect_failed`, message technique générique).
    - **Tout autre cas** : **aucune compensation**. Statut 0, 3, 4 ou inconnu, ligne absente, `lock_timeout` (SQLSTATE 55P03) sur tous les essais, lecture impossible. La réponse est `effect_failed` (422) avec `details: { outcome: 'uncertain' }` et le message « Résultat incertain : la connexion s'est interrompue pendant la validation. Vérifiez l'état de la proposition avant toute nouvelle demande. ». L'exécuteur ne clôture pas la proposition.
  - **Statut** : laissé au balayage `recoverInterrupted`. Une proposition restée en statut 1 passe en 5 avec `execution_interrupted` après 2 minutes de grâce, avec le message de la section 9.4. Une proposition validée reste en statut 2 et le balayage ne la touche pas.
  - **Brouillons** : le balayage ne supprime aucun brouillon. Si un brouillon a été créé et que la proposition n'est pas appliquée, il peut rester : à vérifier à la main (document non publié, sans e-mail). Procédure d'exploitation : `docs/assistant-deploiement.md` §5.5.
  - **Ancienne limite résiduelle fermée.** Avant la relecture sous verrou, une relecture « Confirmée » faite pendant que le COMMIT était encore en cours côté serveur pouvait déclencher la suppression de brouillons alors que la transaction finissait par être validée. Ce cas n'existe plus : la lecture attend la fin de la transaction.
  - **Note honnête.** Si la connexion du COMMIT est coupée sans que le serveur ait fini de la traiter, le verrou de ligne peut durer jusqu'à la détection de la coupure par PostgreSQL. Les relectures échouent alors en `lock_timeout` : on reste en `uncertain`, sans compensation (un brouillon supprimé à tort serait irréparable, un brouillon conservé à tort se supprime à la main).
- **Suite d'intégration ignorée par défaut.** `asst-executor.integration.spec.ts` (17 tests) est ignorée sans `WF_TEST_DATABASE_URL`. Elle s'exécute sur une base PostgreSQL jetable (section 11.2). Le parcours de bout en bout (`asst-e2e.integration.spec.ts`, 15 tests) obéit à la même règle.

### 11.2 Commandes

Tests unitaires, depuis `apps/api` :

```
npx jest src/modules/assistant/executor
```

Résultat vérifié à la rédaction : 4 suites unitaires, 104 tests réussis (5 pour le limiteur de confirmations, 41 pour le runner d'effets, 7 pour le balayeur, 51 pour le service). Les 17 tests d'intégration sont ignorés dans ce cas (1 suite ignorée).

Tests d'intégration, depuis `apps/api`, sur une base jetable :

```
WF_TEST_DATABASE_URL=postgresql://… npx jest src/modules/assistant/executor/asst-executor.integration --runInBand
```

La suite refuse de s'exécuter si `WF_TEST_DATABASE_URL` est égale à `DATABASE_URL`. C'est la même garde que `appliers.integration.spec.ts`. Sans `WF_TEST_DATABASE_URL`, la suite est ignorée. Résultat : 17 tests réussis (dont ceux de la relecture sous verrou) (vérifié sur base PostgreSQL jetable).

Parcours de bout en bout, même base jetable, en série :

```
WF_TEST_DATABASE_URL=postgresql://… npx jest src/modules/assistant/asst-e2e.integration --runInBand
```

`asst-e2e.integration.spec.ts` : 15 tests, 6 scénarios (imputation, refus, expiration, budget, droits, anti-injection), du message de l'utilisateur à l'effet en base, avec un modèle scripté. Résultat : vérifié sur base PostgreSQL jetable (15 tests réussis). Préparation de la base jetable : `docs/assistant.md` §8.
