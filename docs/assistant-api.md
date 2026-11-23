# Assistant « qui agit » — contrat HTTP

Guide pour le lot Interface (frontend). Il décrit les huit routes `/assistant/**`, les réponses, les erreurs et la
carte de confirmation. Sources de vérité :

- `packages/types/src/asst-dto.ts` : `ASST_ROUTES`, schémas de requête (zod stricts), types de réponse, schémas d'action ;
- `packages/types/src/asst-enums.ts` : statuts, transitions, codes d'erreur et statuts HTTP, TTL, conservation ;
- `apps/api/src/modules/assistant/assistant.contracts.ts` : règles d'or, ports, erreur typée.

Modèle de données : `docs/assistant-donnees.md`. Catalogue des applicateurs (effets réels) : `docs/workflow-agents-catalogue.md`.
En cas d'écart, le code fait foi.

## 1. Vue d'ensemble

### 1.1 Principe

1. L'utilisateur écrit une phrase dans un échange (conversation).
2. L'assistant répond et, si la demande l'exige, **propose** une ou plusieurs actions (une « proposition », au plus 5 actions).
3. L'interface affiche une **carte de confirmation** : résumé, actions, échéance.
4. L'utilisateur **confirme** (ou refuse). Rien n'est exécuté sans ce clic explicite.
5. L'application exécute l'action **avec les droits de l'utilisateur**, jamais plus.

### 1.2 Garde de menu, identité et visibilité

- **Garde** : toutes les routes sont protégées par `@RequireMenu('/assistant')` (menu « Assistant », section Docu-Flow).
  L'accès est refusé par défaut. Un utilisateur sans ce menu reçoit une réponse du guard (401 sans session, 403 sans menu),
  avec le corps standard NestJS, **sans `errorCode`** (voir section 4.3).
- **Identité** : l'utilisateur est celui de la session, relu en base (compte actif, groupe utilisateur). Le corps d'une requête
  ne porte jamais d'identifiant d'utilisateur. Une identité machine (agent de scan) est refusée (`identity_refused`).
- **Visibilité** : un échange et ses propositions ne sont visibles que de leur auteur. Un objet appartenant à un autre
  utilisateur, ou inexistant, répond **404 `not_found`**, jamais 403 : l'interface ne doit pas pouvoir distinguer les deux cas.
- **Identifiants** : tous les identifiants (`conversationId`, `messageId`, `proposalId`) sont des **chaînes** de 1 à 18 chiffres.
  Ne jamais les convertir en nombre : au-delà de 2^53, la précision est perdue. Les `mailId` et identifiants de destinataires
  à l'intérieur des actions sont, eux, des entiers JSON.

### 1.3 Actions de la v1

| Outil (`tool`) | Libellé | Effet | Annulation prévue au catalogue |
| --- | --- | --- | --- |
| `proposer_imputation_courrier` | Imputation de courrier | Crée une imputation par destinataire, avec délai | Aucune |
| `proposer_relance` | Relance | Notification interne à l'imputé en retard (jamais d'e-mail) | Aucune |
| `preparer_brouillon_reponse` | Brouillon de réponse | Crée un document brouillon, au nom du valideur | Suppression du document et de ses fichiers |

Exclus en v1 : envoi d'e-mail, délégation (`proposer_delegation`), tout autre outil. Le schéma refuse toute autre valeur de `tool`.
Ces effets sont **écrits dans l'application** : ils ne sont pas tous annulables (voir tableau), ce qui impose une confirmation
soigneuse dans la carte.

### 1.4 Durées et limites

| Règle | Valeur | Source |
| --- | --- | --- |
| Validité d'une proposition | 15 minutes, à partir de `createdAt` (`expiresAt` = `createdAt` + 15 min). À `now >= expiresAt`, elle est expirée. | `ASST_PROPOSAL_TTL_MINUTES` |
| Conservation d'un échange | 90 jours (`purgeAt` = création + 90 jours) | `ASST_RETENTION_DAYS` |
| Suppression par l'utilisateur | Masquage immédiat (`DELETE`) ; la purge physique est faite plus tard par un job, et, si l'échange porte une trace d'exécution, seulement à l'échéance d'origine (voir `DELETE` ci-dessous) | `docs/assistant-donnees.md`, §5 |
| Actions par proposition | 1 à 5 | `ASST_PROPOSAL_ACTIONS_MAX` |
| Message utilisateur (`content`) | 1 à 4 000 caractères après trim ; NUL et caractères de contrôle refusés (voir ci-dessous) | `ASST_MESSAGE_MAX_CHARS` |
| Message de l'assistant | au plus 8 000 caractères | `ASST_ASSISTANT_MESSAGE_MAX_CHARS` |
| Titre d'échange | 1 à 200 caractères après trim ; aucun caractère de contrôle ni retour à la ligne | `ASST_TITLE_MAX_CHARS` |
| Résumé d'une proposition | au plus 2 000 caractères (constante côté planificateur) | `ASST_SUMMARY_MAX_CHARS` |

**Caractères de contrôle.** Le NUL (`U+0000`), les contrôles C0 (`U+0001` à `U+0008`, `U+000B`, `U+000C`, `U+000E` à `U+001F`), `DEL` (`U+007F`) et les contrôles C1 (`U+0080` à `U+009F`) sont refusés dans `content` et dans `title` : `422 invalid_input` (message « Le texte contient des caractères de contrôle interdits. » ou, pour le titre, « Le titre ne doit contenir ni retour à la ligne ni caractère de contrôle. »), AVANT toute planification. Le retour à la ligne (`
`, `
`) et la tabulation restent autorisés dans `content` ; ils sont refusés dans `title`. Accents et emoji sont acceptés.

## 2. Routes

Chemins relatifs au préfixe de l'API, comme dans `ASST_ROUTES`. Les corps sont en JSON. Tous les schémas sont **stricts** :
une clé inconnue, dans le corps ou dans la query, donne 422 `invalid_input`. Les chaînes sont « trimées » avant contrôle
de longueur ; une chaîne vide après trim est donc refusée.

Les erreurs listées par route sont celles de `ASST_ROUTES`. Les refus de menu (401/403 du guard) peuvent survenir sur chacune
des routes et ne sont pas répétés.

Format commun de l'objet `pageContext` (`asstPageContextSchema`, strict) :

| Champ | Type | Contrainte |
| --- | --- | --- |
| `route` | chaîne | Obligatoire ; 1 à 200 caractères après trim ; commence par `/` |
| `subjectType` | chaîne | Optionnel ; au plus 50 caractères ; minuscules, chiffres, `_` et `.` uniquement |
| `subjectId` | chaîne | Optionnel ; 1 à 18 chiffres |

`pageContext` est une **donnée** décrivant la page ouverte. Le serveur ne lui accorde aucune autorité : il revérifie les droits
sur le sujet désigné.

### `POST /assistant/conversations`

**Rôle** : crée un échange vide, rattaché à l'utilisateur connecté.
**Succès** : `201`, corps `AsstConversationDto`.

Corps (`createConversationBody`, strict) :

| Champ | Type | Contrainte |
| --- | --- | --- |
| `title` | chaîne | Optionnel ; 1 à 200 caractères après trim |
| `pageContext` | objet | Optionnel ; voir le format ci-dessus |

Requête :

```json
{
  "title": "Imputation du courrier 4321",
  "pageContext": { "route": "/courriers/controle", "subjectType": "mail", "subjectId": "4321" }
}
```

Réponse `201` :

```json
{
  "conversationId": "1203",
  "title": "Imputation du courrier 4321",
  "pageContext": { "route": "/courriers/controle", "subjectType": "mail", "subjectId": "4321" },
  "createdAt": "2026-11-22T09:12:40.000Z",
  "updatedAt": "2026-11-22T09:12:40.000Z",
  "lastMessageAt": "2026-11-22T09:12:40.000Z",
  "purgeAt": "2027-02-20T09:12:40.000Z",
  "messageCount": 0
}
```

**Erreurs** : `invalid_input` (422), `identity_refused` (403), `assistant_unavailable` (503, IA désactivée ou arrêt d'urgence).

### `GET /assistant/conversations`

**Rôle** : liste paginée des échanges visibles de l'utilisateur (hors échanges masqués).
**Succès** : `200`, corps `{ items: AsstConversationDto[], total: number }`.

Query (`listConversationsQuery`, strict) :

| Paramètre | Type | Contrainte | Défaut |
| --- | --- | --- | --- |
| `limit` | entier (coercé depuis la chaîne) | 1 à 50 | 20 |
| `offset` | entier (coercé depuis la chaîne) | 0 à 1 000 000 | 0 |

Requête : `GET /assistant/conversations?limit=20&offset=0`

Réponse `200` :

```json
{
  "items": [
    {
      "conversationId": "1203",
      "title": "Imputation du courrier 4321",
      "pageContext": null,
      "createdAt": "2026-11-22T09:12:40.000Z",
      "updatedAt": "2026-11-22T09:14:02.000Z",
      "lastMessageAt": "2026-11-22T09:14:02.000Z",
      "purgeAt": "2027-02-20T09:12:40.000Z",
      "messageCount": 2
    }
  ],
  "total": 1
}
```

**Erreurs** : `invalid_input` (422), `identity_refused` (403).

### `GET /assistant/conversations/:id`

**Rôle** : lit un échange avec ses messages (et leurs propositions).
**Succès** : `200`, corps `{ conversation: AsstConversationDto, messages: AsstMessageDto[] }`. Les messages sont dans l'ordre de `position`.

Paramètre de chemin `:id` : identifiant de conversation, 1 à 18 chiffres.

Réponse `200` : `{ conversation, messages }`. Pour la conversation de l'exemple ci-dessous, `messages` contient le message
utilisateur (position 1) et le message assistant (position 2) avec sa proposition `5001` au statut 0, tels que renvoyés par
`POST /assistant/conversations/:id/messages` (section suivante).

**Erreurs** : `invalid_input` (422, identifiant mal formé), `not_found` (404, inexistant, masqué ou à un autre utilisateur),
`identity_refused` (403).

### `POST /assistant/conversations/:id/messages`

**Rôle** : envoie un message de l'utilisateur. L'assistant répond et peut proposer des actions. Ces actions ne sont **jamais**
exécutées ici : elles sont seulement proposées (`status` 0).
**Succès** : `201`, corps `{ conversation, userMessage, assistantMessage }`. Les propositions éventuelles sont dans
`assistantMessage.proposals` (tableau, vide si l'assistant ne propose rien).

Paramètre de chemin `:id` : identifiant de conversation, 1 à 18 chiffres.

Corps (`postMessageBody`, strict) :

| Champ | Type | Contrainte |
| --- | --- | --- |
| `content` | chaîne | Obligatoire ; 1 à 4 000 caractères après trim ; sans NUL ni caractère de contrôle (retour à la ligne et tabulation autorisés), sinon 422 `invalid_input` |
| `pageContext` | objet | Optionnel ; voir le format ci-dessus |

**Exemple : « impute ce courrier à la DAF sous 3 jours »**

Requête :

```json
{
  "content": "Impute ce courrier à la DAF sous 3 jours",
  "pageContext": { "route": "/courriers/controle", "subjectType": "mail", "subjectId": "4321" }
}
```

Réponse `201` (les identifiants de groupe et de type sont des valeurs d'exemple ; `argsHash` est le SHA-256 réel du JSON
canonique des actions, voir section 3.1) :

```json
{
  "conversation": {
    "conversationId": "1203",
    "title": "Imputation du courrier 4321",
    "pageContext": null,
    "createdAt": "2026-11-22T09:12:40.000Z",
    "updatedAt": "2026-11-22T09:14:02.000Z",
    "lastMessageAt": "2026-11-22T09:14:02.000Z",
    "purgeAt": "2027-02-20T09:12:40.000Z",
    "messageCount": 2
  },
  "userMessage": {
    "messageId": "8842",
    "conversationId": "1203",
    "role": 0,
    "content": "Impute ce courrier à la DAF sous 3 jours",
    "position": 1,
    "createdAt": "2026-11-22T09:13:58.000Z",
    "proposals": []
  },
  "assistantMessage": {
    "messageId": "8843",
    "conversationId": "1203",
    "role": 1,
    "content": "Je propose d'imputer le courrier 4321 à la DAF, avec un délai de 3 jours. Confirmez pour appliquer.",
    "position": 2,
    "createdAt": "2026-11-22T09:14:02.000Z",
    "proposals": [
      {
        "proposalId": "5001",
        "conversationId": "1203",
        "messageId": "8843",
        "status": 0,
        "actions": [
          {
            "tool": "proposer_imputation_courrier",
            "args": {
              "mailId": 4321,
              "recipients": [
                { "userGroupId": 17, "mailInputationTypeId": 2, "delayDays": 3 }
              ],
              "rationale": "Délai de 3 jours demandé par l'utilisateur pour ce courrier."
            }
          }
        ],
        "summary": "Imputer le courrier 4321 à la DAF (groupe 17), type 2, délai de 3 jours.",
        "argsHash": "a7a3406bbdf98eb104148fab4dfdfa1afde2f41860f6c31f1affbd0eec845a5f",
        "expiresAt": "2026-11-22T09:29:02.000Z",
        "createdAt": "2026-11-22T09:14:02.000Z",
        "confirmedAt": null,
        "finishedAt": null,
        "result": null,
        "errorCode": null,
        "errorMessage": null,
        "rowVersion": 0
      }
    ]
  }
}
```

**Question de précision (`clarification`)** : quand la demande est ambiguë (plusieurs destinataires possibles, courrier non
identifié, délai non chiffré en jours, type d'imputation incertain), l'assistant ne devine pas : il pose une question.
`assistantMessage.proposals` est alors vide et `assistantMessage.clarification` (champ **optionnel**, absent sinon) porte
`{ question?: string, choices: string[] }` : 2 à 6 choix distincts de 80 caractères au plus, texte brut. Chaque choix peut être
renvoyé tel quel comme `content` d'un nouveau message utilisateur. `assistantMessage.content` contient toujours la question et
la liste numérotée des choix (affichage de repli). Schéma : `asstClarificationSchema` (`packages/types/src/asst-dto.ts`).
Au rechargement d'un échange (`GET /assistant/conversations/:id`), `clarification` n'est restituée que sur le DERNIER message
de l'échange, s'il est de l'assistant et sans proposition (aucune table ne la stocke : elle est relue depuis `content`, et seul
un texte portant le marqueur de question de précision donne des choix : une liste numérotée libre n'en donne aucun).

**Erreurs** : `invalid_input` (422), `not_found` (404), `identity_refused` (403), `budget_exceeded` (429, plafond de coût
de l'utilisateur ou global atteint, ou limite de débit des messages : voir ci-dessous), `assistant_unavailable` (503, IA désactivée ou arrêt d'urgence), `not_implemented`
(501, voir section 6).

**Limite de débit** : un 429 `budget_exceeded` dû à la limite de messages par utilisateur porte `details.retryAfterSeconds` (entier >= 1) et l'en-tête HTTP `Retry-After: <secondes>` de même valeur ; le corps n'est pas modifié. Un 429 sans `retryAfterSeconds` valide (plafond de coût, limite de confirmations de la route `confirm`) n'a pas cet en-tête.

### `POST /assistant/proposals/:id/confirm`

**Rôle** : confirme une proposition **et l'exécute**, avec les droits de l'utilisateur. C'est la seule route qui applique un effet.
**Succès** : `200`, corps `AsstProposalDto` au statut `2` (Appliquée), avec `result.effects` et `confirmedAt` / `finishedAt`.

Paramètre de chemin `:id` : identifiant de proposition, 1 à 18 chiffres.

Corps (`confirmProposalBody`, strict) :

| Champ | Type | Contrainte |
| --- | --- | --- |
| `argsHash` | chaîne | Obligatoire ; exactement 64 caractères hexadécimaux **minuscules** (`^[0-9a-f]{64}$`) |

Le `argsHash` envoyé est **celui reçu dans la proposition**, sans recalcul ni modification. Il lie la confirmation au contenu
affiché : si le contenu a changé, le serveur répond 409 `conflict`.

**Erreurs ajoutées pour la route** : `budget_exceeded` (429) est renvoyé par le limiteur de confirmations : au plus 10 confirmations par utilisateur sur une fenêtre glissante de 60 s. Ce limiteur est tenu en mémoire, propre à chaque processus, et vérifié avant la lecture de la proposition (une confirmation sur une proposition inexistante est donc comptée). Une tentative refusée n'est pas enregistrée. Ce 429 n'est pas un plafond de coût : il réutilise le code `budget_exceeded`. Son corps est `{ statusCode, errorCode, message }` sans `details` : il n'y a donc **pas** de `Retry-After` pour cette route.

Requête :

```json
{ "argsHash": "a7a3406bbdf98eb104148fab4dfdfa1afde2f41860f6c31f1affbd0eec845a5f" }
```

Réponse `200` (valeurs indicatives pour `rowVersion` et la forme de `result.effects[].summary`, qui dépend de l'applicateur) :

```json
{
  "proposalId": "5001",
  "conversationId": "1203",
  "messageId": "8843",
  "status": 2,
  "actions": [
    {
      "tool": "proposer_imputation_courrier",
      "args": {
        "mailId": 4321,
        "recipients": [{ "userGroupId": 17, "mailInputationTypeId": 2, "delayDays": 3 }],
        "rationale": "Délai de 3 jours demandé par l'utilisateur pour ce courrier."
      }
    }
  ],
  "summary": "Imputer le courrier 4321 à la DAF (groupe 17), type 2, délai de 3 jours.",
  "argsHash": "a7a3406bbdf98eb104148fab4dfdfa1afde2f41860f6c31f1affbd0eec845a5f",
  "expiresAt": "2026-11-22T09:29:02.000Z",
  "createdAt": "2026-11-22T09:14:02.000Z",
  "confirmedAt": "2026-11-22T09:20:11.000Z",
  "finishedAt": "2026-11-22T09:20:11.000Z",
  "result": {
    "effects": [
      { "tool": "proposer_imputation_courrier", "summary": { "mailId": 4321, "inputationsCreees": 1 } }
    ]
  },
  "errorCode": null,
  "errorMessage": null,
  "rowVersion": 2
}
```

**Erreurs** : `invalid_input` (422, `argsHash` mal formé), `not_found` (404), `identity_refused` (403), `proposal_expired`
(409), `proposal_not_pending` (409), `conflict` (409), `effect_forbidden` (403), `effect_failed` (422), `not_implemented` (501).
Le détail de ces réponses est dans la section 3.3.

### `POST /assistant/proposals/:id/refuse`

**Rôle** : refuse une proposition. Aucun effet n'est appliqué.
**Succès** : `200`, corps `AsstProposalDto` au statut `3` (Refusée), avec `finishedAt` renseigné.

Paramètre de chemin `:id` : identifiant de proposition, 1 à 18 chiffres.

Corps (`refuseProposalBody`, strict) :

| Champ | Type | Contrainte |
| --- | --- | --- |
| `reason` | chaîne | Optionnel ; 1 à 500 caractères après trim. Si la saisie est vide, **omettre la clé**. |

Requête :

```json
{ "reason": "Déjà traité par la DAF hors application." }
```

Réponse `200` (valeurs indicatives) :

```json
{
  "proposalId": "5001",
  "conversationId": "1203",
  "messageId": "8843",
  "status": 3,
  "actions": [
    {
      "tool": "proposer_imputation_courrier",
      "args": {
        "mailId": 4321,
        "recipients": [{ "userGroupId": 17, "mailInputationTypeId": 2, "delayDays": 3 }],
        "rationale": "Délai de 3 jours demandé par l'utilisateur pour ce courrier."
      }
    }
  ],
  "summary": "Imputer le courrier 4321 à la DAF (groupe 17), type 2, délai de 3 jours.",
  "argsHash": "a7a3406bbdf98eb104148fab4dfdfa1afde2f41860f6c31f1affbd0eec845a5f",
  "expiresAt": "2026-11-22T09:29:02.000Z",
  "createdAt": "2026-11-22T09:14:02.000Z",
  "confirmedAt": null,
  "finishedAt": "2026-11-22T09:16:45.000Z",
  "result": null,
  "errorCode": null,
  "errorMessage": null,
  "rowVersion": 1
}
```

**Erreurs** : `invalid_input` (422), `not_found` (404), `identity_refused` (403), `proposal_expired` (409),
`proposal_not_pending` (409), `conflict` (409).

### `GET /assistant/proposals/:id`

**Rôle** : relit une proposition (utile après une erreur, ou pour reprendre une carte à l'écran).
**Succès** : `200`, corps `AsstProposalDto`.

Paramètre de chemin `:id` : identifiant de proposition, 1 à 18 chiffres.

Une proposition au statut `0` dont `expiresAt` est dépassé est **présentée comme `4` (Expirée)** et clôturée à la lecture.

Réponse `200` : même forme que les réponses ci-dessus (exemple : la proposition `5001` au statut 0, comme dans le message).

**Erreurs** : `invalid_input` (422), `not_found` (404), `identity_refused` (403).

### `DELETE /assistant/conversations/:id`

**Rôle** : masque un échange. Le masquage est immédiat : l'échange disparaît des listes. La purge physique (messages et
propositions compris) est faite plus tard, à l'échéance de conservation.
Si l'échange porte une **trace d'exécution** (proposition appliquée, en échec, ou confirmée en cours), il est seulement
masqué : son échéance `purgeAt` n'est pas avancée, et la trace reste en base jusqu'à la purge à l'échéance d'origine (90 jours
après la création). Sans trace, `purgeAt` passe à maintenant et la purge a lieu au passage suivant du job. Détail :
`docs/assistant-donnees.md`, §5.
**Succès** : `204`, **sans corps**.

Paramètre de chemin `:id` : identifiant de conversation, 1 à 18 chiffres.

Requête : `DELETE /assistant/conversations/1203` → `204 No Content`.

**Erreurs** : `invalid_input` (422), `not_found` (404), `identity_refused` (403).

## 3. Carte de confirmation

### 3.1 Champs à afficher

La carte est construite à partir d'un `AsstProposalDto` (un message assistant peut en contenir plusieurs, au plus une par
échange à la fois dans l'usage prévu).

| Champ | Usage |
| --- | --- |
| `summary` | Résumé lisible de ce que la confirmation déclenche. Texte brut. |
| `actions[]` | Une ligne par action : libellé de l'outil (`ASST_ACTION_TOOL_LABELS`) et détails tirés de `args` (destinataires, délai, message, brouillon). |
| `expiresAt` | Échéance affichée (« valable jusqu'à HH:mm »). Compte à rebours indicatif seulement. |
| `status` | Libellé d'état (tableau 3.2). Détermine les boutons. |
| `argsHash` | **À conserver** pour la confirmation. Non nécessaire à l'affichage. |
| `result.effects` | Affiché quand `status` = 2. |
| `errorCode`, `errorMessage` | Affichés quand `status` = 5. |

`argsHash` est le SHA-256 hexadécimal du **JSON canonique** des `actions` : clés triées récursivement, sans espaces, ordre du
tableau conservé. Ce n'est pas la forme affichée. L'interface n'a pas à le recalculer : elle le renvoie tel quel.

### 3.2 États

Libellés et transitions issus de `ASST_PROPOSAL_STATUS_LABELS` et `ASST_PROPOSAL_TRANSITIONS`.

| Valeur | Libellé | Terminal | Boutons proposés | Transitions légales |
| --- | --- | --- | --- | --- |
| 0 | Proposée | non | Confirmer, Refuser (seulement si `expiresAt` non atteint) | vers 1 (Confirmée), 3 (Refusée) ou 4 (Expirée) |
| 1 | Confirmée | non | aucun (exécution en cours, état transitoire) | vers 2 (Appliquée) ou 5 (Échec) |
| 2 | Appliquée | oui | aucun ; afficher `result.effects` | aucune |
| 3 | Refusée | oui | aucun | aucune |
| 4 | Expirée | oui | aucun | aucune |
| 5 | Échec | oui | aucun ; afficher `errorCode` et `errorMessage` | aucune |

Une transition absente de ce tableau n'existe pas : le serveur la refuse. Une proposition terminale (2, 3, 4, 5) ne change plus.

### 3.3 Bouton Confirmer

Envoie `POST /assistant/proposals/:id/confirm` avec `{ "argsHash": <valeur reçue> }`. Le bouton est désactivé pendant l'appel
(pas de double envoi). L'exécution est idempotente côté serveur (une proposition appliquée n'est jamais rejouée), mais le client
ne doit pas s'en servir comme mécanisme de reprise.

| Réponse | Affichage et conduite |
| --- | --- |
| `200` (statut 2) | Remplacer la carte par la proposition renvoyée. Afficher « Appliquée » et `result.effects`. |
| `409` `conflict` | Le contenu a changé (hash différent) ou un autre appel a modifié la proposition. Relire la proposition (`GET`), réafficher la carte **mise à jour** et exiger une nouvelle confirmation. Ne jamais renvoyer l'ancien `argsHash`. |
| `409` `proposal_expired` | L'échéance est passée ; le serveur a clos la proposition (statut 4). Masquer Confirmer, afficher « Expirée », proposer de reformuler la demande. |
| `409` `proposal_not_pending` | La proposition n'est plus « Proposée » (confirmée, refusée, appliquée…). Relire (`GET`) et afficher le statut courant. Ne pas réessayer. |
| `422` `effect_failed` | L'applicateur a refusé l'effet. Le corps porte `proposal` au statut 5 : afficher « Échec » avec `proposal.errorMessage`. Pas de réessai automatique ; une nouvelle demande est nécessaire. |
| `403` `effect_forbidden` | Droits insuffisants pour cet effet. Le corps peut porter `proposal` (statut 5, selon le port d'exécuteur) : si présent, l'afficher. Pas de réessai. |
| `403` `identity_refused` | Compte inactif ou identité refusée. Afficher le message ; la proposition n'est pas exécutée. |
| `429` `budget_exceeded` | Trop de confirmations (plus de 10 en 60 s pour cet utilisateur) ; la proposition n'est pas exécutée. Afficher « trop de confirmations, réessayez dans une minute ». Ne pas réessayer en boucle ni automatiquement. Lire `Retry-After` s'il est présent (il ne l'est pas pour cette route). |
| `404` `not_found` | Proposition introuvable ou à un autre utilisateur. Afficher « introuvable » et retirer la carte. |
| `422` `invalid_input` | `argsHash` mal formé (pas 64 hexadécimaux minuscules) : erreur du client, à corriger dans le code. |
| `501` `not_implemented` | Brique non branchée (A0, section 6). |

Le corps `proposal` des réponses `422 effect_failed` et `403 effect_forbidden` est un `AsstProposalDto` complet : le remplacer
dans l'état local de la carte.

### 3.4 Bouton Refuser

Envoie `POST /assistant/proposals/:id/refuse` avec `{ "reason": "..." }` (motif facultatif, 1 à 500 caractères après trim ;
omettre la clé si le champ est vide). Aucun `argsHash` n'est requis.

- `200` : statut 3 (Refusée). Afficher « Refusée ».
- `409` `proposal_expired`, `proposal_not_pending` ou `conflict` : relire (`GET`) et afficher l'état réel, comme pour Confirmer.
- `404`, `403 identity_refused`, `422 invalid_input` : voir section 4.

## 4. Erreurs

### 4.1 Schéma d'erreur unique

Toute erreur de `/assistant/**` (hors refus de menu, voir 4.3) a ce corps (`AsstErrorBodyDto`) :

```ts
type AsstErrorBodyDto = {
  statusCode: number;        // identique au statut HTTP
  errorCode: AsstErrorCode;  // un des 11 codes ci-dessous
  message: string;           // en français, sans contenu de courrier : affichable tel quel
  details?: unknown;         // optionnel ; forme non figée (voir section 7)
  proposal?: AsstProposalDto; // présent pour effect_failed (et effect_forbidden, selon l'exécuteur)
};
```

### 4.2 Codes d'erreur

Statuts issus de `ASST_ERROR_HTTP_STATUS`.

| `errorCode` | HTTP | Signification | Conduite côté interface |
| --- | --- | --- | --- |
| `not_implemented` | 501 | Brique (planificateur, store, exécuteur) pas encore branchée. | Afficher « Fonction indisponible pour l'instant ». Ne pas réessayer en boucle. |
| `not_found` | 404 | Objet inexistant, masqué, ou appartenant à un autre utilisateur. Jamais 403. | Afficher « introuvable ». Ne pas tenter de deviner l'existence de l'objet. Retirer l'élément de la vue. |
| `identity_refused` | 403 | Compte inactif, identité machine, acteur inconnu. | Afficher que l'accès est refusé. Pas de réessai ; proposer de se reconnecter. |
| `proposal_expired` | 409 | Proposition au-delà de 15 minutes. | Masquer Confirmer, afficher « Expirée ». Proposer de reformuler la demande. |
| `proposal_not_pending` | 409 | Transition illégale : la proposition n'est plus « Proposée ». | Relire la proposition (`GET`) et afficher son statut. Ne rien rejouer. |
| `conflict` | 409 | `argsHash` ne correspond plus au contenu, ou verrou concurrent (`rowVersion`). | Relire, réafficher la carte modifiée, exiger une nouvelle confirmation. |
| `effect_forbidden` | 403 | Droits insuffisants pour l'effet (menu, périmètre, imputabilité). | Afficher le message ; afficher `proposal` s'il est présent. Pas de réessai. |
| `effect_failed` | 422 | L'applicateur a refusé l'effet (refus métier). La proposition est au statut 5. | Afficher « Échec » et `proposal.errorMessage`. Pas de réessai ; nouvelle demande pour recommencer. |
| `budget_exceeded` | 429 | Plafond de coût atteint (utilisateur du jour ou global), ou limite de débit : messages (`details.retryAfterSeconds`) ou confirmations (10 par minute, route `confirm`, sans `details`). | Afficher « plafond atteint, réessayez plus tard » pour un plafond de coût, « trop de confirmations, réessayez dans une minute » pour la limite de confirmations. Si l'en-tête `Retry-After` est présent, attendre ce délai. Ne pas réessayer en boucle. |
| `assistant_unavailable` | 503 | IA désactivée ou arrêt d'urgence. | Afficher « assistant indisponible » ; désactiver la saisie. |
| `invalid_input` | 422 | Corps, paramètres ou query invalides (y compris clé inconnue). `message` vaut « Requête invalide. » et `details` est la liste `{ path, message }` des anomalies. | Erreur de saisie hors bornes ou erreur du client : afficher les anomalies ou un message générique, corriger le client. |

### 4.3 Refus de menu et validation

- **Refus du guard** (menu `/assistant` absent, non authentifié) : **corps standard NestJS, sans `errorCode`** (401 ou 403).
  Le front distingue donc les cas : si `errorCode` est absent, la réponse vient du guard ou de NestJS, et se traite par le statut
  HTTP (401 : session à renouveler ; 403 : fonction non accessible).
- **Validation** : tout corps, paramètre ou query invalide donne **422 `invalid_input`** avec le schéma d'erreur de 4.1.
  Ce n'est pas le 400 habituel de NestJS. `details` est alors la liste `{ "path": "content", "message": "..." }` (`path` vaut `(root)` si l'anomalie concerne le corps entier).
- **Erreur inattendue** (défaut serveur) : **500 sans `errorCode`**, corps `{ "statusCode": 500, "message": "Internal server error" }`. Le front la traite comme une erreur générique, sans réessai automatique.

## 5. Actions proposées et règles de sécurité

### 5.1 Schémas des trois outils

Une action est un objet strict `{ "tool": ..., "args": ... }`. Le schéma est une union discriminée sur `tool`. Les bornes
ci-dessous sont celles de `packages/types/src/asst-dto.ts`, identiques à celles du catalogue d'agents.

**`proposer_imputation_courrier`** (effet : imputation(s) interne(s))

| Champ de `args` | Type | Contrainte |
| --- | --- | --- |
| `mailId` | entier | 1 à 2 147 483 647 |
| `recipients` | tableau | 1 à 5 éléments (`ASST_IMPUTATION_RECIPIENTS_MAX`) |
| `recipients[].userGroupId` | entier | 1 à 2 147 483 647 |
| `recipients[].mailInputationTypeId` | entier | 1 à 2 147 483 647 |
| `recipients[].instructions` | chaîne | Optionnel ; 1 à 1 000 caractères après trim |
| `recipients[].delayDays` | entier | Optionnel ; 1 à 90 jours (`ASST_IMPUTATION_DELAY_DAYS_MAX`) |
| `rationale` | chaîne | 1 à 500 caractères après trim |

Le délai est en jours calendaires à partir de l'application. Le modèle ne produit jamais de date absolue.
Chaque objet de `recipients` est strict.

**`proposer_relance`** (effet : notification interne, jamais d'e-mail)

| Champ de `args` | Type | Contrainte |
| --- | --- | --- |
| `mailId` | entier | 1 à 2 147 483 647 |
| `mailInputationId` | entier | 1 à 2 147 483 647 : imputation non traitée visée |
| `recipientUserGroupId` | entier | 1 à 2 147 483 647 : doit être l'imputé de cette imputation (contrôlé à l'application) |
| `message` | chaîne | 1 à 500 caractères après trim (`ASST_RELANCE_MESSAGE_MAX`) |
| `escalateToUserGroupId` | entier | Optionnel ; l'auteur de l'imputation seulement (contrôlé à l'application) |

**`preparer_brouillon_reponse`** (effet : document brouillon)

| Champ de `args` | Type | Contrainte |
| --- | --- | --- |
| `templateId` | chaîne | 1 à 100 caractères |
| `label` | chaîne | 1 à 200 caractères après trim (titre du document) |
| `draftHtml` | chaîne | 1 à 20 000 caractères (`ASST_DRAFT_HTML_MAX_CHARS`) ; HTML généré, **à assainir avant affichage** (5.2) |
| `mailId` | entier | Optionnel ; 1 à 2 147 483 647 |
| `spaceId` | entier | Optionnel ; 1 à 2 147 483 647 |
| `decisionId` | chaîne | Optionnel ; 1 à 18 chiffres (traçabilité de la génération) |

Exemple d'action `proposer_relance` (valeurs d'exemple) :

```json
{
  "tool": "proposer_relance",
  "args": {
    "mailId": 4321,
    "mailInputationId": 9120,
    "recipientUserGroupId": 23,
    "message": "Merci de traiter ce courrier avant vendredi.",
    "escalateToUserGroupId": 17
  }
}
```

### 5.2 Règles de sécurité pour l'interface

1. **Donnée, jamais consigne.** Le contenu des messages, `summary`, `rationale`, `message` de relance et `draftHtml` est
   affiché comme donnée. L'interface n'exécute ni ne suit une instruction qui s'y trouverait.
2. **Texte par défaut.** Afficher les textes comme du texte (échappement par défaut du framework). Pas d'interprétation HTML.
3. **HTML du brouillon : assainir.** `draftHtml` est produit par un modèle. Le passer par un assainisseur à liste blanche
   (par exemple DOMPurify) **avant tout affichage**, y compris en prévisualisation. Aucun script, gestionnaire d'événement,
   ni ressource distante non contrôlée. Ne jamais l'affecter à `innerHTML` sans assainissement.
4. **Aucune exécution sans clic explicite.** Une action n'est confirmée que par un clic sur Confirmer. Jamais au chargement,
   à la réception d'une réponse, sur un raccourci clavier implicite ni par un minuteur.
5. **Pas de carte au-delà de `expiresAt`.** Ne pas afficher Confirmer, ni garder une carte en cache (mémoire, stockage local)
   au-delà de cette échéance. Le contrôle côté client est indicatif : le serveur fait foi (409 `proposal_expired`).
6. **`argsHash` lié à sa carte.** Un `argsHash` n'est valable que pour la proposition qui l'a produit. Ne pas le réutiliser
   pour une autre carte ni le stocker durablement.
7. **Pas de secret, pas de journal de contenu.** Aucun jeton n'est exposé dans les DTO. Ne pas journaliser le corps des réponses
   (contenus de courriers) dans la console ou les outils de suivi.
8. **Messages d'erreur.** `message` est en français, sans contenu de courrier : il peut être affiché tel quel.
9. **Identifiants en chaînes.** Voir 1.2 : ne jamais les convertir en nombre.

## 6. État d'implémentation (A0, historique)

Cette section décrit l'état à la livraison du lot A0. Depuis, A1 (planificateur, magasin, conversations, porte de coût) et A2 (exécuteur) sont branchés dans `assistant.module.ts` et les routes ne répondent plus 501. Les ports par défaut « non implémenté » (`not-implemented.ts`) ont été retirés en A4 ; le code d'erreur `not_implemented` (501) reste dans le contrat (`packages/types/src/asst-enums.ts`) et est géré par l'interface.

Présent dans la copie de travail :

- `packages/types` : schémas, énumérations, codes d'erreur et `ASST_ROUTES` (le contrat).
- `apps/api/src/modules/assistant/` : `AssistantModule` (importé dans `app.module.ts`), `AssistantController` (les huit routes
  sous le préfixe `assistant`), garde `MenuPermissionGuard` avec `@RequireMenu('/assistant')`, `AssistantErrorFilter`
  (corps d'erreur de la section 4), pipes zod (`dto/assistant.dto.ts`), résolution d'identité (`identity/asst-identity.service.ts`).
- Entrée de menu « Assistant » (section Docu-Flow, clé `/assistant`) dans `apps/api/src/modules/roles/menu-catalog.ts`.

Comportement en A0 :

- Les ports métier (conversations, exécuteur, planificateur, store, porte de coût) sont liés à des implémentations « pas encore
  branchées » qui échouent en `not_implemented`. Conséquence : **les huit routes répondent 501 `not_implemented`** dès que le
  menu est accordé, que la validation est passée et que l'identité est résolue. Un `identity_refused` (403) peut donc survenir
  avant le 501.
- La validation (422 `invalid_input`) et le contrôle de menu fonctionnent déjà. Les tests du contrôleur
  (`assistant.controller.spec.ts`) vérifient le 501 sur les huit routes.
- Brancher A1 (conversations, planificateur, store, plafond budgétaire) et A2 (exécuteur, applicateurs) remplace ces
  implémentations dans `assistant.module.ts`. Le contrat HTTP décrit ici ne change pas.

Pour le front : développer contre les types de `packages/types` et contre des réponses simulées conformes aux exemples,
sans attendre A1 et A2. Le 501 est attendu tant que ces lots ne sont pas livrés.

## 7. Points non figés par le contrat

- **Ordre de la liste des échanges** : non précisé.
- **Messages d'un échange** : pas de pagination ; ordre croissant de `position`.
- **Forme de `details`** : connue pour `invalid_input` (liste `{ path, message }`) ; non figée pour les autres codes.
- **Forme de `result.effects[].summary`** : dépend de chaque applicateur. Afficher de façon générique.
- **Corps `proposal` sur `403 effect_forbidden`** : prévu par le port d'exécuteur ; le contrat de route ne le détaille pas.
- **`501 not_implemented`** : le catalogue `ASST_ROUTES` ne le déclare que sur `POST /assistant/conversations/:id/messages` et
  `POST /assistant/proposals/:id/confirm`, alors que les huit routes le renvoient en A0 (section 6).
- **Accès au menu `/assistant`** : refusé par défaut. L'entrée existe dans le catalogue de menus, mais un rôle doit recevoir la
  clé explicitement. Sans cette attribution, l'utilisateur reçoit le refus du guard (section 4.3).
