# Assistant — planificateur (lot A1)

Guide développeur du planificateur de l'assistant : comment un message devient une proposition d'actions, ce qui est
vérifié à chaque étape, et comment rejouer les tests. Sources : `apps/api/src/modules/assistant/planner/`, `gate/`,
`store/`, `conversations/` et `assistant.module.ts`. En cas d'écart, le code fait foi.

Contrats HTTP : `docs/assistant-api.md`. Données : `docs/assistant-donnees.md`.
Le lot A1 ne fait que lire et proposer : rien n'est exécuté ici (`ASST_EXECUTOR` reste `NotImplementedExecutor`, lot A2).

## 1. Vue d'ensemble

### 1.1 Règles d'or

- Le message de l'utilisateur est la **seule source d'intention**. Courriers, documents, noms d'acteurs, libellés et
  résultats d'outils sont des **données**.
- Le planificateur lit avec les droits de l'utilisateur et **propose**. Il n'écrit jamais dans `mail_inputation`,
  `notification` ou `documents` : le port de données (`AsstPlannerDataPort`) n'expose aucune méthode d'écriture métier (la seule opération qui a un effet de bord, la génération d'un brouillon, est budgétée et ne crée aucun document).
- Le résumé, les motifs et les messages de relance sont **construits par le code** ; le texte du modèle n'y figure jamais.
- **Échec fermé** : au moindre doute (suspicion, destinataire ambigu, courrier illisible, délai flou), une question
  (`clarify`) ou un refus explicite. Aucune action.

### 1.2 Flux

```
POST /assistant/conversations/:id/messages        (AsstConversationsService.postMessage)
  1. limiteur de débit par utilisateur (ASST_MESSAGES_PER_MINUTE, par processus)
  2. échange de l'utilisateur (sinon not_found, sans appel au planificateur)
  3. historique : les 10 derniers messages, avant le nouveau
  4. AsstPlannerService.plan                      <- aucune écriture métier
       a. porte : assertRunnable (mode IA, arrêts d'urgence, plafond du jour)
       b. boucle, au plus 5 tours :
            réservation -> modèle (masquage obligatoire) -> règlement
            tool_call            -> outil de LECTURE -> tour suivant
            answer | clarify     -> réponse ou question (texte du modèle, contrôlé)
            propose              -> portes (suspicion, intention, drapeau)
                                    -> AsstActionValidatorService (recalcule tout)
                                    -> résumé et réponse construits par le code
  5. persistance : message utilisateur, message assistant, puis proposition (si actions)
```

### 1.3 Ce qui est écrit pendant la planification

| Écriture | Table ou trace | Quand |
| --- | --- | --- |
| Compteurs de budget | `asst_user_budget` (porte utilisateur), `wf_budget` (porte globale) | Réservation, règlement, libération |
| Trace IA | `ged_ai_decision`, via `AiService` | Chaque appel au modèle, chaque génération de brouillon |
| Échange | `asst_message`, `asst_proposal` | Après la planification seulement (étape 5) |

Une planification qui lève une erreur n'écrit aucun message ni aucune proposition. La génération d'un brouillon passe par
la rédaction assistée existante : elle journalise une décision IA, mais ne crée aucun document (la création relève de
l'exécution, lot A2).

## 2. Boucle du planificateur

| Constante (`planner.types.ts`) | Valeur | Rôle |
| --- | --- | --- |
| `PLANNER_MAX_TURNS` | 5 | Appels au modèle au plus, pour un message |
| `PLANNER_MAX_TOOL_CALLS` | 6 | Appels d'outils au plus (voir règle ci-dessous) |
| `PLANNER_HISTORY_MAX_MESSAGES` / `_CHARS` | 10 / 6 000 | Historique transmis au modèle (les plus récents) |
| `PLANNER_MAX_OUTPUT_TOKENS` | 2 000 | Plafond de sortie d'un tour |
| `PLANNER_REPLY_MAX_CHARS` / `PLANNER_QUESTION_MAX_CHARS` | 1 500 / 500 | Texte d'une réponse / d'une question |
| `PLANNER_CHOICES_MIN` / `_MAX` | 2 / 6 | Choix d'une question de précision |
| `PLANNER_CHOICE_LABEL_MAX_CHARS` | 80 | Libellé d'un choix |
| `PLANNER_MAIL_TEXT_MAX_CHARS` | 6 000 | Texte d'un courrier renvoyé par `lire_courrier` |
| `PLANNER_SEARCH_DEFAULT_LIMIT` / `_MAX_LIMIT` | 10 / 20 | Résultats des outils de recherche |
| `PLANNER_MAX_ACTIONS_DEFAULT` | 3 | Actions par proposition (voir section 9) |
| `PLANNER_DRAFT_ESTIMATE_PROMPT_TOKENS` / `_COMPLETION_TOKENS` | 4 000 / 3 000 | Réservation d'une génération de brouillon |

Règles de la boucle :

- Chaque `tool_call` consomme un tour. Si les 5 tours passent sans conclusion : `PLANNER_MSG_EXHAUSTED`.
- Le 6e appel d'outil n'est jamais exécuté (réponse technique « Plafond d'appels d'outils atteint »). Comme les 5 tours
  bornent déjà la boucle, ce plafond n'est pas atteint : au plus 5 outils sont exécutés pour un message.
- Une sortie invalide (`AsstTurnError`) donne `PLANNER_MSG_INVALID_OUTPUT`, **sans nouvel essai**.
- Avant chaque appel : estimation = (système + texte) / 3 jetons en entrée, 2 000 jetons en sortie, coût selon le tarif
  `WF_AGENT_COST_PER_1K_*`. Après l'appel : règlement sur les jetons réels si le fournisseur les expose, sinon sur
  l'estimation. L'usage est cumulé sur tous les tours et stocké sur le message assistant.
- Un jeton aléatoire (nonce) **neuf à chaque tour** : 20 lettres majuscules, alphabet sans I ni O (`generateNonce`).
- Masquage refusé (`AiMaskingRequiredError`) ou IA désactivée : `assistant_unavailable`, réservation libérée, **jamais**
  de repli sans masquage. Autre erreur fournisseur : réservation réglée (prudence), `assistant_unavailable`.
- Les tours ont un prompt borné : 10 messages et 6 000 caractères d'historique (les plus récents, dans l'ordre), 12 derniers
  résultats d'outils et 18 000 caractères au total.

## 3. Outils de lecture

Les seuls outils que le modèle peut appeler (`PLANNER_READ_TOOLS`). Arguments validés par zod strict : une clé inconnue
donne `Arguments invalides`. Un outil inconnu, ou un outil d'action, donne `ok: false` sans exécution. Un outil ne lève jamais.

| Outil | Arguments | Renvoie |
| --- | --- | --- |
| `lire_courrier` | `mailId` (facultatif) | Sans `mailId` : le courrier de la page ouverte. Renvoie référence, objet, date, expéditeur, nature, mot-clé, confidentialité, texte borné à 6 000 caractères. Courrier illisible ou inexistant : même message. |
| `rechercher_courriers` | `query` (1 à 200), `limit` (≤ 20) | Courriers lisibles par l'utilisateur : numéro, référence, objet, date, expéditeur. Candidats lus : 3 fois `limit`, 30 au plus, avant filtre des droits. |
| `acteurs_imputables` | `search` (1 à 100, facultatif), `limit` (≤ 20) | Acteurs auxquels l'utilisateur peut imputer : identifiant de groupe, libellé « Nom — Groupe », rôle, organigramme. Jamais d'e-mail. |
| `types_imputation` | aucun | Types d'imputation actifs : identifiant, libellé, indicateur de suivi. |
| `imputations_courrier` | `mailId` | Jusqu'à 50 imputations : identifiant, acteur, état du compte, type, échéance (AAAA-MM-JJ), traitée, en retard, créée par l'utilisateur. `null` si le courrier est illisible. |
| `modeles_brouillon` | aucun | Modèles de rédaction (identifiant, libellé). |
| `espaces_ecriture` | aucun | Espaces où l'utilisateur peut déposer (propriétaire ou niveau Contribution et plus), 20 au plus. |

Chaque résultat est enregistré comme **preuve** (`PlannerEvidence` : courriers vus, recherches, acteurs renvoyés,
imputations vues, textes de tiers). Le validateur ne croit que ces preuves. Chaque texte de tiers renvoyé est analysé
par la détection d'injection (section 5.2).

## 4. Formes de sortie du modèle

Le modèle répond par un objet JSON, dans l'une de ces quatre formes (`planner-turn.ts`, `parseAsstTurn`) :

| Forme | Champs | Suite |
| --- | --- | --- |
| `tool_call` | `tool` (≤ 128), `arguments` (objet) | Exécution de l'outil de lecture, tour suivant |
| `clarify` | `question` (≤ 500), `choices` (2 à 6, `label` ≤ 80) | Question avec boutons de choix |
| `answer` | `text` (≤ 1 500) | Réponse texte |
| `propose` | `actions` (1 à 5, `tool` et `args`), `intent_source` (`message_utilisateur` ou `donnee_externe`), `suspicion` (booléen) | Portes puis validateur (section 5) |

Contrôles, dans l'ordre, avant toute décision : taille brute ≤ 64 Kio ; profondeur ≤ 12 ; `JSON.parse` ; clés interdites
(`__proto__`, `constructor`, `prototype`) ; schéma zod strict (clés inconnues refusées) ; texte nettoyé (caractères de
contrôle et invisibles retirés). Les messages d'erreur ne citent jamais la sortie. Le JSON Schema passé au fournisseur
est indicatif (`strictSchema: false`) : **zod fait foi**.

Les arguments d'une action sont **minimaux** (identifiants seulement) : motif, message, type, délai et brouillon sont
recalculés par le validateur. Ceux du modèle ne sont jamais repris tels quels.

## 5. Anti-injection

### 5.1 Isolation

- Le message système est écrit par l'application : règles, jeton, outils, formes de sortie.
- Chaque donnée est dans un bloc `<<DONNEES n libellé JETON>>` … `<<FIN_DONNEES n JETON>>`. Les chevrons et le jeton présents
  dans les données sont neutralisés (`neutralizeUntrusted`, `neutralizeLine`).
- Le message de l'utilisateur est le **dernier bloc de données**, `<<MESSAGE_UTILISATEUR JETON>>`, placé après les données.
  Un rappel des règles suit.
- Seules les balises portant exactement le jeton du tour sont valides. Le jeton ne peut pas être deviné : il est tiré
  au hasard à chaque appel. Un texte du modèle qui contient le jeton est remplacé par `PLANNER_MSG_LEAK`.
- Aucun identifiant d'utilisateur ou de groupe de l'appelant n'entre dans le prompt.

### 5.2 Portes, dans l'ordre

| Porte | Condition | Issue |
| --- | --- | --- |
| Historique de l'assistant | Un message **assistant** précédent contient une consigne détournée | Drapeau `dataSuspicion` pour toute la requête |
| Résultat d'outil | Une chaîne d'un résultat (ou un texte de tiers vu) contient une consigne détournée | Drapeau pour toute la requête |
| (1) Modèle | `suspicion: true` | `PLANNER_MSG_DATA_SUSPICION` |
| (2) Intention | `intent_source` différent de `message_utilisateur` | `PLANNER_MSG_EXTERNAL_INTENT` |
| (3) Drapeau | `dataSuspicion` vrai | `PLANNER_MSG_DATA_SUSPICION` |
| (4) Validateur | Contrôles de la section 5.3 | Proposition, question ou refus |
| Contrôle final | Schéma strict de l'assistant, résumé non vide | `PLANNER_MSG_PROPOSAL_INVALID` |

Un texte libre du modèle (réponse ou question) n'est jamais montré sans avertissement si le drapeau est levé : un avertissement précède
la réponse (`PLANNER_MSG_SUSPICION_WARNING`), et une question suspecte n'a **pas** de boutons de choix.

Détection (`detectPlannerInjection`) : détection générique `detectInjection` (`workflow-agents/injection/suspicion.ts`,
codes : ignorer les consignes, changement de rôle, prompt système, révélation, exfiltration, fausse balise, faux message de
rôle, faux appel d'outil, caractères cachés), plus les balises propres au planificateur. Elle est **heuristique** : elle
signale, elle ne défend pas. La défense tient à l'isolation, au schéma strict et au validateur.

### 5.3 Contrôles du validateur

Le validateur (`action-validator.ts`) recalcule chaque action depuis le **message de l'utilisateur** et les **preuves**.
Ordre : structure, intention, puis contrôles par action, doublons, questions (un refus prime sur une question), génération
des brouillons, contrôle final.

| Contrôle | Règle | Issue si échec |
| --- | --- | --- |
| Structure | 1 à `maxActions` actions ; outil parmi les 3 de la v1 ; pas de doublon exact | Refus |
| Intention | Une phrase de l'utilisateur (message courant, puis échange récent) doit donner un **ordre** pour l'outil. Une question n'en est pas un, sauf formule de demande (« peux-tu », « merci de », « can you »). Négation, constat (« a été imputé ») et remerciement ne comptent pas. | Refus `intent_not_established` |
| Courrier établi | Ordre de priorité : numéro cité dans le message courant (il l'emporte) ; sinon courrier de la page ouverte ; sinon recherche dont le texte figure dans le message et qui n'a renvoyé **que** ce courrier ; sinon référence contenant un chiffre, citée par l'utilisateur. Un numéro des messages précédents ne compte que si aucune page de courrier n'est ouverte. | Question `mail_not_established` (avec choix) ; refus si illisible |
| Acteur (origine) | Le destinataire doit sortir d'un `acteurs_imputables` dont le **filtre figure dans le message** et qui explique l'acteur (résultat unique), ou être désigné par son nom dans le message. Un nom d'acteur ne vient jamais d'un courrier. | Refus `actor_not_established` ; question si plusieurs acteurs |
| Acteur (droit) | `resolveImputableActor` : actif et imputable. Droit d'imputer requis (`canImpute`). | Refus |
| Type | Mention explicite du message courant, à défaut des messages précédents. Sinon **« Pour suivi »** (identifiant 10), s'il est actif. Le type proposé par le modèle est **ignoré**. « DG » ou « validation » seuls, ou deux types forts, sont ambigus. Plusieurs destinataires avec des types différents : question. | Question |
| Doublon | Imputation encore ouverte, même courrier, acteur et type ; destinataire répété | Refus |
| Délai | Extrait du message courant, à défaut des messages précédents ; **en jours, de 1 à 90**. Une date, des jours ouvrés, un décimal, une urgence sans nombre, ou plusieurs valeurs : question. Hors plage : question. Aucun délai évoqué : imputation sans délai. Le délai du modèle n'est jamais repris. | Question `delay_ambiguous` |
| Relance | Imputation vue par `imputations_courrier` dans cette requête, non traitée, **échéance dépassée**, acteur actif. L'utilisateur est auteur de l'imputation ou peut imputer. Au plus **1 relance par cible et par jour UTC**. Si plusieurs retards : l'acteur doit être nommé. | Refus ou question |
| Brouillon | Modèle parmi `DRAFT_TEMPLATES`. Espace **obligatoire** (`spaceId`) ; s'il y en a plusieurs, il doit être désigné par l'utilisateur. Au moins un espace accessible. Courrier facultatif, mais établi s'il est donné. | Question ou refus |
| Brouillon (génération) | Exécutée en dernier, seulement si aucune autre action n'est refusée ou posée en question. Texte généré vide ou > 20 000 caractères : refus. | Refus |
| Doublons entre actions | Même courrier, acteur et type ; même brouillon | Refus |
| Contrôle final | Schéma strict de l'assistant, `parse` de l'applicateur du catalogue, JSON canonique stable (le hash calculé à la proposition doit correspondre à celui de la confirmation) | Refus `unstable_arguments` ou `invalid_arguments` |

Toute exception inattendue du validateur (port de données, générateur) donne un refus `internal`, sans contenu.

### 5.4 Ce qui est construit par le code

- **Motif** d'imputation : « Demande de l'utilisateur (assistant) : « … » », avec le message courant neutralisé (500 caractères au plus).
- **Message de relance** : « Relance depuis l'assistant : merci de traiter le courrier réf. X. » (ou « n°X »), 500 caractères au plus.
  Notification interne, jamais un e-mail.
- **Titre de brouillon** : « Réponse au courrier … » ou « Brouillon de réponse ». Le libellé proposé par le modèle est ignoré.
- **Consigne de brouillon** : le message courant (4 000 caractères au plus), jamais un texte de courrier.
- **Résumé** (`buildActionSummary`) : en-tête « À confirmer (N effets) », puis une ligne par effet. Les libellés sont
  neutralisés, sur une ligne, et raccourcis si besoin (80, puis 50, 30, 18, 10 caractères). Mention « (type par défaut) »
  quand le type vient du défaut. 2 000 caractères au plus.
- **Réponse** : « Je propose : », le résumé, puis « Confirmez pour appliquer (valable 15 minutes). ».

### 5.5 Corpus d'attaque

- Fichier : `planner.injection-corpus.ts`. **103 cas** : 94 attaques et 9 témoins (`benign`). **17 catégories** de 4 à 12 cas
  (par exemple : hors cadre 12, témoin 9, fausse balise 8, demande légitime et piège 8, message innocent 7, unicode 6,
  courrier « imputez à X » 6, brouillon dicté 6).
- Attendus : **85 cas sans action**, avec la couche qui arrête (`suspicion` 41, `validateur` 40, `intention_externe` 3,
  `reponse` 1) ; **18 cas à action exacte**, dont les arguments complets sont fixés.
- Chaque cas décrit le message, le contexte de page, les données piégées (courriers, acteurs, historique) et un script de
  modèle compromis.
- Rejeu : `pnpm --filter @archivage/api test -- modules/assistant/planner/planner-injection` (voir section 10).
  Le test vérifie notamment : aucune action non demandée ; aucun brouillon généré quand une porte refuse ; jamais l'acteur
  piégé (identifiant 99) ; lectures faites avec l'identité de l'utilisateur ; réservations soldées ou libérées ; un jeton
  neuf par prompt ; aucune balise imitée qui survit.

### 5.6 Limites anti-injection

- La détection est heuristique. Un faux négatif ne donne aucun droit, car le validateur refuse une action dont l'intention
  n'est pas établie par le message de l'utilisateur.
- Le corpus est rejoué avec un **modèle scripté** : il valide le code, pas le comportement d'un vrai modèle.

## 6. Porte de coût (`AsstGateService`)

Porte propre à l'assistant, appelée avant chaque appel au modèle et chaque génération de brouillon. Elle s'appuie sur la
porte des agents (`WfAgentGate`) avec `ASST_GATE_DEFINITION_ID = 0`.

- **Au début d'une planification** (`assertRunnable`) : porte globale (mode IA, arrêts d'urgence globaux ou de la
  définition 0, ligne globale `wf_budget` absente = indisponible), puis plafond du jour : consommé ≥ plafond → `budget_exceeded`.
- **Tolérance de la définition 0** : sa ligne dans `wf_budget` est facultative. Absente, elle n'impose aucun plafond propre.
  La ligne globale, elle, est obligatoire.
- **Réservation** (`reserve`) :
  1. coût et jetons finis et positifs, sinon indisponible ;
  2. ligne `asst_user_budget` du jour créée si absente ;
  3. **un seul `UPDATE` conditionnel** sur le montant et les jetons : refus → `budget_exceeded` ;
  4. porte globale `wfGate.reserve`. Refus ou échec : la ligne utilisateur est **compensée** (montant, jetons, nombre
     d'appels ramenés), puis erreur. Aucune réservation partielle ne subsiste.
- **Règlement** (`settle`) : écart entre le coût réel et l'estimation, sur les deux lignes. **Libération** (`release`) :
  annulation complète. Chaque réservation n'est soldée qu'une fois dans le processus. Les erreurs de règlement sont
  journalisées, jamais remontées.
- **Brouillon** : réservation de 4 000 / 3 000 jetons ; réglée sur l'estimation si la génération aboutit, libérée sinon.
- **Correspondance des erreurs** : `budget_exceeded_global` et `budget_exceeded_workflow` donnent `budget_exceeded` ;
  arrêt d'urgence, IA désactivée, `budget_unavailable` et toute autre erreur donnent `assistant_unavailable`.
- **Échec fermé** : toute erreur de lecture ou d'écriture du budget bloque la requête.
- **Jour** : jour UTC.
- **Plafonds par défaut** : voir section 9. Lus à la **création** de la ligne du jour ; une ligne existante garde ses plafonds.
- **Mémoire** : réservations ouvertes et soldées suivies dans le processus (10 000 au plus). Une réservation perdue au
  redémarrage reste comptée : surestimation prudente.

## 7. Magasin Prisma

Tables `asst_conversation`, `asst_message`, `asst_proposal`, `asst_user_budget` (détail : `docs/assistant-donnees.md`).
Service : `AsstProposalStoreService`.

- **Transitions** (`ASST_PROPOSAL_TRANSITIONS`) : proposée vers confirmée, refusée ou expirée ; confirmée vers appliquée ou
  échouée. Appliquée, refusée et expirée sont terminales.
- **Compare-and-set** (`transitionProposal`) : un seul `UPDATE` conditionnel sur l'identifiant, le statut attendu et
  `row_version` attendu, avec `row_version` incrémenté. Zéro ligne : `null` (conflit). Transition illégale : erreur.
  La transition s'écrit dans la transaction de l'exécuteur (`t.db`) quand elle est fournie.
- **Création** : `argsHash` = SHA-256 du JSON canonique des actions (`asstCanonicalActionsJson`, clés triées). Le résumé
  fait 2 000 caractères au plus. `expiresAt` doit être postérieur à `now` et au plus à `now + 15 min` (+ 1 s de marge).
- **TTL** : 15 min (`ASST_PROPOSAL_TTL_MINUTES`). Une proposition est expirée dès `now >= expiresAt`.
  `listExpirableProposals` fournit la liste ; le module assistant ne contient pas encore le job qui les expire.
- **Ajout de message** : transaction avec verrou `SELECT ... FOR UPDATE` sur l'échange ; position = dernier + 1.
- **Propriété** : toute lecture filtre par `userId`. Objet d'un autre utilisateur, identifiant mal formé ou échange masqué :
  `null` (404 côté API).
- **Rétention** : `purge_at` = création + 90 jours (`ASST_RETENTION_DAYS`). La suppression par l'utilisateur masque
  (`deleted_at`) et ramène `purge_at` à maintenant.
- **Purge** (`AsstPurgeService`) : démarre au bootstrap, toutes les `ASST_PURGE_INTERVAL_MINUTES` ; jamais si
  `NODE_ENV=test`. Chaque passage traite au plus 100 échanges, **un par un** (la cascade emporte messages et
  propositions). Un échange refusé par un déclencheur (proposition confirmée, trace d'exécution encore sous rétention) est
  compté « différé » et retenté au passage suivant.

## 8. Conversations (`postMessage`)

1. **Débit** : `AsstMessageRateLimiter`, fenêtre glissante de 60 s, `ASST_MESSAGES_PER_MINUTE` messages par utilisateur.
   Dépassement : `budget_exceeded` avec `retryAfterSeconds`. Limite **par processus**.
2. **Échange** : introuvable ou d'un autre utilisateur : `not_found`, sans appel au planificateur.
3. **Historique** : les 10 derniers messages, avant le nouveau. Contexte de page : celui du corps, sinon celui de l'échange.
4. **Planification** (`plan`) : aucune écriture avant son résultat. Réponse vide ou action sans résumé : `assistant_unavailable`.
5. **Persistance** : message utilisateur, puis message assistant (texte, jetons, `aiDecisionId`), puis proposition si des
   actions sont validées (`expiresAt` = maintenant + 15 min). Trois appels distincts, sans transaction commune.
6. **Réponse** : échange relu, message assistant, proposition éventuelle.

**Questions de précision** : stockées dans `content`, au format « question, ligne vide, 1. choix, 2. choix… »
(`formatClarificationContent`). `detail()` les relit (`parseClarificationContent`) seulement si le dernier message est
un message assistant sans proposition. Aucune colonne dédiée.

## 9. Variables d'environnement

| Variable | Défaut | Effet | Lue |
| --- | --- | --- | --- |
| `ASST_PLANNER_MAX_ACTIONS` | 3 | Actions par proposition. Hors de 1 à 5 ou illisible : 3 ; supérieur à 5 : 5 | À chaque planification |
| `ASST_MESSAGES_PER_MINUTE` | 10 | Messages par minute et par utilisateur, par processus | À la construction du service |
| `ASST_USER_DAILY_CAP_AMOUNT` | 3000 | Montant maximal par utilisateur et par jour (devise du budget). `none` : pas de plafond. Illisible ou négatif : défaut | À la création de la ligne du jour |
| `ASST_USER_DAILY_CAP_TOKENS` | 500000 | Jetons maximaux par utilisateur et par jour. `none`, illisible ou négatif : comme ci-dessus | À la création de la ligne du jour |
| `ASST_PURGE_INTERVAL_MINUTES` | 60 | Intervalle de purge. 0 : désactivée. Illisible ou négatif : 60 | Au démarrage |
| `WF_AGENT_COST_PER_1K_PROMPT` | 5 | Tarif des jetons d'entrée (porte des agents, partagée) | À chaque calcul de coût |
| `WF_AGENT_COST_PER_1K_COMPLETION` | 15 | Tarif des jetons de sortie (porte des agents, partagée) | À chaque calcul de coût |
| `WF_TEST_DATABASE_URL` | absente | Base **jetable** pour les tests d'intégration. Jamais en production | Tests seulement |

`NODE_ENV=test` désactive la purge planifiée.

## 10. Tests

Suites unitaires (sans base, toujours exécutées) : `planner/` (`action-validator`, `intent-guards`, `planner-turn`,
`planner-prompt`, `planner-toolbox`, `planner-data.adapter`, `action-summary`, `asst-planner.service`, `planner-injection`),
`gate/` (`asst-gate.service`, `asst-gate.definition-zero`), `conversations/` (`asst-conversations.service`, routes,
`asst-message-rate-limiter`), `store/` (`asst-proposal-store.service`, `asst-purge.service`, `asst-store.mappers`).

```bash
# Tout le module assistant, sans base (les suites d'intégration sont ignorées)
pnpm --filter @archivage/api test -- modules/assistant

# Corpus d'attaque du planificateur
pnpm --filter @archivage/api test -- modules/assistant/planner/planner-injection
```

Suites d'intégration PostgreSQL : `gate/asst-gate.integration.spec.ts` et `store/asst-proposal-store.integration.spec.ts`.

```bash
WF_TEST_DATABASE_URL=postgresql://<utilisateur>@localhost:<port>/<base jetable> \
  pnpm --filter @archivage/api test -- --runInBand modules/assistant/gate/asst-gate.integration modules/assistant/store/asst-proposal-store.integration
```

```powershell
$env:WF_TEST_DATABASE_URL = "postgresql://<utilisateur>@localhost:<port>/<base jetable>"
pnpm --filter @archivage/api test -- --runInBand modules/assistant/gate/asst-gate.integration modules/assistant/store/asst-proposal-store.integration
```

- Sans `WF_TEST_DATABASE_URL`, ces suites sont **ignorées** (`describe.skip`).
- La base doit être **distincte de `DATABASE_URL`** : les suites refusent sinon.
- Les migrations doivent être appliquées : tables `asst_*` et `wf_budget`.
- Lancer **en série** (`--runInBand`) : la ligne budgétaire globale est partagée.
- Les utilisateurs de test du magasin sont dans la plage 9 200 001 à 9 200 999, nettoyés avant et après.

## 11. Hypothèses métier et limites

### 11.1 Hypothèses à valider

| Hypothèse | Valeur retenue | Où |
| --- | --- | --- |
| Type d'imputation par défaut | « Pour suivi » (identifiant 10), si aucun type n'est cité | `intent-guards.ts`, `decideInputationType` |
| Plafonds utilisateur et jour | 3 000 (montant) et 500 000 (jetons) | `asst-gate.service.ts` |
| Durée d'une proposition | 15 min | `ASST_PROPOSAL_TTL_MINUTES` |
| Fenêtre de débit | 60 s, 10 messages | `asst-message-rate-limiter.ts` |
| Purge planifiée et rétention | 60 min ; 90 jours | `AsstPurgeService`, `ASST_RETENTION_DAYS` |
| Intention « persistante » | Un ordre donné dans les 10 derniers messages de l'échange (environ 5 messages utilisateur) vaut pour la proposition suivante. Type et délai suivent la même règle : message courant, puis historique | `postMessage` (historique) et validateur |
| Relance | 1 par cible et par jour UTC ; notification interne seulement | `RELANCE_MAX_PER_TARGET_PER_DAY` |
| Délai | Jours calendaires : demain 1, huitaine 8, quinzaine 15, semaine 7, mois 30 ; heures seulement si multiples de 24 | `extractDelayCandidates` |

### 11.2 Limites connues

- **Sortie invalide** : une seule tentative par tour, sans nouvel essai.
- **Décision IA** : la réponse porte `aiDecisionId` du **dernier appel du planificateur**. La décision de génération du
  brouillon n'apparaît que dans l'argument `decisionId` de l'action `preparer_brouillon_reponse` ; `outcome.aiDecisionId`
  du validateur n'est pas repris par `asst-planner.service.ts`. À trancher.
- **Recherche** : au plus 30 candidats lus avant filtre des droits : un résultat peut manquer. Texte de courrier tronqué
  à 6 000 caractères : le modèle peut ne pas voir la totalité.
- **Par processus** : limiteur de débit et réservations en mémoire. Avec N instances, les limites sont multipliées par N.
- **Écritures non atomiques** : `postMessage` écrit le message utilisateur, le message assistant puis la proposition, dans
  trois transactions distinctes. Un échec entre deux laisse une trace partielle.
- **Expiration** : le job qui passe les propositions à « expirée » n'est pas encore dans le module assistant.
- **Périmètre** : trois actions seulement (imputation, relance, brouillon). Pas d'e-mail, pas de délégation (le prompt le
  dit au modèle). Aucune exécution dans ce lot.
- **Corpus** : scripté, sans essai avec un modèle réel. Les témoins bénins prouvent que la défense ne bloque pas tout,
  pas la qualité des réponses d'un vrai modèle.
