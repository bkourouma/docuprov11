# Assistant « qui agit » — interface web

Lot A3. Panneau global de chat qui PROPOSE des actions sous forme de carte de confirmation ; rien n'est appliqué sans un
clic explicite sur « Confirmer ». Contrat suivi : `docs/assistant-api.md`, `packages/types/src/asst-dto.ts`,
`packages/types/src/asst-enums.ts`. Modèle de données : `docs/assistant-donnees.md`.

## 1. Où est le code

| Élément | Fichier |
| --- | --- |
| Client des 8 routes, erreur typée, messages français | `apps/web/app/lib/assistant-api.ts` |
| Panneau (Drawer AntD) | `apps/web/app/components/assistant/AssistantDrawer.tsx` |
| État du chat (réducteur pur) et hook | `assistant/_lib/chat-state.ts`, `assistant/useAssistantChat.ts` |
| Carte de confirmation | `assistant/ConfirmationCard.tsx`, logique pure `assistant/_lib/proposal-logic.ts` |
| Liste, fil, saisie, bandeau d'erreur | `ConversationList.tsx`, `MessageThread.tsx`, `MessageInput.tsx`, `UiErrorBanner.tsx` |
| Choix de précision | `ClarificationChoices.tsx` |
| Contexte de page, saisie, accès, erreurs | `assistant/_lib/page-context.ts`, `composer-logic.ts`, `access.ts`, `ui-error.ts` |
| Styles | `assistant/assistant.css`, `assistant/assistant-card.css` (variables AntD / `--da-*`, thèmes clair et sombre) |
| Branchement | `components/AuthShell.tsx` (état d'ouverture, raccourci, panneau), `components/TopBar.tsx` (bouton) |

Aucune entrée n'a été ajoutée à `nav.ts` : il n'y a pas de page `/assistant`, seulement le panneau. Le menu `/assistant`
du catalogue de l'API sert uniquement de droit d'accès.

## 2. Accès, ouverture, contexte

- **Accès** : bouton, raccourci et panneau n'existent que si `/auth/me` renvoie explicitement `/assistant` dans `menuKeys`
  (`hasAssistantMenu`). Liste absente = pas d'accès (refus par défaut).
- **Ouverture** : bouton étincelle dans la barre supérieure, à gauche de la cloche ; raccourci **Alt+Maj+A** (bascule).
  Échap ferme (comportement du Drawer). Largeur 480 px, plein écran sous 768 px.
- **Contexte de page** (`pageContextFromPath`) : envoyé à chaque message comme `pageContext`, une DONNÉE que le serveur
  revérifie. Reconnu : `/courriers/{controle|parapheur|recherche|suivi}/[mailId]` (sujet `mail`), `/documents/[id]` et
  `/editeur/[id]` (sujet `document`), `/espaces/[id]` (sujet `space`). Le `route` ne contient jamais l'identifiant ni la
  query. Identifiant non numérique ou de plus de 18 chiffres : route seule, sans sujet. Le fil affiche « Contexte : courrier
  n° 4321 ».

## 3. Écrans et états

1. **Échange** (vue par défaut à la première ouverture) : fil de messages, saisie en bas, boutons « Mes échanges » et
   « Nouvel échange ». Fil vide : trois exemples de demandes. La conversation est créée au premier envoi.
2. **Liste des échanges** : tri par dernier message, titre ou date, nombre de messages, délai avant suppression
   automatique (90 jours), ouverture (reprise), suppression avec confirmation (Popconfirm « Supprimer cet échange ? »).
   États : chargement, vide, erreur avec « Réessayer ».
3. **Saisie** : 1 à 4000 caractères après trim ; Entrée envoie, Maj+Entrée saute une ligne (jamais pendant une composition
   IME) ; compteur au-delà de 80 % ; « Arrêter l'attente » pendant l'envoi (AbortController).

| Situation | Affichage |
| --- | --- |
| 429 `budget_exceeded` ou 429 sans code | Bandeau d'état, « Réessayez dans N s » si `Retry-After`, bouton « Renvoyer le message ». La saisie reste active. |
| 503 `assistant_unavailable` | Bandeau + saisie désactivée avec explication (pas de réessai). |
| 501 `not_implemented` | « Fonction indisponible pour l'instant. » Saisie désactivée. |
| 401 | Le client vide le jeton et redirige vers `/login` (comme `lib/api.ts`). |
| 403 sans code (garde de menu) | « Vous n'avez pas accès à l'assistant. » |
| 404 | « Élément introuvable » ; la carte ou l'échange est retiré de la vue. |
| Réseau, 500 | Message générique en français, réessai manuel. |

Le texte du modèle (messages, résumé, motifs, titres) est TOUJOURS rendu comme texte brut (échappement de React,
`white-space: pre-wrap`) : aucun `dangerouslySetInnerHTML`, aucun lien actif, aucun Markdown interprété. Aucun
`console.*` ne reçoit de contenu de réponse, aucun stockage local ne garde propositions ni `argsHash`.

## 4. Carte de confirmation

Contenu : résumé construit par le serveur, une section par action (libellé de l'outil, courrier, destinataires, délai,
motif, instructions), avertissements, « Valable jusqu'à HH:mm » et compte à rebours (`role="timer"`), boutons
« Confirmer » et « Refuser ». Bandeau fixe : « Cette proposition n'a aucun effet tant que vous ne l'avez pas confirmée. »

| Phase | Statut serveur | Affichage |
| --- | --- | --- |
| Proposée | 0 | Boutons actifs, compte à rebours, avertissement sous une minute |
| En cours | 1 ou appel en cours | « Application en cours », boutons désactivés (le bouton actif en `loading`) |
| Appliquée | 2 | Effets listés (`result.effects`), aucun bouton |
| Refusée | 3 | « Refusée — aucune action n'a été appliquée. » |
| Expirée | 4, ou `expiresAt` dépassé côté client | Aucun bouton (contrat §3.2 et §3.3), « Reformulez votre demande ». Le badge d'état est dérivé de la phase : pendant un envoi il ne dit jamais « Expirée ». |
| Échec | 5 | `errorMessage` du serveur en texte, sinon phrase générique ; jamais le code brut |
| Conflit | 409 `conflict` | La proposition est relue (GET) et réaffichée avec l'avis « La proposition a changé… » ; nouvelle confirmation exigée, l'ancien hash n'est jamais renvoyé. Le bouton « Recharger la proposition » n'apparaît que pour l'avis « à recharger » (la relecture a échoué) ; Confirmer est alors désactivé, le contenu affiché pouvant être périmé. |

Règles appliquées (`resolveProposalError`, tables 3.3 et 3.4 du contrat) : `proposal_expired` et `proposal_not_pending`
relisent la proposition ; `effect_failed` et `effect_forbidden` remplacent la carte par `proposal` s'il est présent ;
`not_found` retire la carte ; aucun réessai automatique. Après `effect_forbidden` sans `proposal` et après une erreur réseau ou 5xx (sans code connu) sur confirmer ou refuser, la proposition est relue (GET) : le résultat de l'appel est incertain, Confirmer ne reste jamais actif sur un état périmé.

L'orchestration confirmer/refuser/relire est une fonction pure injectable (`assistant/_lib/proposal-actions.ts`) testée avec de faux appels : un seul appel réseau pour deux clics synchrones, hash de l'état courant, nouveau hash après conflit, verrou libéré dans tous les cas, aucun appel après l'échéance, réponses tardives ignorées.

- **argsHash** : la confirmation envoie exactement `proposal.argsHash` de la carte affichée (`confirmPayload`, test
  d'égalité stricte). Le client refuse sans appel réseau un hash qui n'est pas `^[0-9a-f]{64}$`.
- **Double clic impossible** : verrou synchrone (`createSubmitLock`) pris avant tout `await`, plus `busy` qui désactive les
  deux boutons. Les appels confirm et refuse ne sont jamais abandonnés à la fermeture du panneau (le serveur exécute).
- **Brouillon de réponse** : `draftHtml` n'est JAMAIS rendu en HTML. La carte montre un aperçu texte (balises retirées,
  400 caractères) et la taille. Aucune dépendance d'assainissement ajoutée.
- **Identifiants** : les actions ne portent que des numéros (groupe, type, courrier) ; la carte affiche « n° X » et laisse le
  `summary` serveur porter les noms.
- **Questions de précision** : `ClarificationChoices` affiche des boutons qui renvoient la réponse choisie comme message.
  Le contrat n'ayant pas de champ pour cela, `readClarification` lit une propriété optionnelle `clarification` (voir §6).

## 5. Accessibilité

- Drawer AntD : `role="dialog"`, `aria-modal`, piégeage du focus, retour du focus au bouton, Échap. Focus mis dans la saisie à
  l'ouverture.
- Carte : `<section role="region" aria-labelledby>` ; UNE zone `aria-live="polite"` par carte, qui ne porte que le texte du
  changement d'état (« Proposition appliquée. », etc.), jamais le compte à rebours ; erreurs en `role="alert"`, avis en
  `role="status"` ; l'état est dit en texte, jamais par la seule couleur.
- Fil : groupe nommé (volontairement PAS `role="log"`, dont le live implicite doublerait les annonces de la carte), focalisable et défilable au clavier ; une zone live annonce « Nouvelle réponse de l'assistant. » (texte
  constant) ; l'historique chargé n'est pas annoncé.
- Focus : la carte est focalisable (`tabIndex=-1`) ; quand sa phase change après une action (boutons désactivés ou retirés), le focus y est replacé, sauf s'il se trouve dans un autre champ.
- Raccourci : fondé sur la lettre produite (`key`), donc correct en AZERTY ; `code` n'est utilisé que si `key` n'est pas une lettre ASCII (Alt sur Mac) ; les répétitions de touche sont ignorées.
- Échec de suppression d'un échange : bandeau d'erreur dans la liste (« Suppression impossible… »).
- Ordre de tabulation de la carte : Confirmer puis Refuser. Cibles tactiles d'au moins 44 px, `:focus-visible` à 2 px,
  `prefers-reduced-motion` respecté, longs textes coupés (`overflow-wrap: anywhere`).
- Couleurs : uniquement les variables AntD / `--da-*` (thèmes clair et sombre).

## 6. Écarts du contrat à trancher

1. **Questions de précision** : aucun champ dans `AsstMessageDto`. Hypothèse : propriété optionnelle
   `clarification: { question?: string; choices: string[] }` (2 à 6 choix de 80 caractères maximum) sur un message assistant.
   Sans elle, la fonctionnalité reste inerte. `assistant/_lib/conversation-logic.ts` (`readClarification`).
2. **Noms absents** : groupes d'utilisateurs et types d'imputation ne sont connus que par identifiant ; seul `summary` porte
   les libellés.
3. **Avertissements** : le contrat n'en fournit pas. Ils sont déduits côté client (action non annulable, plusieurs actions,
   expiration proche) dans `cardWarnings`.
4. **`Retry-After`** : non mentionné par le contrat pour `budget_exceeded` ; lu s'il est présent.
5. **Ordre de la liste** non fixé : tri client par `lastMessageAt` décroissant.
6. **`effect_forbidden`** : corps `proposal` « selon l'exécuteur » ; géré s'il est présent, sinon avis d'erreur.
7. **`ASST_ROUTES.errors`** ne déclare 501 que sur deux routes alors que toutes le renvoient en A0 : le client traite 501
   partout.
8. **Aucune pagination des messages** : un très long échange charge tout le fil.

## 7. Tests

`cd apps/web && pnpm test` (suite complète, les fichiers `assistant*` sont dans le script `test`). Couverture : client API
(8 routes, 11 codes, `Retry-After`, 401, annulation, hash), logique pure (contexte de page, saisie, raccourci, réducteur,
propositions, erreurs), composants en `renderToStaticMarkup` (tous les états de la carte, plusieurs actions, injections
HTML dans résumé, motif, message, libellé, valeurs d'effet, brouillon, titre d'échange), absence de `dangerouslySetInnerHTML`
vérifiée dans les sources.

## 8. Non vérifié faute d'écran réel

- Rendu visuel (clair, sombre, mobile 375 px, plein écran), contrastes mesurés, focus et ordre de tabulation réels.
- Comportement au clavier et au lecteur d'écran (NVDA, VoiceOver) : annonces des zones live, piégeage du focus du Drawer.
- Replacement du focus sur la carte, absence réelle de doublons d'annonces (carte, zone d'annonce, Drawer) selon les lecteurs d'écran.
- Chargement différé du panneau (`next/dynamic`, `ssr: false`) en navigateur.
- Focus automatique de la saisie via la ref du `TextArea` AntD, défilement automatique du fil.
- Effets du hook `useAssistantChat` (timers, annulation, courses entre requêtes) : seule sa logique pure est testée.
- Parcours complet contre l'API réelle (A1 et A2) : tout est développé et testé contre le contrat et des faux ; en A0 les
  routes répondent 501.
- Décalage possible de l'heure « Valable jusqu'à » si le fuseau du navigateur diffère de celui attendu (heure locale du
  navigateur).
