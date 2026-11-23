# Scénarios E2E : GED (lot 3)

Module GED : espaces documentaires, éditeur collaboratif, fiche document (versions, cachet serveur,
droits), recherche IA, gouvernance, connecteurs et réglages IA.

Conventions :
- Identifiants : GED-01 à GED-05 parcours de bout en bout ; GED-10 à GED-19 espaces ; GED-20 à GED-29
  fiche document, versions, cachet, droits ; GED-30 à GED-39 éditeur et rédaction ; GED-40 à GED-44
  recherche IA ; GED-45 à GED-49 gouvernance ; GED-50 à GED-59 connecteurs et réglages IA.
- Priorités : P1 critique, P2 important, P3 confort. La colonne Spec est relative à `apps/e2e`.
- Chaque test Playwright porte l'identifiant de son scénario dans son titre ; un identifiant peut
  couvrir plusieurs tests (nominal, erreurs de saisie, refus).
- Aucun fournisseur IA ni OAuth réel : la pile E2E tourne IA désactivée et sans identifiants
  d'application OAuth ; ces fonctions sont testées par leurs états « non configuré » et leurs refus
  propres, et par ce qui marche sans IA (repli plein texte, tableau de bord, modèles de rédaction).
- Chaque test crée ses données par l'API avec `uniq()` ; les utilisateurs restreints sont créés par
  `tests/ged/_helpers/users.ts` (rôle portant les seules clés de menu voulues) et, quand un profil
  (compte-groupe) est nécessaire, par les aides `createActorUser`, `createSpaceUser`, `createEditorUser`.

## Parcours de bout en bout et espaces documentaires


Règle codée rappelée pour la lecture des scénarios : une publication d'espace se lit SANS appartenance mais AVEC une session et le menu « Espaces » (`spaces.controller.ts:38-51`, docs/ged-espaces.md §4.2). Aucune route anonyme n'existe : le « public » d'une publication est l'ensemble des utilisateurs authentifiés porteurs du menu.

### Parcours GED

| Id | Scénario | Préconditions | Étapes | Résultat attendu | Priorité | Spec |
| --- | --- | --- | --- | --- | --- | --- |
| GED-01 | Parcours complet : espace, document de l'éditeur, version, cachet, publication, lecture, dépublication | Administrateur connecté ; pile sans clé IA ; coffre ARCHIVES inscriptible (clé de scellement créée au premier usage) | 1. `/espaces` → « Nouvel espace » (Partagé). 2. « Nouveau document » → `/editeur/nouveau?spaceId=` (espace présélectionné) → titre → « Créer le document ». 3. Saisir du texte (WebSocket collab), attendre « Connecté · Enregistré ». 4. « Enregistrer une version » avec résumé. 5. « Retour à la fiche » → onglet « Versions ». 6. Onglet « Sécurité et conformité » → « Vérifier maintenant » → « Apposer le cachet ». 7. Détail de l'espace : onglet « Documents (1) ». 8. « Publier » avec un slug. 9a. Contexte anonyme sur `/espaces/publie/<slug>`. 9b. Utilisateur authentifié non membre (menu « Espaces ») sur la même adresse. 10. « Dépublier » puis relire l'adresse | Version 2 créée (« Version 2 enregistrée. »), versions `[2, 1]` par l'API, instantané `.html` de la v2 contenant le texte ; fiche : « Version 2 » courante et « Version 1 » ; « Cachet apposé. », « Scellé et intact », `GET /documents/:id/seal` = scellé, clé connue, signature valide ; document listé dans l'espace ; anonyme : 401 API et renvoi vers `/login`, rien de l'espace affiché ; lecteur authentifié : titre et document visibles, aucune action ; après dépublication : « Cet espace n'existe pas ou n'est plus publié. », 404 API | P1 | tests/ged/parcours/parcours-ged.spec.ts |
| GED-02 | Fonctions IA sans service configuré | Pile sans clé IA ; document de l'éditeur créé par l'API | `POST /governance/analyze {documentIds}` ; `POST /semantic-search {query}` ; `POST /semantic-search/ask {question}` | 202, `aiEnabled: false`, message « IA désactivée… », document non validé ignoré (`queued + ignored = 1`) ; recherche et question : 200, `mode: 'fulltext'` (repli plein texte), aucune erreur | P2 | tests/ged/parcours/parcours-ged.spec.ts |
| GED-03 | Un membre « Contribution » crée et édite son document, sans pouvoir le sceller | Espace Collaboration de l'administrateur ; utilisateur avec menu « Espaces » et compte-groupe, membre Contribution | Détail de l'espace (pas de « Modifier » ni « Publier ») → « Nouveau document » → titre → éditeur → saisie → « Enregistrer une version » → fiche, onglet « Sécurité et conformité » | Éditeur en écriture (créateur = niveau Modification), version 2 créée, document listé dans l'espace ; « Niveau Archivistique requis pour apposer un cachet », pas de bouton, `POST /documents/:id/seal` = 403 | P2 | tests/ged/parcours/parcours-ged.spec.ts |
| GED-04 | Un contributeur ne modifie pas le document d'un autre membre (décision Q3 du 2026-11-22) | Espace Collaboration, deux membres Contribution ; document créé par le premier (`POST /collab/documents`, session `write` pour lui) | Le second : session de l'éditeur, `POST` versions, import DOCX, indexation ; ouverture de l'éditeur | Session `read` ; 403 sur version, import et indexation ; versions `[1]` inchangées ; écran « Contenu du document (lecture seule) » non éditable, « Lecture seule », pas de « Enregistrer une version » | P2 | tests/ged/parcours/parcours-ged.spec.ts |

### Liste des espaces (`/espaces`)

| Id | Scénario | Préconditions | Étapes | Résultat attendu | Priorité | Spec |
| --- | --- | --- | --- | --- | --- | --- |
| GED-10 | Liste nominale, recherche, filtre de type, lien vers le détail | Deux espaces de l'administrateur (Partagé avec description, Collaboration) | Rechercher par préfixe ; filtrer « Collaboration » ; rechercher un texte absent ; cliquer un libellé | Lignes avec type, « Non publié », « Propriétaire », description ; le filtre ne garde que la Collaboration ; « Aucun espace ne correspond à ce filtre. » ; le lien ouvre `/espaces/<id>` | P2 | tests/ged/espaces/liste.spec.ts |
| GED-11 | Liste vide | Utilisateur avec menu « Espaces », sans aucun espace | Ouvrir `/espaces` ; « Nouvel espace » de l'état vide | `GET /spaces` = `[]` ; « Aucun espace pour l'instant : créez-en un pour regrouper des documents. » ; deux boutons de création ; la modale « Nouvel espace » s'ouvre | P2 | tests/ged/espaces/liste.spec.ts |

### Création, modification, suppression

| Id | Scénario | Préconditions | Étapes | Résultat attendu | Priorité | Spec |
| --- | --- | --- | --- | --- | --- | --- |
| GED-12 | Cycle de vie d'un espace par l'interface | Administrateur | « Nouvel espace » → libellé, description, type Collaboration (aide affichée) → « Créer l'espace » ; « Modifier » → nouveau libellé → « Enregistrer » ; « Supprimer » → confirmer | POST 201, « Espace créé », détail : type, « Propriétaire », « Non publié », description ; « Espace modifié », titre et API à jour ; confirmation « Les documents rattachés ne sont pas supprimés. », « Espace supprimé », retour à `/espaces`, `GET /spaces/:id` = 404 | P1 | tests/ged/espaces/creation.spec.ts |
| GED-13 | Erreurs de saisie | Administrateur | Écran : « Créer l'espace » sans libellé puis avec des espaces seuls, puis « Annuler ». API : libellé vide/blanc/201 caractères, nature 3, nature 7, nature absente, champ inconnu (`publicationSlug`) ; `PATCH` vide | « Saisissez un libellé », aucune requête POST ; API 400 à chaque cas, rien créé ; `PATCH {}` = 400 « Aucune modification fournie » | P2 | tests/ged/espaces/creation.spec.ts |

### Détail : membres et documents

| Id | Scénario | Préconditions | Étapes | Résultat attendu | Priorité | Spec |
| --- | --- | --- | --- | --- | --- | --- |
| GED-14 | Membres : ajout, changement de droit, retrait | Espace Partagé de l'administrateur ; utilisateur avec compte-groupe | Onglet « Membres » → « Un utilisateur » → choisir → droit Lecture → « Ajouter » ; changer le droit en Gestion ; « Retirer » + confirmer. Variante : espace Privé | Avant : 404 pour lui ; « Membre ajouté », ligne « Utilisateur », droit Lecture, `myAccess = 0` ; doublon = 409 ; « Droit modifié », `myAccess = 2`, `canManage` ; « Membre retiré », 404 de nouveau. Privé : « Un espace privé est réservé à son propriétaire. », pas de formulaire, API 400 | P1 | tests/ged/espaces/membres.spec.ts |
| GED-15 | Documents : rattacher puis détacher | Document de l'éditeur dans un espace source, validé (archivé) ; espace cible vide | « Rattacher un document » → rechercher le libellé → choisir → « Rattacher » ; « Détacher » + confirmer. Variante : document non validé | « Document rattaché », « Documents (1) », lien vers la fiche, compte 1 ; second rattachement 409, document inexistant 404 ; « Document détaché », « Aucun document dans cet espace. », document intact et toujours dans l'espace source. Variante non validée (décision Q4 : seuls les documents archivés se rattachent) : API 409 « Seuls les documents archivés (validés) peuvent être rattachés à un espace », rien rattaché ; la modale ne le propose pas, « Rattacher » reste désactivé ; une fois validé, rattachement 201 (ANO-GED-12, corrigée) | P1 | tests/ged/espaces/documents.spec.ts |

### Publication

| Id | Scénario | Préconditions | Étapes | Résultat attendu | Priorité | Spec |
| --- | --- | --- | --- | --- | --- | --- |
| GED-16 | Publier, lire en non-membre authentifié, dépublier | Espace Partagé avec un document ; lecteur avec menu « Espaces », non membre | « Publier » → slug → « Publier » ; lecteur : `/espaces/publie/<slug>` ; propriétaire : « Dépublier » + confirmer ; lecteur recharge ; autre espace publié avec le même slug | « Espace publié », bandeau avec le lien, type Publication ; lecteur : `myAccess null`, PATCH et rattachement 403, publication absente de SA liste, titre, description, « Publié le », document visible, aucune action ; « Espace dépublié », type Partagé ; lecteur : « Cet espace n'existe pas ou n'est plus publié. », 404 par slug et par id ; slug réutilisable | P1 | tests/ged/espaces/publication.spec.ts |
| GED-17 | Erreurs de publication | Espaces de l'administrateur | Publier un espace Privé ; slug déjà pris ; slugs invalides par l'API (majuscules, < 3, `a--b`, tirets en bord, accent, > 120) ; slug invalide saisi à l'écran ; publication sans slug de deux espaces de même libellé | 409 « Un espace privé ne peut pas être publié… » affiché, modale ouverte, rien publié ; 409 « Ce slug est déjà utilisé… » ; 400 « Slug attendu : minuscules, chiffres et tirets » ; à l'écran le message doit être lisible (`test.fixme` « lot transverse : ANO-GED-09 » : l'écran affiche « HTTP 400 », `apps/web/app/lib/api.ts` n'exploite pas un `message` en tableau) ; slug dérivé du libellé (accents retirés), puis suffixe `-2` | P2 | tests/ged/espaces/publication.spec.ts |
| GED-18 | Lecture publique refusée : slug inconnu, jamais publié, mal formé, visiteur anonyme | Une publication active pour le cas anonyme | `/espaces/publie/<inconnu>` ; adresse dérivée du libellé d'un espace non publié ; `/espaces/publie/-mauvaise` ; `/espaces/publie/Mauvais_Slug` ; contexte sans session sur une publication active | 404 « Publication introuvable » et « Cet espace n'existe pas ou n'est plus publié. » ; adresse mal formée : « L'adresse de l'espace publié est invalide. » sans appel API ; anonyme : 401 sur `/api/spaces/published/:slug` et `/api/spaces/:id/documents`, renvoi vers `/login`, ni l'espace ni son document affichés | P1 | tests/ged/espaces/lecture-publique.spec.ts |

### Refus

| Id | Scénario | Préconditions | Étapes | Résultat attendu | Priorité | Spec |
| --- | --- | --- | --- | --- | --- | --- |
| GED-19 | Refus : sans menu, membre Lecture, non-membre | (a) utilisateur sans menu « Espaces » ; (b) membre Lecture d'un espace Collaboration avec document ; (c) utilisateur avec menu, non membre ; espaces Partagé et Privé d'autrui | (a) API `GET/POST /spaces`, détail, publication, candidats ; écrans liste, détail, publication. (b) API d'écriture ; écran détail, onglet « Membres », liste, `/editeur/nouveau`. (c) API lecture/écriture ; écrans liste et détail ; administrateur sur les espaces d'autrui | (a) 403 partout ; « Vous n'avez pas accès à cette section. », « La liste des espaces n'a pas pu être chargée. », aucun « Nouvel espace » ; détail : « Cet espace est introuvable ou inaccessible. ». (b) 403 avec le droit manquant (gestion, propriétaire, contribution) ; « Mon droit : Lecture », aucune action, pas de « Détacher », membres réservés, espace « (lecture seule) » non sélectionnable à la création. (c) 404 « Espace introuvable » (lecture comme écriture), espace absent de la liste ; administrateur : privé d'autrui 404, partagé d'autrui en lecture seule (`myAccess null`, PATCH 403) | P1 | tests/ged/espaces/refus.spec.ts |

## Fiche document, versions, cachet serveur et droits


Données de test : chaque scénario crée son document PDF par l'API (`tests/ged/_helpers/documents.ts`,
`createPdfDocument`) : dépôt d'un PDF dans la file « Documents scannés », puis courrier Départ qui le
promeut en document GED (version 1, empreinte SHA-256 posée, binaire au coffre). Les utilisateurs de test
sont créés par `createRestrictedUser` / `createActorUser` (compte-acteur nécessaire pour recevoir un droit).

### Fiche document (`/documents/:id`)

| Id | Scénario | Préconditions | Étapes | Résultat attendu | Priorité | Spec |
|---|---|---|---|---|---|---|
| GED-20 | Consulter la fiche d'un document | Document PDF créé par l'API ; administrateur connecté | Ouvrir `/documents/:id` ; vérifier en-tête, badge de droits, onglets, onglet Information ; « Visualiser le document » ; onglet Historique | Titre « Document #id », « Vos droits : Archivistique », 8 onglets (Information, Indexation, Cycle de vie, Accès par utilisateur, Accès par profil, Sécurité et conformité, Versions, Historique) ; libellé affiché ; « Ce document n'a pas de type » ; le binaire courant est servi (200) dans le tiroir « Aperçu du document » ; l'historique montre « Consultation du document » | P1 | `tests/ged/documents/fiche.spec.ts` |
| GED-21 | Identifiant de document inexistant ou invalide | Aucun document 999999999 | API `GET /documents/999999999` et ses onglets ; `GET /documents/abc` ; `GET /documents/99999999999` ; écran `/documents/999999999` puis `/documents/abc`, « Retour à la recherche » | 404 « Document introuvable » (fiche, versions, droits, cachet, intégrité, historique, cycle de vie) ; 400 pour `abc` ; refus propre (400/404, pas 500) hors bornes INT4 (test séparé en `test.fixme` « lot transverse : ANO-GED-07 » : 500 constaté) ; écran « Document introuvable » sans onglet ni erreur JS ; retour sur `/search` | P2 | `tests/ged/documents/fiche.spec.ts` |

### Onglet « Versions »

| Id | Scénario | Préconditions | Étapes | Résultat attendu | Priorité | Spec |
|---|---|---|---|---|---|---|
| GED-22 | Lister les versions et déposer une nouvelle version | Document PDF v1 | Onglet Versions ; « Nouvelle version » ; joindre un PDF, saisir un résumé ; « Créer la version » | v1 « Courante » « Création » ; bouton de création désactivé sans fichier ; message « Version 2 créée » ; v2 « Courante » « Modification » avec le résumé, v1 n'est plus courante ; empreintes distinctes ; dépôt tracé au journal | P1 | `tests/ged/documents/versions.spec.ts` |
| GED-22 | Erreurs de dépôt d'une version | Document PDF v1 | API : redéposer le même PDF ; déposer un faux PDF ; corps sans fichier ; document inconnu ; écran : redéposer le même PDF | 409 « Contenu identique à la version courante » ; 400 « Seuls les fichiers PDF sont acceptés » ; 400 « Aucun fichier reçu (ou fichier vide) » ; 404 ; aucune version ajoutée ; à l'écran, message d'erreur lisible et modale restée ouverte | P2 | `tests/ged/documents/versions.spec.ts` |
| GED-23 | Restaurer une version antérieure | Document avec v1 et v2 (v2 courante) | Onglet Versions ; « Restaurer » sur la v1 ; confirmer | Pas de bouton Restaurer sur la courante ; confirmation « Restaurer la version 1 ? » ; message « Version 1 restaurée en version 3 » ; v3 « Courante », « Restauration », « Restaurée depuis la v1 » ; 3 versions conservées ; contenu de la v3 identique octet pour octet à la v1 | P1 | `tests/ged/documents/versions.spec.ts` |
| GED-23 | Erreurs de restauration | Deux documents A et B | API : restaurer la version courante ; une version inconnue ; une version du document B sous A ; corps avec un champ inconnu | 409 « Cette version est déjà la version courante » ; 404 « Version introuvable » ; 404 ; 400 (schéma strict) sans nouvelle version | P2 | `tests/ged/documents/versions.spec.ts` |
| GED-24 | Télécharger le contenu d'une version | Document avec v1 et v2 de contenus connus | API : contenu de v1 et de v2 ; fichier de v1 sous v2, fichier inconnu, document inconnu ; écran : « Ouvrir » sur la v1 | 200, `application/pdf`, `inline`, octets identiques au dépôt (versions immuables) ; 404 pour chaque combinaison incohérente ; à l'écran, binaire récupéré (200) et ouvert dans un nouvel onglet, aucun message d'erreur | P2 | `tests/ged/documents/versions.spec.ts` |

### Onglet « Sécurité et conformité »

| Id | Scénario | Préconditions | Étapes | Résultat attendu | Priorité | Spec |
|---|---|---|---|---|---|---|
| GED-25 | Vérifier l'intégrité d'un document | Document PDF jamais vérifié | API : état d'intégrité ; écran : onglet Sécurité, « Vérifier maintenant » ; API : seconde vérification ; onglet Historique ; document inconnu | Empreinte de référence = SHA-256 du PDF déposé, « Jamais vérifié », « Non scellé » ; message « Intégrité conforme. », badge « Conforme », « Empreinte conforme » ; second passage `integrityOk: true`, statut `ok` ; journal « Intégrité vérifiée — conforme » ; 404 sur document inconnu | P1 | `tests/ged/documents/cachet.spec.ts` |
| GED-26 | Apposer, vérifier et renouveler le cachet serveur | Document PDF non scellé ; aucune `SEALING_KEY_PATH` dans la pile E2E | API : clé publique ; écran : « Apposer le cachet » ; API : état du cachet ; déposer une nouvelle version ; recharger ; renouveler ; Historique | Clé `Ed25519` créée sans configuration, PEM publié, empreinte = SHA-256 du DER ; « Cachet apposé. », « Scellé et intact », « Authentique », « Inchangées », bouton « Renouveler le cachet » ; état `signatureValid`, `contentMatches`, `timestampMatches` vrais, clé connue ; après nouvelle version « Contenu modifié depuis » et alerte « Nouvelle version depuis le scellement » ; après renouvellement contenu de nouveau couvert ; journal « Cachet serveur apposé » puis « renouvelé » | P1 | `tests/ged/documents/cachet.spec.ts` |
| GED-26 | Refus propres du cachet | Aucun document 999999999 | API : `GET` et `POST /documents/999999999/seal` ; `POST /documents/abc/seal` | 404 « Document introuvable » ; 400 | P3 | `tests/ged/documents/cachet.spec.ts` |

### Onglets « Accès par utilisateur / par profil » et refus d'accès

| Id | Scénario | Préconditions | Étapes | Résultat attendu | Priorité | Spec |
|---|---|---|---|---|---|---|
| GED-27 | Accorder puis retirer un droit nominatif | Document PDF ; utilisateur avec compte-acteur | Onglet « Accès par utilisateur » ; choisir l'utilisateur et « Consultation » ; « Accorder » ; ouvrir la fiche en son nom (API) ; retirer le droit (confirmation) | « Aucun droit explicite » au départ ; « Denied » jamais proposé ; « Droit accordé. », ligne « Consultation / Sans limite » ; le bénéficiaire ouvre la fiche au niveau 2 ; « Droit retiré. », liste vide. Avant de confirmer, le pointeur quitte l'icône : son infobulle recouvre le bouton « Retirer » de la confirmation (défaut signalé, `AccessTab.tsx` hors lot) | P1 | `tests/ged/documents/acces.spec.ts` |
| GED-27 | Droits par profil et erreurs de saisie de l'octroi | Document PDF ; utilisateur avec profil | API : accorder « Modification » au profil deux fois ; onglet « Accès par profil » ; octrois invalides (Denied, niveau 99, acteur/profil inconnus, deux ou zéro bénéficiaire, date mal formée) ; retrait inconnu ; document inconnu | Octroi idempotent (même ligne) et visible dans l'onglet profil ; 400 avec message explicite pour chaque saisie invalide ; 404 « Droit introuvable » ; 404 document ; seul le droit par profil subsiste | P2 | `tests/ged/documents/acces.spec.ts` |
| GED-28 | Utilisateur sans droit sur un document restreint | Document restreint (un droit explicite existe, pas pour lui) ; utilisateur avec compte-acteur sans droit | API en son nom : fiche, versions, binaires, onglets annexes ; s'octroyer Archivistique, déclassifier, sceller, déposer une version ; recherche ; écran : se connecter et ouvrir la fiche | 404 partout (jamais 403, jamais 200) ; aucun effet en base (pas de droit ajouté, pas de cachet) ; la recherche ne le liste pas (l'admin, oui) ; écran « Document introuvable » sans onglet ni erreur JS | P1 | `tests/ged/documents/acces.spec.ts` |
| GED-28 | Document sans droit explicite ouvert à tous | Document sans aucun droit ; utilisateur sans rôle ni profil | API en son nom : fiche, droits | Fiche ouverte au niveau Consultation (2) ; liste des droits vide | P2 | `tests/ged/documents/acces.spec.ts` |
| GED-29 | Niveau Consultation : fiche en lecture seule | Document v1+v2 ; droit Consultation accordé à l'utilisateur | API en son nom : lectures, puis restaurer, sceller, vérifier, cycle de vie, indexer, déposer ; écran : fiche, onglets Versions, Sécurité, Accès | Lectures 200 ; écritures 403 avec message de niveau ; « Vos droits : Consultation », pas d'onglet Indexation, ni « Nouvelle version » ni « Restaurer » ; raisons « Niveau Modification requis… » / « Niveau Archivistique requis… » à la place des boutons ; pas de bouton « Accorder » | P1 | `tests/ged/documents/acces.spec.ts` |
| GED-29 | Niveau Consultation : gestion des accès et confidentialité (décision Q2 du 2026-11-22 : qui ouvre la fiche gère ses droits et sa confidentialité) | Droit Consultation accordé à l'utilisateur ; un tiers avec compte-acteur | API en son nom : accorder Consultation au tiers puis la retirer ; s'accorder Archivistique ; retirer la confidentialité | 201 puis 200 ; 201 et ligne « Archivistique » présente ; 200 sur `PUT confidentialite` (valeur nulle). Écart signalé : l'écran masque toujours « Accorder » sous le niveau 4 (ligne précédente) | P1 | `tests/ged/documents/acces.spec.ts` |

## Éditeur collaboratif et rédaction assistée


Préconditions communes : administrateur connecté (fixture `page`) ; données créées par test avec `uniq()`
(espace privé de l'administrateur `POST /spaces`, document texte `POST /collab/documents`) ; comptes
non administrateurs créés par `createEditorUser` (`_helpers/editeur.ts` : `createRestrictedUser` + profil
par défaut, sans lequel l'éditeur répond 403). Pile sans fournisseur IA (mode « désactivée »).
WebSocket `/api/collab` relayé par le rewrite Next `/api/:path*` (URL déduite de la page).

### /editeur/nouveau

| Id | Scénario | Préconditions | Étapes | Résultat attendu | Priorité | Spec |
| --- | --- | --- | --- | --- | --- | --- |
| GED-30 | Créer un document vide puis l'ouvrir dans l'éditeur | Espace privé de l'administrateur | Ouvrir `/editeur/nouveau`, choisir l'espace, saisir un titre, laisser « Document vide », « Créer le document » | Redirection `/editeur/:id`, titre en en-tête, éditeur modifiable et « Connecté », « Version 1 » ; session `write`, une seule version (Création) | P1 | tests/ged/editeur/creation.spec.ts |
| GED-31 | Erreurs de saisie à la création (écran et API) | Espace privé de l'administrateur ; un autre compte | Écran : valider sans espace, puis titre blanc, puis « Importer un DOCX » sans fichier. API : libellé blanc, 501 caractères, champ inconnu, espace inexistant, espace invisible pour l'autre compte | Écran : « Choisissez un espace. », « Saisissez un titre. », « Choisissez le fichier DOCX à importer, ou décochez l'option. », aucune requête de création, URL inchangée. API : 400, 400, 400, 404, 404 | P2 | tests/ged/editeur/creation.spec.ts |

### /editeur/[documentId] — saisie, versions, DOCX, mentions

| Id | Scénario | Préconditions | Étapes | Résultat attendu | Priorité | Spec |
| --- | --- | --- | --- | --- | --- | --- |
| GED-32 | Saisie, enregistrement automatique et persistance | Document texte vide | Saisir deux paragraphes, attendre « Connecté · Enregistré », recharger la page ; variante : ouvrir un second onglet | Après rechargement, les deux paragraphes sont présents (deux blocs) ; l'export DOCX serveur les contient ; le second onglet relit le contenu | P1 | tests/ged/editeur/edition.spec.ts |
| GED-33 | Enregistrer une version, doublon, restauration | Document texte vide | Saisir, « Enregistrer une version » avec résumé ; réenregistrer sans changement ; ajouter du texte, enregistrer ; ajouter du texte non versionné ; Historique > « Restaurer la version 2 » > « Restaurer » | « Version 2 enregistrée. » et barre d'état « Version 2 » ; doublon : message « contenu identique », pas de version ; restauration : v4 « Avant restauration », v5 Restauration (depuis v2) courante, l'éditeur se recharge sur le contenu de la v2, barre d'état « Version 5 » (numéro relu à la reconnexion : ANO-GED-16, corrigée côté écran), contenu stable après rechargement. La boîte « Enregistrer une version » est neuve à chaque ouverture (ANO-GED-15) | P1 | tests/ged/editeur/versions.spec.ts |
| GED-34 | Exporter en DOCX | Document avec texte saisi | Menu « DOCX » > « Exporter en DOCX » | Téléchargement `<titre>.docx`, archive ZIP Word contenant le texte saisi | P2 | tests/ged/editeur/docx.spec.ts |
| GED-35 | Importer un DOCX (document existant, création, refus) | Document avec texte ; DOCX fabriqué en mémoire | (a) Menu « DOCX » > « Importer un DOCX… », confirmer « Remplacer le contenu » ; (b) `/editeur/nouveau`, « Importer un DOCX », fichier, titre vide ; (c) fichier `.txt`, puis faux `.docx` | (a) « Le fichier DOCX a été importé. », contenu remplacé en direct, versions « Avant import DOCX » et « Import DOCX », barre d'état à jour ; (b) document créé, titre = nom du fichier, contenu importé ; (c) « Choisissez un fichier au format DOCX. », puis 400 « Le fichier n'est pas un document Word (.docx) valide », contenu et versions inchangés | P2 | tests/ged/editeur/docx.spec.ts |
| GED-36 | Mentions « @ » : candidats et notification | Document texte ; un second compte avec profil | API : candidats sur le nom du compte, requête d'un caractère, soi-même, document restreint, requête de 101 caractères. Écran : saisir « @<identifiant> », choisir la personne | API : candidat présent, `[]`, soi exclu, candidat retiré et 404 pour lui une fois le document restreint, 400. Écran : liste « Personnes à mentionner » + aide « ne lui donne pas accès », mention insérée, notification « … vous a mentionné dans le document « titre » » reçue | P2 | tests/ged/editeur/mentions.spec.ts |

### /editeur/[documentId] — droits et collaboration

| Id | Scénario | Préconditions | Étapes | Résultat attendu | Priorité | Spec |
| --- | --- | --- | --- | --- | --- | --- |
| GED-37 | Droits : lecture seule, refus, inexistant, sans profil, retrait en cours de session | Document texte ; comptes non administrateurs | (a) lecteur (droit Consultation) : API d'écriture puis écran ; (b) document restreint à l'administrateur, autre compte : 6 routes REST puis écran ; (c) `/editeur/2147483000`, `/editeur/abc`, `/editeur/0` ; (d) compte sans profil : session ; (e) lecteur connecté, puis document restreint | (a) session `read`, versions/restore/import 403, export 200 ; éditeur non modifiable, « Lecture seule », ni « Enregistrer une version » ni restauration, import désactivé ; (b) 404 « Document introuvable » partout, écran « Document inaccessible » ; (c) « Document inaccessible » ; (d) 403 « Aucun profil actif… » ; (e) connexion fermée (4401) au balayage, écran « Document inaccessible » | P1 | tests/ged/editeur/droits.spec.ts |
| GED-38 | Collaboration temps réel à deux | Document texte ; second compte avec droit Modification ; deux contextes navigateur | A (administrateur) et B ouvrent le document ; A saisit ; B saisit ; B quitte, A recharge | Chacun voit l'autre dans « Personnes connectées » ; le texte de A apparaît chez B et inversement ; curseur de B étiqueté chez A ; contenu commun persisté | P1 | tests/ged/editeur/collaboration.spec.ts |

### Rédaction assistée (sans IA)

| Id | Scénario | Préconditions | Étapes | Résultat attendu | Priorité | Spec |
| --- | --- | --- | --- | --- | --- | --- |
| GED-39 | Rédaction assistée sans fournisseur IA | Aucun réglage IA (mode désactivée) | API : catalogue, détail d'un modèle, modèle inconnu ; génération valide, consigne blanche, modèle inconnu, champ inconnu, 6e demande en une minute ; création depuis un modèle (nominal, modèle inconnu, libellé blanc, espace invisible). Écran : panneau « Rédiger avec l'IA », « Insérer le modèle vide » ; `/editeur/nouveau` avec le modèle « Compte rendu de réunion » | Catalogue `aiEnabled: false`, « IA désactivée », sans squelette ; détail avec squelette ; 404. Génération : 200 `{ disabled: true, message: "IA désactivée" }`, 400, 404, 400, 429 + Retry-After. Création : 201 + session `write`, 404, 400, 404. Écran : bandeau « L'IA est désactivée par l'administrateur. », squelette inséré (titres, tableau), aucun appel de génération ; création depuis modèle → `?assist=1`, panneau ouvert, squelette présent, version « Création depuis un modèle » | P2 | tests/ged/editeur/redaction.spec.ts |

## Recherche IA, gouvernance, connecteurs et réglages IA

### Recherche IA

| Id | Scénario | Préconditions | Étapes | Résultat attendu | Priorité | Spec |
|---|---|---|---|---|---|---|
| GED-40 | Question posée IA désactivée : repli plein texte | IA désactivée (mode 0), utilisateur avec le menu `/recherche-ia` | Ouvrir /recherche-ia, onglet « Poser une question », saisir une question, envoyer | Réponse `mode: fulltext`, message de repli affiché, aucune réponse générée ni citation, `decisionId` nul | P1 | tests/ged/recherche-ia/recherche-ia.spec.ts |
| GED-41 | « Rechercher » IA désactivée : repli plein texte (écran et API) | IA désactivée, menu `/recherche-ia` | Saisir un terme, cliquer « Rechercher » ; appeler `POST /ged/semantic-search` | 200, `mode: fulltext`, message de repli, liste (éventuellement vide) sans erreur | P1 | tests/ged/recherche-ia/recherche-ia.spec.ts |
| GED-41 | Document archivé retrouvé par le repli plein texte | Document créé puis validé (archivé) par les aides `_helpers/archives.ts`, libellé portant un terme unique | Rechercher le terme (API puis écran) | API : un seul résultat, ce document, son libellé, `score: null` ; écran : lien au libellé vers `/documents/<id>` | P1 | tests/ged/recherche-ia/recherche-ia.spec.ts |
| GED-42 | Saisie : minima, raccourcis, exemple | Menu `/recherche-ia` | Bouton désactivé sous le minimum ; Maj+Entrée = saut de ligne ; Entrée = envoi ; clic sur un exemple | Bouton inactif tant que la saisie est trop courte ; envoi seulement sur Entrée ; l'exemple remplit la saisie | P2 | tests/ged/recherche-ia/recherche-ia.spec.ts |
| GED-42 | Corps invalides refusés par l'API | Menu `/recherche-ia` | `POST /ged/semantic-search` et `/ask` avec requête vide, trop longue, champ inconnu, `limit` hors bornes | 400 avec message de validation, jamais 500 | P2 | tests/ged/recherche-ia/recherche-ia.spec.ts |
| GED-43 | Sans le menu : refus API et écran | Utilisateur sans `/recherche-ia` | Appeler les routes ; ouvrir l'écran et envoyer une question | 403 « Vous n'avez pas accès à cette section. » ; alerte « Vous n’avez pas accès à la recherche IA. » | P1 | tests/ged/recherche-ia/recherche-ia.spec.ts |
| GED-43 | Refus affiché dès l'ouverture (décision Q5) | Utilisateur sans le menu | Ouvrir /recherche-ia par l'URL | « Accès refusé » d'entrée, pas de champ de question. `test.fixme` « en attente du lot transverse : écran Accès refusé » ; le refus API 403 reste vérifié par la ligne précédente | P2 | tests/ged/recherche-ia/recherche-ia.spec.ts |
| GED-43 | Avec le menu : recherche permise, réindexation réservée | Utilisateur avec `/recherche-ia`, non administrateur | Rechercher ; appeler la réindexation | Recherche 200 ; réindexation 403 « Réservé aux administrateurs » (et réponse « désactivée » pour l'admin) | P1 | tests/ged/recherche-ia/recherche-ia.spec.ts |
| GED-44 | Limite de 6 questions par minute | Utilisateur neuf avec le menu | Poser 7 questions en moins d'une minute | 7e : 429, en-tête `Retry-After`, message « Trop de requêtes … » affiché à l'écran | P2 | tests/ged/recherche-ia/recherche-ia.spec.ts |

### Gouvernance

| Id | Scénario | Préconditions | Étapes | Résultat attendu | Priorité | Spec |
|---|---|---|---|---|---|---|
| GED-45 | Tableau de bord IA désactivée | IA désactivée, administrateur | Ouvrir /gouvernance ; `GET /governance/dashboard` | `aiEnabled: false`, message « IA désactivée : seules les détections déterministes… », 4 cartes de synthèse cliquables (filtre activé/désactivé) | P1 | tests/ged/gouvernance/gouvernance.spec.ts |
| GED-46 | Filtres combinés sans résultat puis réinitialisation | Aucune proposition en base | Combiner type + statut ; réinitialiser | « Aucune proposition ne correspond à ces filtres. » puis retour à l'état initial | P2 | tests/ged/gouvernance/gouvernance.spec.ts |
| GED-46 | Filtres et identifiants invalides côté API | Administrateur | `GET /governance/proposals` avec type/statut/page invalides ; proposition inexistante | 400 ; 404 | P2 | tests/ged/gouvernance/gouvernance.spec.ts |
| GED-47 | Modale d'analyse | Administrateur | Ouvrir « Analyser », saisies invalides, numéro introuvable, liste de numéros inexistants | Erreurs de saisie ; 404 « Ce document est introuvable, n’est pas archivé ou ne vous est pas accessible. » ; numéros ignorés annoncés | P1 | tests/ged/gouvernance/gouvernance.spec.ts |
| GED-47 | Contrat de l'API d'analyse | Administrateur | `POST /governance/analyze` avec `documentIds` inexistants, `documentId` absent, corps invalides | 202 `queued: 0` + `ignored` ; 404 ; 400 | P1 | tests/ged/gouvernance/gouvernance.spec.ts |
| GED-48 | Sans le menu « Gouvernance » | Utilisateur sans `/gouvernance` | Ouvrir l'écran ; appeler l'API | État « Accès refusé… » ; 403 | P1 | tests/ged/gouvernance/gouvernance.spec.ts |
| GED-48 | Avec le menu, non administrateur | Utilisateur avec `/gouvernance` | Ouvrir l'écran ; analyser `{all: true}` | Écran ouvert ; « tout le fonds » refusé (403) | P1 | tests/ged/gouvernance/gouvernance.spec.ts |
| GED-49 | Revue d'une proposition inexistante ou mal adressée | Administrateur | Valider/rejeter un numéro inexistant ou invalide ; route générique `/ged/ai/decisions` | 404 / 400 ; « Décision IA introuvable » | P2 | tests/ged/gouvernance/gouvernance.spec.ts |
| GED-49 | Valider puis rejeter une vraie proposition | Trois documents archivés au même PDF (aides `_helpers/archives.ts`) ; worker `ged-governance` (`E2E_WORKER=1`, exigé) | Analyser (202, 3 en file) ; attendre les propositions « doublon exact » des deux copies ; valider l'une, rejeter l'autre ; revalider/rejeter | Original = le plus ancien, sans proposition ; validée : statut 1, doublon figé ; seconde revue 409 ; rejetée : statut 2, non figé ; tableau de bord : validées +1, rejetées +1 | P1 | tests/ged/gouvernance/gouvernance.spec.ts |

### Connecteurs

| Id | Scénario | Préconditions | Étapes | Résultat attendu | Priorité | Spec |
|---|---|---|---|---|---|---|
| GED-50 | Types de sources | Administrateur | `GET /connectors/types` ; ouvrir la modale de création | 7 types ; les types OAuth ne demandent aucun identifiant en saisie | P2 | tests/ged/connecteurs/connecteurs.spec.ts |
| GED-51 | Création d'un dossier surveillé par l'écran | `GED_CONNECTOR_FS_ROOTS` = racine temporaire des tests | Remplir la modale (libellé, chemin sous la racine), enregistrer | Connecteur créé, visible dans la liste et sa fiche ; aucun secret dans la vue | P1 | tests/ged/connecteurs/connecteurs.spec.ts |
| GED-52 | Test de connexion : réussite puis échec | Connecteur dossier sur un dossier temporaire | Tester ; supprimer le dossier ; tester à nouveau | Message de réussite puis échec explicite (jamais d'erreur HTTP) | P1 | tests/ged/connecteurs/connecteurs.spec.ts |
| GED-52 | Test d'un connecteur OAuth non autorisé | Connecteur Google Drive sans autorisation | `POST /connectors/:id/test` | `ok: false` avec message, sans appel externe | P2 | tests/ged/connecteurs/connecteurs.spec.ts |
| GED-53 | Erreurs du formulaire | Administrateur | Enregistrer vide ; groupes invalides ; chemin hors racine | Champs requis signalés ; message de l'API affiché | P1 | tests/ged/connecteurs/connecteurs.spec.ts |
| GED-53 | Configurations invalides côté API | Administrateur | Corps invalides, chemin hors racine, groupe hors int4, secrets en config | 400 (jamais 500), aucun secret renvoyé | P1 | tests/ged/connecteurs/connecteurs.spec.ts |
| GED-54 | Désactivation, synchronisation bloquée, réactivation | Connecteur dossier actif | Désactiver (confirmation) ; synchroniser ; activer | Statut inactif ; 409 sur la synchronisation ; statut actif. La liste affiche le plus récent en tête (ANO-GED-14) et « Activer » / « Désactiver » sont deux boutons distincts (ANO-GED-15) | P1 | tests/ged/connecteurs/connecteurs.spec.ts |
| GED-54 | « Synchroniser maintenant » | Connecteur actif, Redis joignable | Cliquer « Synchroniser maintenant » | Demande mise en file, message de confirmation | P2 | tests/ged/connecteurs/connecteurs.spec.ts |
| GED-54 | Synchronisation traitée par le worker (`E2E_WORKER=1` exigé, plus de skip) | Worker `ged-connector-sync` actif | Synchroniser un dossier contenant un fichier | Passe réussie, élément repris | P2 | tests/ged/connecteurs/connecteurs.spec.ts |
| GED-55 | Autorisation OAuth sans identifiants d'application | Aucun `GED_GOOGLE_CLIENT_*` / `GED_MS_*` ; `GED_CONNECTOR_KEY` défini | Démarrer l'autorisation Google et Microsoft (API et bouton) ; type non OAuth ; connecteur inexistant | 409 « Fournisseur … non configuré … » ; 400 ; 404 ; erreur affichée | P1 | tests/ged/connecteurs/connecteurs.spec.ts |
| GED-56 | Page de retour OAuth | Administrateur | Ouvrir /connecteurs/oauth/callback sans paramètres, avec `error=access_denied`, avec un état forgé | Messages d'erreur dédiés, aucune autorisation enregistrée | P1 | tests/ged/connecteurs/connecteurs.spec.ts |
| GED-56 | API de retour OAuth | Administrateur | `POST /connectors/oauth/callback` avec état forgé ou corps invalide | 400 « Autorisation invalide ou expirée : recommencez » / validation | P1 | tests/ged/connecteurs/connecteurs.spec.ts |
| GED-57 | Non administrateur | Utilisateur au rôle très ouvert, non admin | Ouvrir liste, fiche, retour OAuth ; appeler toutes les routes | État « accès refusé » ; 403 partout | P1 | tests/ged/connecteurs/connecteurs.spec.ts |
| GED-57 | Fiche inexistante ou identifiant invalide | Administrateur | Ouvrir /connecteurs/2147483000 et /connecteurs/abc | Message « introuvable » / identifiant invalide, sans plantage | P2 | tests/ged/connecteurs/connecteurs.spec.ts |

### Réglages IA

| Id | Scénario | Préconditions | Étapes | Résultat attendu | Priorité | Spec |
|---|---|---|---|---|---|---|
| GED-58 | Lecture des réglages | IA désactivée, administrateur | `GET /ged/ai/settings` | Exactement les 13 champs de la vue, `mode: 0`, dimension 1024, référence de clé = nom de variable ou nulle, aucune valeur de clé | P1 | tests/ged/connecteurs/reglages-ia.spec.ts |
| GED-58 | Saisies invalides refusées sans écriture | Administrateur | `PUT` cloud sans masquage, référence hors liste blanche, clé à la place de la référence, dimension 512, délais/seuil hors bornes, local sans endpoint, endpoint ftp ou avec identifiants, mode 3, champ inconnu | 400 chacun, message explicite, secret jamais renvoyé, vue inchangée (`updatedAt` compris) | P1 | tests/ged/connecteurs/reglages-ia.spec.ts |
| GED-58 | Mise à jour partielle puis restauration | Administrateur, ni `GED_AI_API_KEY` ni `OPENAI_API_KEY` | `PUT {apiKeyRef, timeoutSeconds}` puis restauration | Champs modifiés seuls, `apiKeyConfigured: false`, IA toujours désactivée ; état initial restauré | P1 | tests/ged/connecteurs/reglages-ia.spec.ts |
| GED-59 | Socle IA désactivé | IA désactivée | `GET /ged/ai/status` ; analyser un document ; lister/consulter/réviser des décisions ; règles de masquage | `{enabled:false, mode:0}` ; `{disabled:true}` sans mise en file ; 400 sur filtres et identifiants invalides ; 404 « Décision IA introuvable » | P2 | tests/ged/connecteurs/reglages-ia.spec.ts |
| GED-59 | Non administrateur | Utilisateur avec les menus GED, non admin | Appeler toutes les routes `/ged/ai/*` | 403 « Réservé aux administrateurs », réglages inchangés | P2 | tests/ged/connecteurs/reglages-ia.spec.ts |


## Anomalies et suivi (phase B, 2026-11-22)

| Id | Constat | Statut |
| --- | --- | --- |
| ANO-GED-07 | `GET /documents/99999999999` (hors INT4) répond 500 | Lot transverse, `test.fixme` (GED-21) |
| ANO-GED-09 | Erreur de validation dont le `message` est un tableau affichée « HTTP 400 » (`apps/web/app/lib/api.ts`) | Lot transverse, `test.fixme` (GED-17) |
| ANO-GED-12 | Un document non archivé pouvait être rattaché à un espace | Corrigée : `spaces.service.ts` (409), tests unitaires et GED-15 |
| ANO-GED-13 | Éditeur planté côté navigateur : « Adding different instances of a keyed plugin » (double chargement CJS/ESM de prosemirror) | Corrigée : build ESM navigateur de `packages/editor` (condition `browser`) |
| ANO-GED-14 | Liste des connecteurs du plus ancien au plus récent, 20 par page : un connecteur tout juste créé n'est pas visible | Corrigée : plus récent en tête (`newestFirst`, test unitaire `connecteurs/_tests/liste.test.ts`) |
| ANO-GED-15 | Icône de chargement Ant Design parfois laissée dans un bouton réutilisé : nom accessible « loading … » | Contournée sur les écrans du lot (boîte « Enregistrer une version », bouton Activer/Désactiver) ; cause générale transverse |
| ANO-GED-16 | Après une restauration, la barre d'état de l'éditeur affichait l'avant-dernière version (salle fermée en 4410 avant l'écriture de la version restaurée) | Corrigée côté écran : numéro relu à la première synchronisation |
| GED-43 (Q5) | Écran ouvert par l'URL sans le menu : pas d'état « Accès refusé » d'entrée | Lot transverse, `test.fixme` |
