# Docu-Flow — déclencheurs par événement (lot W3)

Un workflow n'est plus lancé à la main : un événement métier (courrier arrivé, document déposé, échéance atteinte, seuil
dépassé) démarre une instance, avec les droits d'une identité explicite et sans jamais élargir l'accès. Complète
`docs/workflow-donnees.md` (table `wf_trigger`) et `docs/workflow-moteur.md` (sections 4.3, 5, 7.2, 7.3). Aucun nouveau
modèle Prisma, aucune migration.

Sources : `apps/api/src/modules/workflow-triggers/` (module, bus, répartiteur, accès, CRUD),
`apps/worker/src/processors/workflow-deadlines.*.ts` (balayages et émission depuis le worker).

## 1. Vue d'ensemble

```
 Modules existants (api)            Worker                          apps/api
 -----------------------            ------                          ---------------------------------
 MailsService.createArrivee         ingestion.ts (3 fonctions)      WorkflowEventBus (en mémoire)
   -> bus.emit(mailArrivedEvent)      -> emitWorkflowEvent  ----->  file BullMQ « wf-events »
                                    balayage échéances / seuils           |  WorkflowEventsConsumer
                                      (toutes les 5 min)  ------->        v
                                                                    WorkflowEventBus
                                                                          |  (un événement à la fois)
                                                                          v
                                                                    WorkflowTriggerDispatcher
                                                                          |  conditions, idempotence,
                                                                          |  plafond, lanceur, accès objet
                                                                          v
                                                                    WF_TRIGGER_STARTER -> moteur (W1)
```

| Composant | Fichier | Rôle |
| --- | --- | --- |
| Domaine | `domain/contracts.ts`, `event-catalog.ts`, `conditions.ts`, `events.ts` | Contrat, catalogue fermé de champs, conditions, clé d'idempotence, constructeurs d'événements. |
| Bus | `bus/workflow-event-bus.ts` | File mémoire bornée (5 000), écouteurs séquentiels, `emit` ne lève jamais. Module global. |
| Répartiteur | `dispatch/triggers.dispatcher.ts` | Applique les règles de la section 5 pour chaque déclencheur concerné. |
| Consommateur | `dispatch/workflow-events.consumer.ts` | Lit `wf-events` (produite par le worker), valide, republie sur le bus. |
| Arrêt d'urgence | `dispatch/emergency-stop.ts` | Lit `wf_budget` ; jeton remplaçable `WF_EMERGENCY_STOP_GATE`. |
| Accès aux objets | `access/*.ts` | Contrôleurs `mail` et `document`, `resolveOwner`. |
| CRUD | `triggers.controller.ts`, `triggers.service.ts`, `triggers.dto.ts` | Conception, menu `/workflows/conception`. |
| Worker | `workflow-deadlines.*` | Balayages d'échéances et de seuils, émetteur, clés d'idempotence (dupliquées). |

## 2. Événements

Le catalogue des champs est FERMÉ (`event-catalog.ts`). Un événement ne transporte que des identifiants, codes, nombres,
booléens et dates ISO. Les chaînes sont limitées à `[A-Za-z0-9_.:+-]{1,40}` (aucun espace : impropre à porter une
phrase). **Un courrier entrant externe est de la donnée** : son objet, sa description, sa référence et tout texte extrait
n'entrent jamais dans un événement, une condition ou le contexte de l'instance.

| Type | Objet | Émis par | Champs (`subject.<champ>`) |
| --- | --- | --- | --- |
| `mail.arrived` | `mail` | `MailsService.createArrivee`, après commit | `mailType`, `status`, `mailNatureId`, `confidentialiteId`, `externalEntityId`, `destinataireRoleId`, `destinataireUserGroupId`, `organigrammeId`, `mailObjetId`, `hasDocument`, `hasDeadline`, `dateButoire` |
| `document.deposited` | `document` | worker : `persistDocument` (acquisition), `persistMergedDocument` (fusion), `ingestExternalFile` (externe) ; api : création depuis l'éditeur collaboratif (`editeur`) et promotion d'un scan (`scan`) ; pour ces deux sources seul `createdBy` est renseigné, les autres champs (`documentTypeId`, `planId`, `locationId`, `dossierId`, `confidentialiteId`, `batchId`, `pageCount`) valent `null` | `documentTypeId`, `planId`, `locationId`, `dossierId`, `confidentialiteId`, `batchId`, `createdBy`, `pageCount`, `source` |
| `deadline.reached` | `mail` | balayage du worker (5 min) | `mailType`, `status`, `mailNatureId`, `confidentialiteId`, `externalEntityId`, `destinataireRoleId`, `destinataireUserGroupId`, `dateButoire`, `hoursOverdue` |
| `threshold.crossed` | `document` | balayage du worker (5 min) | `documentTypeId`, `dossierId`, `metaDataId`, `value`, `thresholdValue` |

Le catalogue est aussi exposé par `GET /workflows/triggers/catalog` (menu de conception).

### Échéance atteinte

Courrier dont `date_butoire` est renseignée, non supprimé, non traité (`date_traited` nul), avec
`date_butoire <= maintenant + leadHours` et `date_butoire >= maintenant - 30 jours`. `leadHours` (0 à 8 760) vient de
`conditions.deadline` ; 0 = échéance échue. L'occurrence de l'événement est le jour UTC de la date butoir : une échéance
déplacée sur un autre jour relance, la même date ne relance pas. Au-delà de 30 jours de dépassement, le courrier n'est
plus balayé.

### Seuil dépassé

Métadonnée de type Entier (`metadata.data_type = 2`) d'un document, valeur conforme `^-?[0-9]{1,15}$`, comparée au seuil de
`conditions.threshold` (`gt` ou `gte`). Un seul lancement par (déclencheur, document) : pas d'occurrence, donc une valeur
qui repasse sous le seuil puis le redépasse ne relance pas. Seuls les documents épurés (`document_state = 3`, DUA expirée) sont exclus (constante `PURGED_DOCUMENT_STATE` du worker) :
l'état 1 (Archivé) désigne des documents validés et reste évalué.

### Filtrage et parcours des balayages

Les balayages du worker reportent en SQL (valeurs en paramètres, colonnes et opérateurs en liste blanche) les conditions
`match` portant sur des champs numériques mappables à une colonne ; le filtre est un sur-ensemble de ce que l'api acceptera
(`neq` inclut NULL, `exists` = non nul ; chaînes, booléens et champs inconnus ne sont pas reportés). Le parcours se fait par
curseur keyset en mémoire, par déclencheur (échéances : `(date_butoire, mail_id)` ; seuils : `document_id`) : une page plus
courte que la limite (200) remet le curseur à zéro. Un objet non conforme ou refusé ne masque donc plus les autres ; il peut
être réémis une fois par cycle. L'api reste l'arbitre final (conditions, accès, idempotence).

## 3. Conditions d'un déclencheur (`wf_trigger.conditions`)

```json
{
  "match": [
    { "field": "subject.mailNatureId", "op": "in", "value": [3, 4] },
    { "field": "subject.hasDocument", "op": "eq", "value": true }
  ],
  "deadline":  { "leadHours": 24 },
  "threshold": { "metaDataId": 12, "op": "gte", "value": 1000000 },
  "limits":    { "maxLaunches": 30, "windowMinutes": 60 }
}
```

- `{}` est valide : tout événement du type convient.
- `match` : toutes les conditions doivent être vraies. Elles sont évaluées par `evaluateCondition` du moteur (même
  sémantique que les arêtes d'un workflow : chemin absent = faux, comparaisons d'ordre numériques seulement).
- Champs : `subject.<champ du catalogue>` UNIQUEMENT, validé à la création. Opérateurs fermés : `eq`, `neq`, `gt`, `gte`,
  `lt`, `lte`, `in`, `exists`. Les comparaisons d'ordre sont refusées sur un champ non numérique. La valeur doit avoir le
  genre du champ. Aucune expression, aucun chemin libre, aucun code.
- `deadline` n'est admis que pour `deadline.reached`. `threshold` est admis et obligatoire pour `threshold.crossed`.
- `limits` : plafond de lancements par fenêtre glissante. Défaut 60 par 60 minutes ; plafond dur 1 000 par 1 440 minutes.

## 4. Identité de lancement et accès aux objets

- `run_as_user_group_id` est le **lanceur** explicite (compte de service ou propriétaire du workflow). L'instance démarre
  avec ses droits, jamais plus (`started_by`).
- À la conception : le lanceur doit être actif et posséder le menu Lancer (`PrincipalService.canLaunch`). Un
  non-administrateur ne peut désigner qu'un compte de SA propre personne ; seul un administrateur désigne un autre compte
  (pas d'élévation de privilèges par la conception d'un déclencheur).
- À l'exécution : le lanceur est revérifié à CHAQUE événement. Désactivé, supprimé ou sans menu : le déclencheur ne lance
  pas et journalise.
- L'objet lié n'est accepté que via un `SubjectAccessChecker` enregistré (`WorkflowSubjectAccessRegistrar`, au démarrage du
  module). Tout autre type d'objet (`dossier`, `other`…) reste refusé.
  - **Courrier** (`MailSubjectAccessChecker`) : l'acteur et son rôle sont relus en base. Accès si le courrier existe, n'est
    pas supprimé, est visible (règle de `MailsService.visibility()`), et si l'acteur est administrateur, a le périmètre de
    suivi `all` (`mailScope`), est destinataire (nommé, ou rôle ACTIF), a une imputation sur le courrier, ou l'a créé.
  - **Document** (`DocumentSubjectAccessChecker`) : délègue à `DocumentsService.canAccess` avec l'`AuthUser` reconstruit en
    base (confidentialité, droits explicites, créateur).
  - Toute exception interne = refus.
- `resolveSubjectOwner` (assignation `subject_owner`) : courrier = destinataire nominatif, à défaut créateur ; document =
  créateur ; toujours un compte actif, sinon `null` (le moteur retombe alors sur le lanceur, journalisé). Branché via
  `SubjectAccessChecker.resolveOwner` et `PrincipalService.resolveSubjectOwner`.

## 5. Idempotence et anti-tempête

Le répartiteur évalue chaque déclencheur actif du type de l'événement, dans cet ordre :

| # | Contrôle | Résultat | Compté comme échec |
| --- | --- | --- | --- |
| 1 | Conditions du déclencheur valides | `invalid_config` | oui |
| 2 | `match` satisfait | `no_match` (silence) | non |
| 3 | Arrêt d'urgence (`wf_budget`) | `stopped` ; barrière en panne = refus (fail-closed) | non |
| 4 | Clé déjà utilisée | `duplicate` | non |
| 5 | Les 5 dernières instances du déclencheur ont toutes échoué | `auto_disabled` | (désactive) |
| 6 | Plafond de lancements sur la fenêtre | `cap_reached` | non |
| 7 | Lanceur actif avec menu Lancer | `launcher_inactive` | oui |
| 8 | Accès du lanceur à l'objet | `subject_denied` | non |
| 9 | Démarrage par `WF_TRIGGER_STARTER` | `started`, `duplicate`, `definition_unavailable` (définition non publiée) | oui pour `definition_unavailable` et les erreurs du démarreur |

- **Clé d'idempotence** : `trg:{triggerId}:{événement}:{objet}:{id}[:{occurrence}]`, par exemple
  `trg:7:deadline.reached:mail:42:2026-11-21`. Un rejeu ne crée pas de doublon (unicité `(definition_id, idempotency_key)`
  du moteur, plus un contrôle préalable). Le worker recalcule la même clé (`workflow-deadlines.keys.ts`) : toute
  modification du format doit être reportée des deux côtés (tests aux mêmes valeurs d'or).
- **Préfixe réservé** : la route publique `POST /workflows/instances` refuse une `idempotencyKey` qui commence par `trg:`
  (insensible à la casse), pour qu'un lanceur ne puisse pas occuper à l'avance la clé d'un événement futur
  (`workflows/extension/trigger-idempotency.ts`, `workflows.dto.ts`).
- **Plafond** : nombre d'instances du déclencheur dans la fenêtre glissante, quel que soit leur statut. Le plafond refuse et
  journalise (une entrée par 5 minutes) mais ne désactive pas le déclencheur.
- **Désactivation automatique** : 5 échecs consécutifs (colonne « compté » ci-dessus) ou 5 instances échouées d'affilée
  désactivent le déclencheur (`is_active = false`) avec une entrée d'audit non limitée. Seules les instances démarrées APRÈS
  `updated_at` comptent pour la boucle d'instances : une réactivation humaine repart d'un état propre. Le compteur est en mémoire du
  processus api, il repart de zéro si un humain modifie ou réactive le déclencheur (`updated_at`) ou au redémarrage. Une
  panne de base inattendue n'est PAS comptée (elle ne désactive pas tous les déclencheurs).
- **Arrêt d'urgence** : une ligne `wf_budget` avec `emergency_stop = true`, globale (`definition_id` nul) ou propre à la
  définition du déclencheur, bloque tout lancement. Implémentation par défaut : `WfBudgetEmergencyStopGate`. W2 peut
  fournir une autre implémentation sous le jeton `WF_EMERGENCY_STOP_GATE`.
- **Journal** : les refus sont écrits dans `data_change_audit` (`object_ref = wf_trigger:{id}`, acteur « Déclencheur
  workflow ») et dans le journal applicatif. Le journal `wf_event_log` exige une instance : il ne convient pas aux refus.
  Les messages ne contiennent que des identifiants et des codes.
- **Sérialisation** : le bus traite un événement à la fois par processus, ce qui rend le comptage du plafond exact dans un
  processus. Avec plusieurs processus api, le dépassement est borné par la concurrence (une instance par processus).

## 6. Émission non bloquante

- `WorkflowEventBus.emit(event)` valide l'événement, le met en file et rend la main immédiatement. Il ne lève jamais : un
  événement invalide, une file pleine ou un écouteur en échec sont journalisés et abandonnés.
- Dans le module courriers, l'émission est UNE ligne après la transaction de `createArrivee` ; le bus est injecté en
  `@Optional()`. Dans le worker, `emitWorkflowEvent` est un no-op tant que l'émetteur n'est pas initialisé et n'attend
  jamais la file.
- **Rien n'est durable côté émission** : l'arrêt du processus perd les événements en file mémoire ou non encore écrits dans
  Redis. Les balayages d'échéance et de seuil rattrapent leurs propres événements (la clé d'idempotence évite les
  doublons). Un courrier ou un document dont l'événement est perdu n'est pas relancé.

## 7. API de conception

Préfixe `/workflows/triggers`, TOUTES les routes exigent le menu `/workflows/conception` (garde `MenuPermissionGuard`).

| Méthode | Chemin | Effet |
| --- | --- | --- |
| GET | `/catalog` | Types d'événement, champs, opérateurs, plafonds. |
| GET | `/` | Liste (filtres `definitionId`, `eventType`, `isActive`, `limit`, `offset`). |
| GET | `/:id` | Détail. |
| POST | `/` | Création : `name`, `eventType`, `definitionId`, `conditions`, `runAsUserGroupId`, `isActive`. 422 si conditions, définition (archivée) ou lanceur invalides ; 403 si un non-administrateur désigne un autre compte. |
| PUT | `/:id` | Modification de `name`, `conditions`, `runAsUserGroupId`, `isActive`. Le type d'événement et la définition ne changent pas. Réactiver revalide conditions, lanceur et définition. |
| DELETE | `/:id` | Suppression ; `wf_instance.trigger_id` passe à NULL. |

Chaque création, modification et suppression est journalisée dans `data_change_audit`.

## 8. Tests

| Fichier | Couvre |
| --- | --- |
| `workflow-triggers/domain/*.spec.ts` | Conditions, catalogue, événements, clé d'idempotence, aucun texte libre. |
| `workflow-triggers/bus/workflow-event-bus.spec.ts` | Non-blocage, file bornée, écouteur en échec. |
| `workflow-triggers/dispatch/*.spec.ts` | Répartiteur (émission, conditions, idempotence, plafond, lanceur désactivé, accès refusé, arrêt d'urgence, désactivation automatique), consommateur, suivi des échecs. |
| `workflow-triggers/access/*.spec.ts`, `workflows/extension/subject-owner.spec.ts`, `workflows/principal.owner.spec.ts` | Contrôleurs d'accès (refus par défaut), propriétaire. |
| `workflows/workflows.dto.idempotency.spec.ts` | Préfixe `trg:` refusé sur la route publique. |
| `workflow-triggers/triggers.*.spec.ts`, `workflow-triggers.module.spec.ts` | CRUD, routes, câblage du module. |
| `courriers/mails.workflow-events.spec.ts` | Émission après commit, structurée, absence de bus tolérée. |
| `apps/worker/src/processors/workflow-deadlines.*.spec.ts` | Balayages, émetteur non bloquant, clés d'or. |

Intégration PostgreSQL (ignorées sans `WF_TEST_DATABASE_URL`, base JETABLE, refus si l'URL est celle de `DATABASE_URL`) :

```
WF_TEST_DATABASE_URL=postgresql://... pnpm --filter @archivage/api test -- triggers.integration
WF_TEST_DATABASE_URL=postgresql://... pnpm --filter @archivage/worker test -- workflow-deadlines.integration
```

La migration GED exige pgvector : sur une base jetable sans cette extension, la marquer appliquée avec
`prisma migrate resolve --applied 20261120120000_add_ged_ia_foundations` avant de déployer la migration workflow.

## 9. Limites connues

- Événements `mail.arrived` et `document.deposited` en mémoire : perdus à l'arrêt du processus (section 6).
- `mail.arrived` n'est émis que pour un courrier ARRIVÉE (`createArrivee`), pas pour un départ. `document.deposited` couvre
  l'ingestion du worker, la création depuis l'éditeur collaboratif et la promotion d'un scan ; un scan promu puis rattaché à
  un courrier produit donc aussi `mail.arrived`.
- Le consommateur de `wf-events` n'admet que les types émis par le worker (`document.deposited`, `deadline.reached`,
  `threshold.crossed`) ; `mail.arrived` ne passe que par le bus interne. Bus plein : le job échoue et BullMQ rejoue.
- Compteur d'échecs consécutifs en mémoire du processus (section 5).
- Plusieurs processus api : plafond et idempotence rapide peuvent être dépassés d'un lancement par processus en course ; le
  démarreur reste protégé par l'unicité en base (pas de doublon d'instance).
- Un courrier destiné à un rôle n'a pas de propriétaire nominatif : `subject_owner` retombe sur le créateur.
- `document.deposited` de source `editeur` ou `scan` ne porte que `createdBy` : `documentTypeId`, `planId`, `locationId`,
  `dossierId`, `confidentialiteId`, `batchId` et `pageCount` sont `null`, donc une condition `eq` sur l'un de ces champs ne
  correspond jamais pour ces documents (un `neq` ou un `exists` se comporte comme pour toute valeur nulle).
- Un seuil ne relance pas (une seule fois par déclencheur et document).
- Conception : un non-administrateur ne peut ni modifier, ni réactiver, ni supprimer un déclencheur dont le lanceur est le
  compte d'une autre personne (403).
- La confidentialité propre aux courriers (`mail_confidentialite`) n'est pas évaluée par le contrôleur d'accès : le
  service courriers ne l'applique pas non plus à la lecture d'un courrier.
