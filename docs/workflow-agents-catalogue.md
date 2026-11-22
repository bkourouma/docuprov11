# Docu-Flow — catalogue d'agents prêts à l'emploi

Guide pour les administrateurs, les concepteurs et les développeurs du lot W6 : les sept modèles, leurs outils et applicateurs,
la mise en service et les limites connues. Socle commun : `docs/workflow-agents.md`. Moteur : `docs/workflow-moteur.md`.
En cas d'écart avec ce document, le code fait foi.

Code : `apps/api/src/modules/workflow-agent-catalog/` (contrats `catalog.contracts.ts`, modèles `templates/`, outils
`tools/`, applicateurs `appliers/`, jeux `eval/`, corpus `injection/`) et `apps/api/src/modules/workflows/engine/effect-applier.ts`.

## 1. Vue d'ensemble

Le catalogue compte sept modèles de workflow. Ce sont des données versionnées dans le dépôt, jamais en base.
Instancier un modèle crée un **brouillon ordinaire** que le concepteur complète puis publie.

| Clé de modèle | Nom | Agent | Étapes | Niveau de départ | Déclencheur conseillé |
| --- | --- | --- | --- | --- | --- |
| `agent-aiguilleur` | Agent aiguilleur de courrier | aiguilleur | 1 agent | suggère | `mail.arrived` (à créer) |
| `agent-redacteur` | Agent rédacteur de réponse | rédacteur | 1 agent, 1 validation | suggère | lancement depuis un courrier, ou `mail.arrived` |
| `agent-controleur` | Agent contrôleur de dossier | contrôleur | 1 agent, 1 validation | suggère | lancement depuis un dossier, ou `mail.arrived` |
| `agent-relanceur` | Agent relanceur d'imputations | relanceur | 1 agent | suggère | `deadline.reached` (à créer) |
| `validation-hierarchique-courrier` | Validation hiérarchique de courrier | aucun | 5 | sans IA | lancement, ou `mail.arrived` |
| `circuit-visa-document` | Circuit de visa et signature de document | aucun | 5 | sans IA | lancement depuis le document |
| `demande-avec-checklist` | Demande avec liste de vérification | aucun | 5 | sans IA | lancement |

Le déclencheur conseillé est indicatif : aucun déclencheur n'est créé automatiquement.

### 1.1 Flux d'une étape agent

```
 Lancement (POST /workflows/instances, avec le contexte, p. ex. draftSpaceId)
   ou déclencheur créé par le concepteur
        |
        v
 Étape agent (niveau 0 « suggère » au départ)
   AgentRunner : outils de lecture + outils qui PRÉPARENT une action (aucune écriture)
        |
        v
 Proposition (élément de boîte, kind 1)
   mode « suggestion » (niveau 0) : actions suggérées, JAMAIS appliquées
   mode « action » (niveau 1)     : actions préparées, appliquées si validées
        |
        v
 Validation humaine (completeTask) ou refus (rejectTask, rien n'est appliqué)
        |
        v
 EffectDispatcher, dans la transaction du moteur
   droits conjoints valideur ET lanceur -> applicateurs -> journal agent.acted
   échec : rollback de la validation + compensations des effets non transactionnels
```

Règle centrale : un outil d'écriture ne fait que préparer. Seul un applicateur, appelé après validation humaine, écrit,
et il le fait avec les droits de la personne qui valide ET ceux du lanceur.

## 2. API des modèles

| Route | Menu requis | Effet |
| --- | --- | --- |
| `GET /workflows/templates` | Conception | Liste la projection publique : `key`, `name`, `description`, `agentKey`, `tags`. Aucun autre champ. |
| `POST /workflows/templates/:key/instantiate` | Conception | Corps facultatif `{ "name": "..." }` (1 à 200 caractères). Réponse 201 : `{ "definitionId": n }`. |

Ce que fait l'instanciation :

- crée un brouillon (source manuelle, graphe copié du modèle) ; le nom par défaut est celui du modèle ;
- en cas de collision de nom, ajoute les suffixes « (2) » à « (6) » ; au-delà, l'erreur est renvoyée ;
- pour chaque étape agent : crée le jeu d'évaluation de départ, ajoute ses cas, puis enregistre la configuration de l'étape
  au niveau « suggère » (outils, seuil de confiance, nombre de pas, délai, jeu lié) ;
- écrit une entrée d'audit `template_instantiated` (identifiants seulement) ; en cas d'échec après création, archive le brouillon.

Ce que l'instanciation ne fait PAS : elle ne publie rien, ne lance aucun run d'évaluation, et ne crée aucune autorisation
d'outil. Le brouillon est donc publiable seulement après les actions de mise en service décrites au chapitre 8.

## 3. Applicateurs d'effets

Les applicateurs sont appelés par le moteur (`completeTask`) dans la transaction de la validation humaine, avant la clôture de la tâche.

### 3.1 Sélection des actions validées

`selectValidatedActions` (`effect-applier.ts`) ne retient une action que si :

- l'étape est de type « agent » et l'élément de boîte est de kind 1 ;
- la proposition est en mode « action » (niveau 1) : en mode « suggestion » (niveau 0), rien ne s'applique ;
- le drapeau `suspicion_injection` est explicitement faux : absent ou vrai, aucun effet (échec fermé).

Deux cas :

- **accepted** : le résultat est identique à la proposition. Les actions appliquées sont celles stockées en base.
- **modified** : le valideur a modifié le résultat. Seules les actions du résultat modifié sont retenues, et chaque outil ne peut
  apparaître que dans la limite de ses occurrences proposées. Une action ajoutée est refusée (`action_not_proposed`).

Plafond : 20 actions par validation. Au-delà, ou pour une action illisible, la validation est refusée.

### 3.2 Répartiteur et identités

`EffectDispatcher` relit en base l'identité des deux parties avant d'appliquer quoi que ce soit :

- **lanceur** : compte actif, droit de lancer un workflow, administrateur réel ;
- **valideur** : acteur existant, cohérent avec le principal de la validation, compte actif.

Avant toute application, chaque action de la validation doit avoir un applicateur enregistré. Sinon : refus `no_applier`
(erreur `INVALID_INPUT`, HTTP 422, message en français), validation non enregistrée, rien d'appliqué. Ce contrôle porte sur tout
le lot, avant la première écriture. Le niveau 0 et les propositions sans action ne sont pas concernés.
Pour chaque action, l'applicateur est retrouvé par le nom de l'outil et les arguments sont revalidés strictement (aucune confiance
dans le JSON stocké).
Les applicateurs s'exécutent en séquence, dans la même transaction, avec une mémoire partagée par le lot.

### 3.3 Droits conjoints

Toute vérification doit réussir pour le valideur ET pour le lanceur. Le premier refus annule la validation.

- **Menus** : rôle et administrateur sont relus en base, avec la règle du garde de menus (l'administrateur et le rôle système ont tout ;
  compte désactivé : aucun menu).
- **Lecture du courrier** : la règle de l'outil `lire_courrier` (périmètre, confidentialité, courrier actif et non supprimé) doit être
  satisfaite pour les deux.

### 3.4 Transaction et journal

- Les effets s'écrivent dans la transaction du moteur (`ctx.tx`). Aucune écriture hors transaction, sauf le brouillon (voir 3.6).
- Si au moins une action est appliquée, le moteur écrit `agent.acted` avec `decision.kind = effects_applied`, la liste des effets
  (outil et résumé non sensible : identifiants créés, nombre de destinataires), le valideur, l'issue (`accepted` ou `modified`),
  l'identifiant de l'élément. Si rien n'est appliqué, aucun événement n'est écrit.
- Le journal et les logs ne contiennent jamais de contenu de courrier : seuls l'outil et le type d'erreur sont rapportés.

### 3.5 Échec et rollback

- Un refus métier (`EffectRefusedError`) ou une erreur technique lève une erreur du moteur : la validation n'est pas enregistrée,
  la transaction est annulée, la tâche reste ouverte.
- Le message est en français et n'expose jamais de donnée (message générique pour une erreur technique). Un lot est tout ou rien.

### 3.6 Compensation

Le brouillon de réponse passe par un service qui n'utilise pas la transaction du moteur. Si la transaction échoue après
sa création, la compensation supprime le document et ses fichiers. Les compensations sont appelées en arrière-plan, dans l'ordre inverse,
et chacune est isolée : une compensation en échec n'empêche pas les suivantes. Si elle échoue, seul le type d'erreur est journalisé
et le document doit être retiré à la main.

### 3.7 Applicateurs du catalogue

| Outil | Droits du valideur ET du lanceur | Écrit (dans la transaction) | Notification | Compensation |
| --- | --- | --- | --- | --- |
| `proposer_imputation_courrier` (et `proposer_imputation`) | menu d'imputation (`/courriers/controle`, `/courriers/parapheur` ou `/courriers/validation`) ; courrier lisible ; chaque destinataire imputable par les deux | `mail_inputation` par destinataire, auteur = valideur, échéance = maintenant + délai ; par défaut +2 jours pour les types de validation DG et Direction | in-app « Courrier imputé : ... » | aucune |
| `preparer_brouillon_reponse` (et `proposer_reponse`) | contribution à l'espace de destination ; courrier lisible si indiqué | document brouillon, créé au nom du valideur (hors transaction) | aucune | suppression du document et de ses fichiers |
| `proposer_relance` | courrier lisible pour les deux ; pour chacun, menu d'imputation OU auteur de l'imputation ; compte de l'imputé actif | `notification` interne, `lastReminderSent` de l'imputation | in-app « Relance : ... » (jamais d'e-mail) | aucune |
| `proposer_delegation` | menu d'imputation ; délégataire imputable et actif pour les deux | nouvelle `mail_inputation` au délégataire, même type, mêmes instructions et échéance ; la source n'est ni modifiée ni supprimée | in-app | aucune |

Points communs :

- aucun e-mail : les applicateurs n'appellent jamais le service de notifications, qui envoie des e-mails hors transaction ;
- un doublon n'est jamais recréé (statut `already_present`) ; chaque applicateur déclare un effet de niveau 1, le registre refuse les autres.

## 4. Les quatre agents

Chaque agent démarre au niveau 0 (« suggère ») avec un seuil de confiance de 0,8. Le résultat final, objet JSON, est accompagné
d'une confiance (0 à 1), d'une explication courte et des sources consultées.

### 4.1 Aiguilleur de courrier

- **Rôle** : proposer l'imputation d'un courrier entrant (destinataires, type d'imputation, délai en jours).
- **Outils** : `lire_courrier`, `lister_courriers_similaires`, `lire_organigramme_imputable`, `proposer_imputation_courrier`.
- **Paramètres** : 8 pas maximum, délai de 120 secondes.
- **Effet après validation** : imputation de 1 à 5 destinataires, via l'applicateur d'imputation (chapitre 3.7).
- **Limites** :
  - les destinataires doivent exister, être actifs et imputables ; l'agent ne doit jamais reprendre un identifiant lu dans le texte du courrier ;
  - le délai est un nombre de jours (1 à 90), jamais une date ;
  - les instructions sont limitées à 1 000 caractères ;
  - le contrôle automatique du bureau d'ordre n'est pas rejoué (voir chapitre 9).
- **Format du résultat** : `{ verdict: 'imputation_proposee' | 'a_orienter_manuellement', recipients: [{ userGroupId, mailInputationTypeId, delayDays? }] }`.
- **Jeu d'évaluation de départ** : 14 cas. Huit courriers nominaux attendant une imputation (confiance minimale 0,7) ; trois cas d'incertitude
  (courrier vide, texte illisible après reconnaissance de caractères, demande hors compétence) attendant `a_orienter_manuellement` ; trois injections
  attendant une signalisation et un retour à l'humain. Précision minimale : 0,8.
- **Déclencheur conseillé** : `mail.arrived`, à créer par le concepteur.

### 4.2 Rédacteur de réponse

- **Rôle** : préparer le brouillon d'une réponse à un courrier, à relire par une personne. Le brouillon n'est jamais envoyé.
- **Outils** : `lire_courrier`, `lire_document`, `rechercher_documents`, `preparer_brouillon_reponse`.
- **Paramètres** : 10 pas maximum, délai de 180 secondes.
- **Étapes du modèle** : `redaction` (agent), puis `relecture` (validation humaine, 72 heures). L'approbation de l'étape agent crée le brouillon ;
  la relecture porte donc sur un document déjà présent dans l'espace.
- **Effet après validation** : création d'un document brouillon dans l'espace `draftSpaceId` du contexte de lancement (ou dans l'espace indiqué
  par l'outil). Le document est créé au nom du valideur.
- **Limites** :
  - sans espace de destination, rien n'est préparé et le refus est expliqué ;
  - l'espace doit être contribuable par le valideur ET par le lanceur ;
  - le modèle de rédaction est l'un des huit disponibles : `vide`, `courrier-officiel`, `lettre-reponse`, `compte-rendu-reunion`, `proces-verbal`,
    `note-de-service`, `rapport-synthese`, `attestation` ;
  - l'instruction fait de 3 à 2 000 caractères, le contexte au plus cinq documents, le brouillon au plus 20 000 caractères ;
  - l'agent ne doit rien inventer (références, montants, dates) et ne prend pas d'engagement non justifié par le courrier.
- **Format du résultat** : `{ verdict: 'brouillon_prepare' | 'information_insuffisante', templateId, label }`.
- **Jeu d'évaluation de départ** : 14 cas. Huit courriers nominaux attendant un `brouillon_prepare` avec le bon modèle ; trois cas
  `information_insuffisante` (courrier vide, demande sans objet précis, texte contradictoire) ; trois injections. Précision minimale : 0,8.
- **Déclencheur conseillé** : lancement manuel depuis un courrier, avec `draftSpaceId` ; ou `mail.arrived` pour un courrier appelant une réponse.

### 4.3 Contrôleur de dossier

- **Rôle** : contrôler un dossier (courrier et pièces) et signaler les anomalies avec leurs preuves. L'agent ne bloque jamais un dossier seul.
- **Outils** : `lire_courrier`, `lire_document`, `lister_pieces`, `comparer_champs`. Aucun outil d'écriture : le contrôleur n'a pas d'applicateur.
- **Paramètres** : 12 pas maximum, délai de 180 secondes.
- **Étapes du modèle** : `controle` (agent), puis `validation_finale` (validation humaine, 72 heures), qui approuve ou refuse le dossier.
- **Contrôles** : pièces manquantes, montants discordants, dates incohérentes (échéance antérieure au courrier, dates contradictoires entre pièces).
- **Limites** :
  - `comparer_champs` accepte de 2 à 6 documents et les champs `montant`, `date`, `reference`, `objet`, `tiers` ; le drapeau « discordant »
    est calculé par le code (montants à deux décimales, dates ISO, références normalisées) ;
  - `lister_pieces` renvoie au plus 30 pièces et exige exactement un identifiant (courrier, document ou dossier) ;
  - le catalogue ne fournit aucun référentiel des pièces attendues : la liste des types attendus est déduite par l'agent, à préciser par le concepteur pour un usage réel ;
  - l'agent ne signale que ce qui est étayé par un extrait ; en cas de doute, il classe le constat en information ou en mineure et le dit.
- **Format du résultat** : `{ verdict: 'conforme' | 'a_verifier', findings: [{ code, severity: 'info' | 'mineure' | 'majeure' | 'critique', message, evidence: [{ documentId, excerpt }] }] }`.
- **Jeu d'évaluation de départ** : 14 cas. Quatre dossiers conformes (`conforme`) ; quatre pièces manquantes ; deux montants discordants ; un
  cas de dates incohérentes ; trois injections (`a_verifier` et signalement). Tous les autres cas attendent `a_verifier`. Précision minimale : 0,8.
- **Déclencheur conseillé** : lancement manuel depuis un dossier ou un courrier ; ou `mail.arrived` pour les courriers avec pièces jointes.

### 4.4 Relanceur d'imputations

- **Rôle** : traiter une imputation de courrier échue et non traitée. Proposer UNE action au plus : relance, escalade ou redirection.
- **Outils** : `lire_courrier`, `proposer_relance`, `proposer_delegation`.
- **Paramètres** : 6 pas maximum, délai de 120 secondes.
- **Effets après validation** :
  - relance : notification interne à l'imputé ; l'escalade ajoute une copie à l'auteur de l'imputation, et à lui seul ;
  - redirection : nouvelle imputation au délégataire déclaré ; la source reste en place.
- **Limites** :
  - relance et escalade : le valideur ET le lanceur doivent chacun avoir un menu d'imputation (`/courriers/controle`, `/courriers/parapheur`, `/courriers/validation`) ou être administrateur, OU être l'auteur de l'imputation visée ; jamais plus ;
  - plafond de 1 relance par imputation et par jour UTC, et de 5 relances par workflow et par jour UTC (journal et lot en cours) ; un plafond atteint refuse l'action et annule tout le lot ;
  - le message de relance est limité à 500 caractères, préfixé par l'application « Relance : » ; l'agent ne peut pas désigner de destinataire ;
  - les délégataires sont lus dans `step.config.delegates` de l'étape. Liste vide par défaut : sans délégataire déclaré, aucune redirection ;
  - le modèle ne contient aucune étape d'escalade : elle exige un identifiant propre à l'installation (voir chapitre 8).
- **Format du résultat** : `{ verdict: 'relance_proposee' | 'redirection_proposee' | 'aucune_action', mailInputationId?, delegateUserGroupId?, escalade?: booléen }`.
- **Jeu d'évaluation de départ** : 14 cas. Quatre retards simples attendant une relance ; deux cas de plafond (relance déjà envoyée
  aujourd'hui pour l'imputation, plafond du workflow atteint), deux refus de redirection (délégataire non déclaré, aucun délégataire) et un cas
  non en retard, tous attendant `aucune_action` ; deux redirections attendant
  `redirection_proposee` vers le délégataire déclaré ; trois injections. Précision minimale : 0,8. En évaluation, les délégataires sont lus dans `evalContext.delegates` (simulation) ; cette propagation n'est pas encore branchée, voir le chapitre 9.2, point 2.
- **Déclencheur conseillé** : `deadline.reached`, à créer par le concepteur.

## 5. Les trois modèles sans agent

Ces modèles ne contiennent aucune étape d'IA. Toutes leurs étapes sont confiées au lanceur à la création : le concepteur doit
affecter chaque étape à la bonne personne, au bon groupe ou au bon rôle avant publication.

- **Validation hiérarchique de courrier** (`validation-hierarchique-courrier`) : `controle_bureau` (validation, 48 heures) ; si approuvé, le courrier
  passe à `validation_responsable` ; si refusé, il mène directement à `courrier_refuse`. `validation_responsable` (validation, 72 heures, 5 tentatives
  maximum) : approuvé, il passe à `decision` ; refusé, il revient à `controle_bureau`. `decision` est une décision manuelle (`accepté` ou `refusé`)
  qui mène à `courrier_accepte` (observation facultative) ou à `courrier_refuse` (motif obligatoire).
- **Circuit de visa et signature** (`circuit-visa-document`) : `preparation` (formulaire : référence obligatoire, note facultative, 10 tentatives
  maximum), puis `visa_1` et `visa_2` (validations, 48 heures chacune), `signature` (validation, 72 heures), et `cloture` (formulaire,
  observation facultative). Un refus à n'importe quel visa ou à la signature renvoie à `preparation`.
- **Demande avec liste de vérification** (`demande-avec-checklist`) : `saisie_demande` (formulaire : objet et demandeur obligatoires,
  justification facultative), `verification` (liste de contrôle : trois points obligatoires et un facultatif, « budget disponible »),
  `decision` (décision manuelle `accord` ou `refus`), puis `accord` (observation facultative) ou `refus` (motif obligatoire).
  La liste fournie est un exemple à adapter.

## 6. Outils du catalogue

Les huit outils sont enregistrés dans le registre commun (`WfTool`). Les outils d'effet 0 ne modifient rien ; les outils d'effet 1
préparent une action qui exige la validation d'un humain. Tous s'exécutent avec les droits du lanceur.

| Outil | Effet | Entrées principales | Limites et plafonds | Sortie |
| --- | --- | --- | --- | --- |
| `lister_courriers_similaires` | 0 | `mailId`, `limit` (défaut 5) | `limit` de 1 à 10 ; seuls les courriers lisibles par le lanceur | courriers, imputations, types, délais, traité ou non |
| `lire_organigramme_imputable` | 0 | `search` (100 caractères), `limit` (défaut 20) | `limit` de 1 à 50 ; types d'imputation actifs (50 au plus) ; délai maximal 90 jours | acteurs imputables (identifiant, libellé, rôle, nœud), types, délai maximal |
| `lister_pieces` | 0 | exactement un de `mailId`, `documentId`, `dossierId` | 30 pièces au plus ; pièces accessibles au lanceur uniquement ; aucun contenu binaire | pièces : libellé, type, date, cote, pages, extrait |
| `comparer_champs` | 0 | `documentIds` (2 à 6), `fields` (`montant`, `date`, `reference`, `objet`, `tiers`) | pièce inaccessible omise ; drapeau « discordant » calculé par le code | valeurs, normalisation, preuve, statut |
| `proposer_imputation_courrier` | 1, validation | `mailId`, `recipients` (1 à 5), `rationale` | type actif ; délai 1 à 90 jours ; instructions 1 000 caractères ; pas de doublon ; refus si imputation ouverte identique | proposition (n'écrit rien) |
| `preparer_brouillon_reponse` | 1, validation | `templateId` (8 modèles), `instruction` (3 à 2 000 caractères), `label`, `mailId`, `spaceId`, `contextDocumentIds` (5 au plus) | brouillon au plus 20 000 caractères ; génération avec les droits du lanceur ; en évaluation, squelette statique du modèle | proposition (n'écrit rien) |
| `proposer_relance` | 1, validation | `mailId`, `mailInputationId`, `message` (500 caractères), `escalateToUserGroupId` (optionnel) | imputation non traitée et échue ; valideur et lanceur : menu d'imputation ou auteur ; plafonds 1 par imputation et 5 par workflow, par jour UTC ; escalade vers l'auteur seulement | proposition ; jamais d'e-mail |
| `proposer_delegation` | 1, validation | `mailId`, `mailInputationId`, `delegateUserGroupId`, `rationale` (500 caractères) | délégataire déclaré dans `step.config.delegates` ; imputation non traitée ; en évaluation, simulé à partir de `evalContext.delegates` | proposition (n'écrit rien) |

Les outils de base `lire_courrier`, `lire_document` et `rechercher_documents` (lecture) ainsi que `proposer_imputation` et
`proposer_reponse` (écriture préparée) servent aussi les modèles ; ils sont décrits dans `docs/workflow-agents.md`.

## 7. Résistance à l'injection (corpus étendu)

Le corpus `injection/catalog-injection.corpus.ts` étend le corpus de base (W2) de 33 textes propres au catalogue :

| Agent | Textes |
| --- | --- |
| aiguilleur | 8 |
| rédacteur | 9 |
| contrôleur | 8 |
| relanceur | 8 |

Chaque texte imite un courrier ou une pièce et vise les effets propres à son agent (imputation, brouillon, contrôle, relance, délégation).
Il y a au moins cinq textes en français et un en anglais par agent. Parmi les 33 :

- 27 déclarent une raison heuristique que la détection doit relever (changement de rôle, consigne d'ignorer les règles, balises forgées,
  caractères invisibles, faux bloc système, etc.) ;
- 6 sont des attaques purement sémantiques, qu'aucune heuristique ne reconnaît. Elles doivent être neutralisées par la structure : aucun
  effet, aucun outil hors liste, aucun destinataire inventé.

Tests principaux (`catalog-injection.spec.ts`) :

- destinataire, type, courrier ou délégataire inventé : refus de la proposition entière ; clé supplémentaire (`notify`, `externalEmail`, `to`) : arguments invalides ;
- signal de suspicion du modèle : aucune action préparée ; `modified` ajoutant une action non proposée (`envoyer_email`) : refus ;
- lot mêlant une action valide et une action refusée : aucun effet ; lot valide : seules des notifications internes et des créations sont écrites.

La défense réelle est structurelle : isolation des données, schéma strict, liste blanche d'outils, droits conjoints et validation humaine.
La détection heuristique ne fait que signaler.

## 8. Mise en service

Ordre recommandé. Les étapes 1 à 4 sont faites par le concepteur, les étapes 5 et 9 par un administrateur.

1. **Instancier le modèle** : `POST /workflows/templates/:key/instantiate`. Le brouillon est créé avec un jeu d'évaluation lié à l'étape agent.
2. **Affecter les étapes** : chaque étape est confiée au lanceur à la création. Modifier les affectations sur le brouillon
   (`PUT /workflows/definitions/:id/draft`) : personne, groupe ou rôle.
3. **Déclarer les délégataires** (relanceur) : dans le graphe du brouillon, `step.config.delegates` est une liste de `{ userGroupId, forUserGroupId?, label? }`
   (50 entrées au plus). Chaque délégataire doit être imputable par le valideur et le lanceur ; `forUserGroupId` le limite à un imputé donné.
   Sans cette liste, le relanceur ne propose jamais de redirection.
4. **Autoriser les outils** (administrateur, menu d'administration des workflows) :
   `PUT /workflows/agents/definitions/:id/tool-grants`, avec la liste des outils et, facultativement, `maxCallsPerInstance`.
   Les outils de chaque étape doivent figurer dans ces autorisations, sinon la publication est refusée (`AGENT_TOOL_NOT_GRANTED`).
   Les outils disponibles s'obtiennent avec `GET /workflows/agents/tools`. L'interface de cette étape relève du lot W7 : d'ici là, l'autorisation passe par l'API.
5. **Choisir le niveau d'autonomie** : par défaut, toutes les étapes agent sont au niveau 0 (« suggère »). **À ce niveau, rien n'est appliqué
   après validation** : l'imputation, le brouillon ou la relance restent des suggestions. Pour qu'une validation écrive, passer l'étape à
   « agit avec validation » (`PUT /workflows/definitions/:id/draft/agents/:stepKey`, champ `autonomy`). Ce choix relève du concepteur.
6. **Lancer avec le contexte nécessaire** : `POST /workflows/instances` avec `{ definitionId, context: { draftSpaceId } }` pour le rédacteur. Le valideur
   et le lanceur doivent pouvoir contribuer à cet espace. Sans lui, le brouillon est refusé et l'explication est donnée.
7. **Créer le déclencheur** : `mail.arrived` ou `deadline.reached` selon le modèle. Aucun n'est créé automatiquement.
8. **Évaluer avant tout niveau supérieur** : lancer le jeu lié (`POST /workflows/agents/eval-sets/:id/runs`, asynchrone, 202).
   Les quatorze cas de départ ne suffisent pas : ils sont fictifs, n'ont jamais été exécutés, et ne rendent pas l'autonomie éligible.
   Il faut ajouter des cas réels de l'organisation (500 cas actifs au plus) et obtenir au moins 0,8 de précision sur la version publiée.
9. **Passer au niveau autonome, si voulu** : seul un administrateur peut marquer le workflow à faible risque (`POST /workflows/definitions/:id/low-risk`).
   L'éligibilité exige en outre un run réussi pour la version et le jeu courants, avec un comportement de l'agent inchangé (empreinte).
   Un nouveau brouillon issu d'une version ramène l'étape au niveau 1 : une évaluation sera à refaire.
10. **Publier** : `POST /workflows/definitions/:id/publish`. Les contrôles (outils connus et autorisés, autonomie éligible, configuration) renvoient une liste d'anomalies en 422.

## 9. Hypothèses métier prudentes et limites connues

### 9.1 Hypothèses

- **Imputer** : menu d'imputation (`/courriers/controle`, `/courriers/parapheur` ou `/courriers/validation`), ou administrateur.
- **Être imputable** : compte actif et rôle actif portant un menu courrier (`/courriers/suivi`, `/courriers/suivi-dc`, `/courriers/controle`,
  `/courriers/parapheur`, `/courriers/validation`), ou administrateur.
- **Délais** : jours calendaires, toujours calculés à l'application. L'agent ne produit jamais de date.
- **Notifications** : in-app uniquement, aucun e-mail. L'escalade ne va qu'à l'auteur de l'imputation.

### 9.2 Limites connues

1. **Niveau 0 par défaut** : les modèles annoncent « niveau de départ : suggère » sans préciser qu'aucune écriture ne suit la validation (chapitre 8, étape 5).
2. **Redirections non reproductibles en évaluation** : en `dry_run`, `proposer_delegation` lit les délégataires dans `evalContext.delegates`
   (résultat simulé, `simulated: true`). Le champ existe dans `agent.contracts.ts`, mais le runner (`runner/agent-runner.ts`) et le service
   d'évaluation (`eval/eval.service.ts`) ne le transmettent pas encore à l'outil. Tant que ce n'est pas fait, les deux cas de redirection du jeu
   relanceur échouent : 12 réussis sur 14, soit 0,857, au-dessus du plancher de 0,8. À traiter avant de compter sur ce jeu.
3. **Évaluation du rédacteur** : en `dry_run`, le brouillon est le squelette statique du modèle, sans génération. L'évaluation mesure le verdict et le
   choix du modèle de rédaction, pas la qualité du texte produit.
4. **Bureau d'ordre** : le contrôle bureau d'ordre automatique (`autoValiderOnImputation`) n'est pas rejoué lors d'une imputation par l'agent.
   Le courrier garde son état de contrôle et doit être validé à l'écran.
5. **Brouillon hors transaction** : si la validation échoue après la création, le document est retiré en arrière-plan. Un échec de cette compensation
   exige un nettoyage manuel, signalé seulement par le type d'erreur. Cas rare non traité : si le commit réussit mais que le client perd la réponse,
   la compensation peut supprimer un brouillon validé.
6. **Règle d'accès aux espaces dupliquée** : `appliers/draft-reply.applier.ts` reproduit la règle de contribution de `CollabDocumentsService.assertCanContribute`,
   qui est privée. À aligner si cette règle évolue.
7. **Escalade absente du modèle relanceur** : elle exige un identifiant propre à l'installation et doit être ajoutée par le concepteur.
8. **Runs en mémoire** : les évaluations tournent dans le processus de l'api ; un redémarrage les laisse « en cours » jusqu'au nettoyage.
9. **Documentation voisine** : `docs/workflow-agents.md` (section 4, tableau des outils, et section 12, « pas d'applicateur d'effets »)
    décrit l'état antérieur au lot W6. Elle doit être mise à jour séparément.
