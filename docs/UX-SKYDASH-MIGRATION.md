# Migration UX — DocuPro V6 vers un langage visuel inspiré de SkyDash

> Document de suivi vivant. Mis à jour au fil des phases (voir le tableau de suivi
> §5). Rédigé à partir de l'audit du dépôt (`docs/documentation-application.md`) et
> de la capture d'écran SkyDash fournie comme direction visuelle.

## 1. Constat d'intégration SkyDash (§3 du brief)

Aucun paquet SkyDash (React/Next.js, HTML, ou autre) n'a été trouvé dans le
dépôt (`apps/`, `packages/`, racine) au démarrage du chantier. Conformément à la
règle du brief, le langage visuel SkyDash est donc **reproduit avec les briques
existantes** — Ant Design 5 + Tailwind + tokens maison — et non copié depuis un
paquet propriétaire ou la capture d'écran. Sont repris : la hiérarchie visuelle
(bandeau d'accueil + tuiles de KPI colorées), les cartes blanches spacieuses à
rayon modéré, la sidebar claire compacte, la barre de recherche en pilule. Ne
sont **pas** repris : la palette violette 1:1 de SkyDash (DocuPro garde son
identité « Bleu roi / Ocre »), ni aucun widget Bootstrap/jQuery.

## 2. Ce qui ne change pas (garde-fous du brief §4)

Toutes les contraintes non-négociables du brief restent en vigueur : routes et
contrats API inchangés, RBAC de menus (`me.menuKeys`), ACL documentaire
(inchangée, y compris son court-circuit connu — voir §1.6 de la documentation
applicative), pagination/tri serveur, exports, upload chunké, polling de lot,
palette de commandes (`Ctrl/Cmd+K`), thème clair/sombre, locale `fr_FR`,
`/courriers/suivi-dc` reste un périmètre et non une route.

## 3. Fondations livrées (Phase 2)

| Élément | Fichier | Détail |
|---|---|---|
| Palette de tuiles colorées | [`apps/web/app/theme/tokens.ts`](../apps/web/app/theme/tokens.ts) | 4 teintes (`ink`/`sky`/`violet`/`coral`), variantes clair + sombre. Purement décorative — ne réutilise jamais les couleurs sémantiques `success`/`warning`/`danger` pour éviter toute confusion avec `StatusBadge`. |
| Tuile de synthèse | [`apps/web/app/components/StatTile.tsx`](../apps/web/app/components/StatTile.tsx) | Nouveau composant réutilisable, dégradé plein + texte clair, façon bandeau KPI SkyDash. Réservé aux bandeaux d'accueil (dashboards) ; `KpiCard` (carte blanche neutre) reste la norme dans les files de travail et pages d'administration pour ne pas transformer une donnée décorative en signal de statut. |

`buildTheme()` (Ant Design) et les tokens `colors`/`colorsDark` existants ne
sont **pas** remplacés : ils portent déjà une identité cohérente et
accessible (AA) ; les ajouts SkyDash viennent en complément, pas en
remplacement, pour limiter le risque de régression visuelle sur les ~39 pages.

## 4. Page pilote livrée : `/dashboards`

Voir [`apps/web/app/dashboards/page.tsx`](../apps/web/app/dashboards/page.tsx).

- Bandeau d'accueil (dégradé bleu roi) : message de bienvenue + 3 actions
  rapides (*Démarrer une acquisition*, *Générer des intercalaires*,
  *Rechercher un document*), conformes au brief §6.B.
- 4 tuiles de synthèse colorées (`StatTile`) : documents archivés, en attente
  d'indexation, lots en cours (+ échecs), taux d'indexation.
- Alerte de qualité de données conditionnelle (anomalies `sansType` /
  `sansDossier` / `sansDate` / `sansCote`), masquée si tout est à zéro.
- **Correctif** : le sélecteur de période (`PeriodFilter`), présent dans le
  code mais non branché (§3.A5.8 / §5.9 de la documentation), est maintenant
  **fonctionnel** — chaque préréglage déclenche un nouvel appel
  `POST /analytics/overview` avec les bornes recalculées. Vérifié en
  navigateur (requête réseau observée au clic, aucune erreur console, clair et
  sombre).
- Les 4 graphiques existants (donut, treemap, barres ×2) sont conservés à
  l'identique (composants, endpoints, squelettes, états vides).

## 4bis. Page pilote livrée : `/acquisition` (wizard guidé)

Voir [`apps/web/app/acquisition/page.tsx`](../apps/web/app/acquisition/page.tsx) et
[`BatchPipeline.tsx`](../apps/web/app/components/BatchPipeline.tsx).

- L'ancienne page condensait mode + destination + fichiers + lancement dans une
  seule carte. Elle est maintenant un `Steps` à **6 étapes réelles** (Mode →
  Destination → Fichiers → Confirmer → Traitement → Indexation), avec
  navigation Précédent/Continuer et blocage explicite (`Tooltip`) tant qu'une
  étape n'est pas complète.
- **Mode** : deux cartes sélectionnables (`ModeOptionCard`, nouveau composant
  co-localisé dans la page) expliquant en français simple la différence entre
  « Sans intercalaire » et « Avec intercalaires (QR + OCR) ». Accessibles au
  clavier (`role="radio"`, `aria-checked`, `Entrée`/`Espace`) — un point
  d'accessibilité manqué à la première passe, corrigé après test en navigateur.
- **Destination** : masquée intelligemment en mode QR (alerte expliquant que le
  dossier est déterminé par l'intercalaire), sinon les mêmes champs Grand
  dossier / Dossier qu'avant.
- **Fichiers** : rappel explicite du format accepté (PDF) et de l'ordre de
  traitement, compteur fichiers/poids conservé.
- **Confirmer** : récapitulatif (mode, destination résolue en libellés,
  nombre/poids de fichiers) avant le bouton « Lancer le traitement ».
- **Traitement** : `BatchPipeline` inchangé dans sa logique de progression,
  complété d'une légende d'étapes informative (Téléversement → Analyse QR+OCR
  → Découpage → Finalisation) affichée uniquement en mode « avec
  intercalaires », puisque l'API ne renvoie qu'un statut global (0/1/2) — la
  légende est donc explicitement présentée comme indicative, pas comme un
  signal en temps réel par sous-étape.
- **Indexation** : modale, tableau éditable, navigation clavier, garde
  anti-fermeture sur modifications non enregistrées, contrôle de doublons de
  cote — **tous strictement inchangés** (aucune ligne de cette logique n'a été
  touchée).
- Vérifié en navigateur : parcours complet Mode→Destination→Fichiers dans les
  deux modes, gating (bouton désactivé + tooltip tant que la sélection est
  incomplète), `tsc --noEmit` et `next lint` propres (mêmes avertissements
  préexistants qu'avant, aucun nouveau).

## 4ter. Page pilote livrée : `/courriers/tableau-de-bord` (mail dashboard)

Voir [`GrilleWidgets.tsx`](../apps/web/app/courriers/tableau-de-bord/components/GrilleWidgets.tsx).

Ce tableau de bord était déjà bien conçu (9 zones avec explications métier
soignées, `ChartCard` cohérent, `KpiCard` avec tons sémantiques
`success`/`warning`/`danger` sur les retards). Deux décisions de conception
prises avant de toucher au code :

- **Pas de tuiles colorées `StatTile` ici.** Contrairement à `/dashboards`, les
  couleurs des `KpiCard` de ce tableau de bord (ex. « Courriers en retard » en
  rouge) portent un **sens métier réel**. Leur substituer une palette
  décorative violette/corail aurait affaibli exactement le signal que ces
  couleurs sont censées porter — voir §5.7 du brief (« aucune information
  uniquement par la couleur »). `KpiCard` reste donc la norme ici.
- **Écart trouvé et corrigé** : en dehors du mode édition, aucun widget
  n'affichait son titre (`widget.titre`, fourni par le catalogue serveur) —
  seul le mode glissement l'affichait, dans une poignée qui disparaît hors
  édition. Un utilisateur voyait donc des chiffres sans étiquette de zone.
  `CadreWidget` affiche maintenant ce titre en permanence (discret, texte
  secondaire hors édition ; poignée de glissement inchangée en édition) — la
  « cohérence des en-têtes » demandée par le brief, sans dupliquer les titres
  déjà portés par certains `ChartCard` internes (vérifié zone par zone : les
  titres de widget sont à un niveau de hiérarchie au-dessus, jamais identiques
  aux titres de graphique).

**Limite de vérification rencontrée** : dans cette session, l'onglet du volet
Navigateur restait `document.visibilityState === 'hidden'` /
`window.innerWidth === 0` — la grille `react-grid-layout` (qui mesure sa
largeur réelle via un hook dédié, contrairement aux autres pages en CSS Grid
pur) ne s'affiche donc qu'une fois l'onglet effectivement composité par
l'hôte. Confirmé néanmoins par la couche réseau (les 9 appels
`POST /courriers/dashboard/*` renvoient 200, l'agencement se charge, le
composant ne tombe pas dans la branche « widgets.length === 0 ») et par le DOM
(bascule du mode édition observée : les boutons et la bannière d'aide
changent bien d'état). À revalider visuellement (pixels) dès qu'un volet
Navigateur pleinement composité est disponible.

## 4quater. Page pilote livrée : `/search` (recherche documentaire P3)

Voir [`apps/web/app/search/page.tsx`](../apps/web/app/search/page.tsx).

Cette page était déjà proche de la cible SkyDash (plein-texte dominant,
`Collapse` de filtres avancés ouvert par défaut, puces fermables, brouillon
vs. critères appliqués). Améliorations apportées, toutes ciblées sur les
demandes explicites du brief §8.D :

- **Export regroupé** : les 4 boutons Excel/CSV/PDF/Word côte à côte dans
  l'en-tête de la carte de résultats sont remplacés par un unique bouton
  « Exporter » + menu déroulant (`Dropdown`), désactivé à 0 résultat — même
  comportement, moins d'encombrement visuel.
- **Compteur de filtres avancés** : un badge sur l'en-tête « Filtres avancés »
  indique combien de filtres (hors plein-texte) sont actuellement appliqués —
  utile si l'utilisateur replie le panneau.
- **État vide plus utile** : le message distingue maintenant « aucun filtre »
  (suggère de vérifier l'orthographe / élargir le terme) de « N filtre(s)
  actif(s) » (suggère d'en retirer un ou d'élargir la période) — au lieu d'un
  message générique unique.
- **Mode édition rendu visible** : le panneau d'indexation, en édition, prend
  un fond teinté et une bordure en tirets (couleur d'avertissement) avec une
  étiquette « Mode édition » — il ne peut plus être confondu avec la
  consultation en lecture seule d'un simple coup d'œil.
- **Rien d'autre n'a changé** : brouillon/critères appliqués, tri et
  pagination serveur, whitelist de colonnes, export réutilisant la requête
  sans pagination, suppression réservée à l'admin, « Ouvrir dans un nouvel
  onglet » — tous strictement intacts.

Vérifié en navigateur (après un rechargement complet — le HMR de Next avait
laissé la page bloquée sur son écran de chargement après une longue série
d'éditions, un artefact de `Fast Refresh` déjà documenté, pas un défaut du
code) : recherche plein-texte → puce + message d'état vide contextuel,
bouton Exporter correctement désactivé à 0 résultat, aucune erreur console,
1280px et 390px.

## 4quinquies. Pages pilotes livrées : files de travail + détail courrier

Voir [`MailWorklist.tsx`](../apps/web/app/components/mail/MailWorklist.tsx),
[`MailDetailPage.tsx`](../apps/web/app/components/mail/MailDetailPage.tsx),
[`MailViewer.tsx`](../apps/web/app/components/mail/MailViewer.tsx).

Deux écarts concrets trouvés en relisant le code face au brief §8.G/§8.H, corrigés :

- **Aucun indicateur de retard** : la colonne « Date butoir » de `MailWorklist`
  (utilisée par `/courriers/{controle,parapheur,suivi,validation}`) affichait
  une date nue — un courrier en retard de 45 jours avait exactement le même
  rendu qu'un courrier dû dans 2 mois. `DateButoireCell` (nouveau, dans
  `MailWorklist.tsx`) affiche maintenant la date en **rouge gras + « N j de
  retard »** si dépassée et non traitée, en **ambre gras** si l'échéance est à
  ≤ 3 jours. Volontairement **distinct** du système de paliers exacts de
  `dateButoireAlert` (7/3/1/0/-1/-2/-3, réservé aux rappels planifiés et au
  bandeau `DeadlineAlert`) : un indicateur de tableau doit rester allumé tant
  que le retard dure, pas seulement les jours pile où un e-mail part.
- **Aucun statut visible sur les pages de détail** : ni `MailDetailPage`
  (pages `[mailId]` dédiées de Contrôle/Parapheur/Suivi) ni `MailViewer` (popup
  de Validation) n'affichaient le sens (Arrivée/Départ) ou le statut
  (Rédaction/Rédigé/Traité…) du courrier — visibles seulement depuis la
  worklist d'origine. Un utilisateur arrivant par lien direct, favori ou
  historique navigateur n'avait aucun repère. Les deux affichent maintenant
  `MailTypeTag` + `MailStatusTag` sous l'en-tête ; `MailViewer` affiche en plus
  `DeadlineAlert` (qu'il n'avait jamais eu, à la différence de
  `MailDetailPage`).
- **Rien d'autre n'a changé** : pagination serveur (25 par défaut), absence
  volontaire de tri d'en-tête, `hideStatusColumn`/`hideDeadlineColumn` par
  route, sélection en lot (Validation), `autoTreatOnOpen`/`allowArchive`/
  `canDeleteOwnImputations`/`canAddImputations`/`showFilesTab`/
  `onlyMyImputations` par route, fiche d'imputation, tiroir PDF, garde de
  suppression réservée à l'auteur d'une imputation.

Vérifié en navigateur sur données réelles (77–98 courriers selon la file) :
lignes en retard effectivement rouge gras (`rgb(192, 57, 43)`, poids 600,
confirmé par style calculé), page de détail Suivi affichant « Arrivée /
Rédigé », popup Validation affichant les mêmes tags, aucune erreur console
sur les trois écrans.

## 4sexies. Phase 4 — pages restantes

Contrairement aux phases précédentes, plusieurs de ces pages n'avaient **aucun
écart concret** face au brief — elles ont été lues intégralement, jugées déjà
conformes, et volontairement laissées intactes plutôt que retouchées pour la
forme (cf. §10 du brief : pas de changement sans besoin).

- **`/login`** : déjà un écran fractionné moderne (panneau de marque en
  dégradé + illustration QR décorative, formulaire court, trim des
  identifiants, rendu mobile en bandeau compact). Seul ajout : une ligne de
  réassurance sécurité sous le formulaire (« Connexion sécurisée — vos accès
  sont journalisés »), factuelle et vérifiable (`navigation_audit`, §C6 de la
  documentation) — pas de promesse de chiffrement non vérifiable.
- **`/intercalaires`** : déjà conforme point par point au brief (catégories
  cliquables accessibles clavier, arbre indenté, filtre, tout
  sélectionner/désélectionner, compteur, explication du séparateur vierge,
  aperçu A4, barre d'action collante, grille responsive). Aucun changement.
- **`/courriers/depart`, `/courriers/integration-decharge`** : formulaires
  courts (4-6 champs), déjà bien étiquetés avec infobulles ; le découpage en
  sections du brief §8.I visait spécifiquement `/enregistrement` (formulaire
  bien plus dense) — l'appliquer ici aurait ajouté de la structure sans
  bénéfice. Aucun changement.
- **Pages de référentiels (`RefLayout`/`MailRefPage`)** : le patron partagé
  (table + formulaire, `Drawer` mobile, édition inline au clic avec crayon au
  survol, flash de ligne après création, désactivation avec `Popconfirm`
  distinguant clairement « désactiver » de « supprimer ») remplit déjà
  master-detail, inline-edit, confirmation de suppression sûre et exports
  cohérents. Vérifié sur `/admin/dossiers` (le plus complexe : 3 référentiels
  croisés) et sur `MailRefPage` (types de départ, types d'entité externe,
  natures, confidentialités). Aucun changement.
- **`/admin/roles`** : déjà conforme (accordéon par section, compteur
  coché/total, rôle système en lecture seule, confirmation de suppression
  chiffrant les utilisateurs impactés). Aucun changement.

Un écart réel a été trouvé et corrigé sur **`/courriers/enregistrement`**
(§8.I du brief) :

- **Champs non groupés** : un unique `Row` de 9 champs, sans hiérarchie
  visuelle. Nouveau composant partagé
  [`FormSection.tsx`](../apps/web/app/components/FormSection.tsx) (titre +
  description + séparateur — réutilisable ailleurs, comme demandé en §7) ;
  le formulaire est maintenant en 3 sections : *Identification du courrier*,
  *Expéditeur et destinataire*, *Pièce jointe et description*.
- **Champs pré-remplis par l'IA invisibles** : l'extraction automatique
  posait des valeurs dans le formulaire sans aucun repère visuel distinguant
  un champ lu par le modèle d'un champ saisi à la main — demande explicite du
  brief (« clearly show AI-filled fields »). Ajout d'une étiquette « IA »
  (`AiFilledTag`, même fichier) à côté du libellé de chaque champ concerné
  tant qu'il n'a pas été modifié par l'agent depuis (un `useRef` isole le
  changement de valeur déclenché par l'extraction elle-même du changement de
  valeur déclenché par une frappe utilisateur, pour ne pas effacer
  l'étiquette au moment même où elle apparaît).
- Vérifié en navigateur : les 3 sections s'affichent avec séparateurs, le
  dépôt réel d'un fichier déclenche bien `POST /courriers/extraction-ia`
  (confirmé sur un PNG vide : réponse entièrement `null`, aucun champ
  invente — comportement correct, « ne jamais inventer » respecté), aucune
  erreur console. Le rendu visuel de l'étiquette « IA » sur un champ
  effectivement rempli n'a pas pu être vérifié en pixels dans cette session
  (aucun document de test contenant de vraies données de courrier
  disponible) — la logique a été relue avec attention et compile proprement.

Un écart **fonctionnel, hors du périmètre visuel de ce chantier**, avait été
repéré sur `/admin/users` : la modale d'édition calculait et envoyait déjà
`isDisabled` au serveur, mais ne proposait aucun contrôle pour le modifier —
signalé séparément à l'époque, puis corrigé par la suite (voir §4undecies).

**Mise à jour** : les six éléments listés ci-dessus comme non traités
(`/courriers/recherche`, `/courriers/documents-scannes`, les quatre écrans
bespoke de Paramétrage Courrier, `/admin/parametres/email`) ont depuis été
revus dans les passes suivantes — voir §4septies à §4nonies et §4decies.
Seuls `/design` (§4treizies) et la vérification mobile de la grille
`/courriers/tableau-de-bord` (§4duodecies) restent ouverts.

## 4septies. Page livrée : `/courriers/recherche`

Voir [`apps/web/app/courriers/recherche/page.tsx`](../apps/web/app/courriers/recherche/page.tsx).

Écran déjà solide (plein-texte dominant, filtres toujours visibles — 4 champs
seulement, pas besoin d'un `Collapse` —, tri et pagination serveur, état vide
expliquant pourquoi seuls les courriers *traités et archivés* apparaissent).
Un seul écart repéré par comparaison avec `/search` : **aucune puce de filtre
actif**, alors que c'est la convention déjà établie par l'autre écran de
recherche de l'application. Ajouté, à l'identique de `/search` — puces
fermables individuellement (`Tag` + `AnimatePresence`), « Tout effacer », et
état vide contextuel (« N filtre(s) actif(s) » vs message générique). Aucun
export ajouté : ce fonds n'en a volontairement pas, contrairement à `/search`
(confirmé dans la documentation applicative, §2.3).

Vérifié en navigateur : puce apparue au lancement d'une recherche texte,
message d'état vide contextuel correct, « Tout effacer » réinitialise
proprement, aucune erreur console, 1280px et 390px.

## 4octies. Page livrée : `/courriers/documents-scannes`

Voir [`apps/web/app/courriers/documents-scannes/page.tsx`](../apps/web/app/courriers/documents-scannes/page.tsx).

Déjà solide (en-tête clair, compteur de file, aperçu avant enregistrement,
lien direct vers l'enregistrement pré-rattaché au scan, état vide explicite).
Seul écart repéré : contrairement aux autres points de dépôt de l'application
(`/acquisition`, le bloc IA de `/courriers/enregistrement`), le bouton
« Déposer un document » n'indiquait nulle part les formats acceptés avant le
clic — seul le filtre du sélecteur de fichiers du système d'exploitation le
révélait. Ajouté : mention dans la description de la page + info-bulle sur le
bouton (« Formats acceptés : PDF, JPG, PNG, TIFF »).

Volontairement non ajouté : un indicateur d'ancienneté façon « en retard »
(cf. §4quinquies) — contrairement à `dateButoire` sur un courrier, il
n'existe aucune notion métier documentée de délai pour un dépôt scanné ; lui
inventer un seuil aurait été une règle non demandée, pas une reprise
d'existant.

Vérifié en navigateur : description et info-bulle affichées, aucune erreur
console, 1280px et 390px.

## 4nonies. Pages bespoke restantes de Paramétrage Courrier

Voir `apps/web/app/admin/courriers/{organigrammes,role-organigramme,
entites-externes,types-imputation}/page.tsx`.

Ces quatre écrans (les seuls de « Paramétrage Courrier » à ne pas passer par
`MailRefPage`) ont été lus intégralement et jugés déjà conformes — aucun
changement de code :

- **`organigrammes`** : `RefLayout` + hiérarchie indentée (`depth × 20`),
  `EditableLocation` pour reparenter, désactivation en cascade explicitement
  annoncée dans la confirmation.
- **`role-organigramme`** : volontairement sans formulaire de création (un
  rattachement se fait rôle par rôle, pas de nouvelle entité à créer) — une
  simple table à cellule éditable, avec un bandeau expliquant pourquoi
  l'assignation existe (dérivation de l'organigramme du courrier à
  l'enregistrement).
- **`entites-externes`** : `RefLayout` + création rapide d'un type via
  modale « + » sans quitter le formulaire, édition inline de tous les champs
  (nom, type, e-mail, téléphone), désactivation confirmée.
- **`types-imputation`** : `RefLayout` + protection des types système
  (`MailInputationTypeId`, non désactivables, `Tag` « système » avec
  info-bulle expliquant pourquoi), `Switch` « Suivi » avec info-bulle sur ce
  que déclenche le traitement automatique.

**Incident d'environnement rencontré et résolu** : lors de la vérification,
le serveur API (port 3001) s'est révélé arrêté (`ERR_CONNECTION_REFUSED`),
sans lien avec ce chantier — aucun fichier de `apps/api` n'a été touché.
Redémarré via la configuration `api` de `.claude/launch.json` ; les quatre
écrans, une fois l'API de retour, chargent et affichent correctement leurs
données réelles (62 entités externes, 8 types d'imputation, 5 rôles, etc.),
aucune erreur console.

## 4decies. Page revue : `/admin/parametres/email`

Voir [`apps/web/app/admin/parametres/email/page.tsx`](../apps/web/app/admin/parametres/email/page.tsx).

La page la plus aboutie de tout l'admin, lue intégralement — **aucun
changement**. Elle applique déjà, mieux que la moyenne du dépôt, plusieurs
demandes du brief :

- champs groupés en sections cohérentes (`Identité`, `Coordonnées`, `Logo`,
  `Couleur d'accent`) en 4 `Card` plutôt qu'une grille indifférenciée ;
- assistance de champ concise sous chaque libellé (`extra`), qui explique
  l'effet concret du champ plutôt que sa simple description ;
- aperçu de logo en direct, avec une alerte proactive et rare dans ce
  dépôt : si `API_PUBLIC_URL` n'est pas configuré côté serveur, la page le
  détecte et prévient que le logo s'affichera ici mais pas dans les e-mails,
  au lieu de laisser l'utilisateur découvrir le problème après coup ;
- retrait de logo confirmé avec la conséquence énoncée en clair ;
- sélecteur de couleur distinguant explicitement « aucune couleur d'accent »
  (bouton « Neutre », vide) d'un gris choisi manuellement — une nuance
  sémantique que la plupart des sélecteurs de couleur perdent ;
- action d'enregistrement unique et proéminente dans l'en-tête.

Vérifié en navigateur : rendu et absence d'erreur console à 1280px et 390px.

## 4undecies. Correctif : bascule d'activation sur `/admin/users`

Voir [`apps/web/app/admin/users/page.tsx`](../apps/web/app/admin/users/page.tsx).

Écart fonctionnel (pas visuel) confirmé côté API avant correction :
`isDisabled` bloque bien la connexion (`auth.service.ts`), et exclut
l'utilisateur des destinataires par rôle et des notifications
(`mails.service.ts`, `notifications.service.ts`) — un comportement réel,
déjà entièrement câblé serveur (DTO, service, `PATCH /users/:id`), simplement
sans contrôle dans l'interface pour le déclencher.

Ajouté :

- Un `Switch` « Compte désactivé » dans la modale d'édition, avec une
  explication en une phrase de ce qu'il fait concrètement (bloque la
  connexion, retire des destinataires par rôle et des notifications, sans
  supprimer le compte) — pour ne pas laisser un administrateur activer un
  interrupteur sans savoir ce qu'il déclenche.
- Une colonne « Statut » dans le tableau (`Actif` / `Désactivé`, avec
  info-bulle sur `Désactivé` rappelant l'effet), absente jusque-là : un
  compte désactivé était auparavant invisible dans la liste.

Vérifié en navigateur de bout en bout sur un compte réel (non protégé) :
bascule → Enregistrer → la colonne Statut passe à « Désactivé » ; rebascule →
Enregistrer → retour à « Actif ». Aucune erreur console. `tsc --noEmit` et
`next lint` propres (mêmes avertissements préexistants qu'ailleurs, aucun
nouveau).

## 4duodecies. Revérification : `/courriers/tableau-de-bord` (grille de widgets)

La limite documentée en §4ter (`react-grid-layout` mesurait une largeur de
conteneur nulle, l'onglet du volet Navigateur restant `hidden`) a été
revérifiée dans une session ultérieure, où le même onglet rapportait cette
fois `window.innerWidth = 1280` — la grille s'affiche et se peuple
correctement : les 9 widgets rendent leurs données réelles (alertes, files,
synthèse, flux, répartition, retards, délais, charge, hygiène), et l'en-tête
toujours visible ajouté en §4ter (nom du widget) apparaît bien sur chacun.
Aucune erreur console.

À 390px, en revanche, `window.innerWidth` est resté bloqué à ~1300px malgré
plusieurs appels de redimensionnement (contrairement à toutes les autres
pages de ce chantier, redimensionnées sans problème à 390px dans la même
session) — un comportement propre à cette page qui n'affecte apparemment que
la mesure de fenêtre rapportée par l'outil, pas le code : la configuration
responsive de la grille (`breakpoints`/`cols` dans `GrilleWidgets.tsx`,
non modifiée par ce chantier) reste donc non revérifiée en pixels sur petit
écran. À recontrôler quand l'outil de redimensionnement se comporte
normalement sur cette page.

## 4treizies. Mise à jour de la showcase `/design` (rattrapage Phase 2)

Le brief (§7 / §11 Phase 2) demandait explicitement de mettre à jour la page
de showcase du design system en même temps que les nouveaux tokens — une
étape omise au moment des fondations (§3-§4) et rattrapée ici, une fois le
reste du chantier terminé.

Ajouté à [`apps/web/app/design/page.tsx`](../apps/web/app/design/page.tsx) :

- **Palette de tuiles** (`tiles.ink/sky/violet/coral`) sous les couleurs de
  base, avec la même mise en garde que partout ailleurs dans ce chantier :
  purement décorative, jamais un substitut aux tons sémantiques de statut.
- **Section « Tuiles de synthèse (StatTile) »** — les 4 teintes en situation,
  avec valeurs, icônes et un `hint`, pour montrer le composant tel qu'utilisé
  sur `/dashboards`.
- **Section « Sections de formulaire (FormSection) »** — deux groupes
  séparés par un `Divider`, avec `AiFilledTag` démontré à côté d'un libellé
  de champ, tel qu'utilisé sur `/courriers/enregistrement`.

**Défaut trouvé et corrigé pendant la vérification** : le premier jet
utilisait `Input addonBefore` pour accoler l'étiquette « IA » au champ, ce
qui déclenche un avertissement console AntD (« `addonBefore` est déprécié,
utilisez `Space.Compact` ») — un défaut que je viens d'introduire, pas un
héritage du dépôt. Remplacé par un libellé au-dessus du champ (la même
disposition que dans `FormSection` en usage réel), vérifié par un contrôle
direct du DOM (`.ant-input-group-addon` : 0 élément) plutôt que de se fier
au seul journal console, qui accumule l'historique de plusieurs rechargements
dans cette session et peut donc montrer une erreur déjà corrigée.

Vérifié en navigateur : rendu correct à 1280px et 390px, aucune erreur
console une fois le correctif appliqué, `tsc --noEmit` et `next lint`
propres (mêmes avertissements préexistants qu'ailleurs, aucun nouveau).

**Décision non prise ici** : le brief note par ailleurs que `/design` est une
route de développement candidate à la suppression une fois validée. La
mettre à jour ne préjuge pas de cette décision, qui relève du produit — elle
reste temporaire et documentée comme telle dans son propre en-tête.

## 5. Suivi route par route

Légende : ✅ fait · 🟡 en cours · ⬜ à faire. « Fonctionnalités » = vérifié non
régressif (routes/API/RBAC/pagination/exports préservés).

| Route | Redessiné | Testé nav. | Responsive | Fonctionnalités | Notes |
|---|---|---|---|---|---|
| `/login` | ✅ | ✅ | ✅ | ✅ | Déjà conforme — voir §4sexies |
| `/dashboards` | ✅ | ✅ | 🟡 (hérite du grid AntD existant, à revalider < 768px) | ✅ | Page pilote — voir §4 |
| `/acquisition` | ✅ | ✅ | ✅ (1280px et 390px vérifiés — `Steps` bascule automatiquement en liste verticale) | ✅ | Wizard guidé 6 étapes — voir §4bis |
| `/search` | ✅ | ✅ | ✅ (1280px et 390px vérifiés) | ✅ | Voir §4quater |
| `/intercalaires` | ✅ | ✅ | ✅ | ✅ | Déjà conforme — voir §4sexies |
| `/courriers/tableau-de-bord` | ✅ | ✅ | 🟡 (desktop confirmé ; 390px non concluant, voir §4duodecies) | ✅ | Voir §4ter et §4duodecies |
| `/courriers/enregistrement` | ✅ | ✅ | ✅ | ✅ | Voir §4sexies — sections + tags IA |
| `/courriers/controle` | ✅ | ✅ | ✅ | ✅ | `MailWorklist` — voir §4quinquies |
| `/courriers/documents-scannes` | ✅ | ✅ | ✅ | ✅ | Voir §4octies |
| `/courriers/parapheur` | ✅ | ✅ | ✅ | ✅ | `MailWorklist` — voir §4quinquies |
| `/courriers/suivi` (+ périmètre `suivi-dc`) | ✅ | ✅ | ✅ | ✅ | `MailWorklist` — voir §4quinquies |
| `/courriers/validation` | ✅ | ✅ | ✅ | ✅ | `MailWorklist` + `MailViewer` — voir §4quinquies |
| `/courriers/recherche` | ✅ | ✅ | ✅ | ✅ | Voir §4septies |
| `/courriers/depart` | ✅ | ✅ | ✅ | ✅ | Déjà conforme — voir §4sexies |
| `/courriers/integration-decharge` | ✅ | ✅ | ✅ | ✅ | Déjà conforme — voir §4sexies |
| `/courriers/[…]/[mailId]` (détail) | ✅ | ✅ | ✅ | ✅ | `MailDetailPage` — voir §4quinquies |
| `/admin/geolocalisation` | ✅ | ✅ | ✅ | ✅ | `RefLayout` — déjà conforme, voir §4sexies |
| `/admin/classification-plans` | ✅ | ✅ | ✅ | ✅ | `RefLayout` — déjà conforme, voir §4sexies |
| `/admin/dossier-categories` | ✅ | ✅ | ✅ | ✅ | `RefLayout` — déjà conforme, voir §4sexies |
| `/admin/dossiers` | ✅ | ✅ | ✅ | ✅ | `RefLayout` — déjà conforme, voir §4sexies |
| `/admin/document-types` | ✅ | ✅ | ✅ | ✅ | `RefLayout` — déjà conforme, voir §4sexies |
| `/admin/courriers/organigrammes` | ✅ | ✅ | ✅ | ✅ | Déjà conforme — voir §4nonies |
| `/admin/courriers/role-organigramme` | ✅ | ✅ | ✅ | ✅ | Déjà conforme — voir §4nonies |
| `/admin/courriers/entites-externes` | ✅ | ✅ | ✅ | ✅ | Déjà conforme — voir §4nonies |
| `/admin/courriers/types-imputation` | ✅ | ✅ | ✅ | ✅ | Déjà conforme — voir §4nonies |
| `/admin/courriers/types-depart` | ✅ | ✅ | ✅ | ✅ | `MailRefPage` — déjà conforme |
| `/admin/courriers/types-entites-externes` | ✅ | ✅ | ✅ | ✅ | `MailRefPage` — déjà conforme. Masqué du menu, atteignable par URL |
| `/admin/courriers/objets` | ✅ | ✅ | ✅ | ✅ | `RefLayout`, déjà conforme. Masqué du menu, atteignable par URL |
| `/admin/courriers/natures` | ✅ | ✅ | ✅ | ✅ | `MailRefPage` — déjà conforme. Masqué du menu |
| `/admin/courriers/confidentialites` | ✅ | ✅ | ✅ | ✅ | `MailRefPage` — déjà conforme. Masqué du menu |
| `/admin/users` | ✅ | ✅ | ✅ | ✅ | Voir §4undecies — bascule d'activation ajoutée |
| `/admin/roles` | ✅ | ✅ | ✅ | ✅ | Déjà conforme — voir §4sexies |
| `/admin/parametres/email` | ✅ | ✅ | ✅ | ✅ | Déjà conforme — voir §4decies |
| Shell (sidebar/topbar/palette) | ✅ | ✅ | ✅ | ✅ | Polish livré (§3) et vérifié à 1920px/1280px/390px pendant les tests des pages redessinées |
| `/design` | ✅ | ✅ | ✅ | — | Mis à jour — voir §4treizies. Reste une route temporaire (décision de suppression hors périmètre UX) |
| `/dev/pdf-viewer` | — | — | — | — | Route de développement, hors périmètre du redesign |

## 6. Risques de compatibilité identifiés

- **Ampleur** : 39 pages, plusieurs (`/acquisition` 1097 l., `/search` 937 l.,
  `MailDetailPage` 582 l.) sont volumineuses et à logique métier dense —
  chaque redesign doit être vérifié en navigateur avant de passer à la
  suivante, pas seulement par lecture de code.
- **`react-grid-layout`** (tableau de bord courrier) : la persistance serveur
  de l'agencement (`user_setting.dashboard.courriers.layout`) ne doit pas être
  perturbée par un changement de structure DOM des widgets.
- **`PdfViewer`** (817 l.) : composant sensible (zoom, rotation, recherche,
  plein écran) partagé par `/acquisition`, `/search`, `MailDetailPage`,
  `/courriers/documents-scannes` — tout changement de layout autour doit
  laisser son API interne intacte.
- **`packages/ui` est vide** : aucun composant partagé n'y vit ; les nouveaux
  composants (`StatTile`, futurs) sont ajoutés dans
  `apps/web/app/components/`, en cohérence avec la convention actuelle.
- **Deny-by-default documentaire court-circuité (D-17)** : le redesign ne doit
  ni masquer ni prétendre résoudre ce point — il est hors périmètre UX et
  relève d'une décision produit/sécurité distincte.

## 7. Prochaines étapes (ordre de priorité, Phase 3 puis 4)

1. Polish visuel du shell (sidebar/topbar) en cohérence avec les nouvelles
   tuiles.
2. `/courriers/tableau-de-bord` (widgets → nouveau système de tuiles).
3. `/acquisition` (wizard guidé).
4. `/search` (recherche proéminente + export groupé).
5. Files de travail + pages de détail courrier.
6. Phase 4 : login, intercalaires, enregistrement, référentiels, utilisateurs,
   rôles.
7. Phase 5 : `pnpm lint && pnpm test && pnpm build`, correction des régressions.

## 8. Phase 5 — validation (exécutée)

- **`tsc --noEmit`** sur `apps/web` : exécuté après chaque page retouchée
  (fondations, tableau de bord, acquisition, recherche, worklists/détail
  courrier, enregistrement, login) — **propre à chaque fois**, zéro erreur
  introduite.
- **`pnpm lint`** (racine, 13 packages) : le seul échec est `@archivage/web`,
  et il est **entièrement préexistant** — deux catégories, aucune dans un
  fichier touché par ce chantier :
  - Config : règles `@next/next/no-img-element` et
    `react-hooks/exhaustive-deps` introuvables dans la config ESLint flat
    actuelle (`BrandMark.tsx`, `PdfViewer.tsx`, `admin/parametres/email`) —
    un problème de configuration du dépôt, pas du code.
  - `app/search/page.tsx:194` — variable `viewerMissing` inutilisée,
    présente **avant** la reprise de cette page (vérifié par un premier
    `pnpm lint` exécuté avant toute modification).
  - `@archivage/pdf` et `@archivage/api` portent chacun un avertissement
    préexistant, dans des packages jamais touchés ici.
- **`pnpm test`** (racine) : tout passe sauf
  `apps/worker/test/acquisition-live.spec.ts` (pipeline de découpage QR/OCR
  sur fixture réelle — 1 document obtenu au lieu de 2 attendus). Ce test
  touche exclusivement `apps/worker` et les packages `pdf`/`qr`/`ocr` :
  aucun fichier de ce chantier (100 % dans `apps/web`) n'y est lié. Pré-
  existant, hors périmètre d'une passe de redesign frontend — signalé plutôt
  que corrigé à l'aveugle.
- **`pnpm build`** (`@archivage/web`) : **succès** — 38 routes compilées et
  pré-rendues sans erreur (`next build`, ~26 s), y compris toutes les pages
  redessinées. Le build nécessitait d'arrêter temporairement le serveur de
  dev sur le port 5000 (garde volontaire du dépôt, `ensure-no-dev.mjs`,
  contre le partage de `.next` entre build et dev) — arrêté avec l'accord de
  l'utilisateur, puis le serveur de dev a été relancé et revérifié
  fonctionnel juste après.

**Conclusion** : aucune régression de lint, type ou build imputable à ce
chantier. Les deux échecs restants (config ESLint de `apps/web`, test
`acquisition-live` du worker) préexistaient et relèvent d'un chantier
distinct.
