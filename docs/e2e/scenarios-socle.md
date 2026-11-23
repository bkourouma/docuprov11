# Scénarios E2E : socle et administration (lot 5)

Specs sous `apps/e2e/tests/socle/`. Chaque test Playwright porte l'identifiant `SOC-xx` dans son titre.
Priorités : P1 critique, P2 important, P3 confort. Les tests en `test.fixme` sont signalés dans la
colonne Spec, avec leur motif (question métier ou outillage manquant).

Aides partagées : `_helpers/accounts.ts` (rôle restreint, utilisateur, levée du mot de passe
provisoire), `_helpers/admin.ts` (seul import de `support/`), `_helpers/jwt.ts`, `_helpers/session.ts`,
`_helpers/tache-a.ts`, `_helpers/securite.ts`, `_helpers/referentiels.ts`, `_helpers/dashboards.ts`,
`_helpers/fichiers.ts`.

## Parcours de bout en bout

| Id | Scénario | Préconditions | Étapes | Résultat attendu | Priorité | Spec |
|---|---|---|---|---|---|---|
| SOC-19 | Rôle restreint de bout en bout, par l'interface | Session admin | Sur /admin/roles, créer un rôle avec Tableaux de bord, Recherche et Types de document. Sur /admin/users, créer un compte de ce rôle. Dans un nouveau contexte : connexion, changement de mot de passe imposé, lecture de la barre latérale, ouverture de /admin/users par URL, appel GET /users. L'admin ajoute « Utilisateurs » au rôle, l'utilisateur recharge | POST /roles 201 et POST /users 201. Menus visibles : Tableaux de bord, Recherche, Types de document. Sur /admin/users, GET /users répond 403 et aucun compte n'est listé ; appel API direct : 403. Après PATCH du rôle (200) : la section Administration > Utilisateurs apparaît, la page charge (200), l'API répond 200. Cible : écran « Accès refusé » à l'ouverture de /admin/users sans le menu | P1 | parcours/role-restreint.spec.ts (fixme « en attente du lot transverse : écran Accès refusé » pour la partie écran) |

## Connexion et session

| Id | Scénario | Préconditions | Étapes | Résultat attendu | Priorité | Spec |
|---|---|---|---|---|---|---|
| SOC-01 | Champs vides | Sans session | Valider le formulaire vide, puis avec le nom seul | « Saisissez votre nom d’utilisateur. » puis « Saisissez votre mot de passe. » ; aucun POST /auth/login | P2 | auth/connexion.spec.ts |
| SOC-02 | Identifiants faux ; espaces de fin tolérés | Compte créé | Mot de passe faux ; utilisateur inconnu ; bons identifiants suivis d'espaces | 401 et « Identifiants invalides — … », pas de jeton. Avec espaces : ils sont retirés, arrivée sur /dashboards | P1 | auth/connexion.spec.ts |
| SOC-03 | Compte désactivé refusé | Compte désactivé | Connexion par l'API et par l'écran | 401 partout, même message que pour des identifiants faux | P1 | auth/connexion.spec.ts |
| SOC-04 | Jeton absent ou altéré | Sans session | /admin/users et /profil sans jeton ; jeton mal signé dans localStorage ; appels API sans jeton ou avec jeton forgé | Retour à /login ; /auth/me répond 401 et le jeton est effacé ; API 401 sur /auth/me, /auth/profile, /users, /roles | P1 | auth/connexion.spec.ts |
| SOC-05 | Jeton expiré | Secret JWT de la pile connu | Témoin non expiré, puis jeton expiré par l'API et par l'écran | Témoin 200 ; jeton expiré 401 ; retour à /login, jeton effacé | P2 | auth/connexion.spec.ts (fixme si le secret est absent) |
| SOC-06 | Jeton émis avant la désactivation | Compte connecté puis désactivé | GET /auth/me avec l'ancien jeton | 401 (FAILLE F1 corrigée) | P2 | auth/connexion.spec.ts |
| SOC-07 | /login avec une session active | Session admin | Ouvrir /login | Redirection vers /dashboards | P2 | auth/connexion.spec.ts |
| SOC-08 | Retour arrière après déconnexion | Session admin | /dashboards, puis /search, puis Déconnexion, puis retour arrière | On reste sur /login, sans barre latérale ni jeton | P1 | auth/connexion.spec.ts |
| SOC-39 | Session absente ou invalide (API) | — | 4 routes × (sans en-tête, « abc », signature fausse, alg none) ; POST /users avec un jeton forgé ; login inconnu ; navigateur avec jeton invalide | 401 partout ; le navigateur revient sur /login | P1 | api-acces/permissions-socle.spec.ts |

## Accueil

| Id | Scénario | Préconditions | Étapes | Résultat attendu | Priorité | Spec |
|---|---|---|---|---|---|---|
| SOC-09 | Redirections d'accueil | Session admin, puis sans session | Ouvrir /, puis /admin ; ouvrir / sans session | /dashboards ; /admin/classification-plans (titre « Plan de classement ») ; /login | P2 | auth/accueil.spec.ts |

## Mot de passe imposé

| Id | Scénario | Préconditions | Étapes | Résultat attendu | Priorité | Spec |
|---|---|---|---|---|---|---|
| SOC-10 | Première connexion | Compte créé par l'API (mustChangePwd vrai) | Connexion, étape « Nouveau mot de passe », validation | Aucune session avant le changement ; arrivée sur /dashboards ; /auth/me renvoie mustChangePwd faux ; l'ancien mot de passe donne 401, le nouveau passe sans l'étape | P1 | auth/mot-de-passe-force.spec.ts |
| SOC-11 | Étape imposée : refus et abandon | Idem | Mot de passe vide, 5 caractères, provisoire reconduit, espace final, confirmation différente ; « Revenir à la connexion » ; URL directe | Messages exacts, aucun appel change-password ; aucun jeton ; l'obligation reste posée côté serveur | P2 | auth/mot-de-passe-force.spec.ts |
| SOC-12 | Réinitialisation par l'admin | Compte en service | POST /users/:id/reset-password, puis connexion | L'ancien mot de passe donne 401 ; mustChangePwd vrai ; étape imposée, puis accueil | P1 | auth/mot-de-passe-force.spec.ts |
| SOC-13 | Mot de passe fixé depuis la fiche admin | Compte en service | PATCH /users/:id {password}, puis connexion | mustChangePwd vrai à la connexion (hypothèse métier appliquée) | P1 | auth/mot-de-passe-force.spec.ts |

## Mon profil

| Id | Scénario | Préconditions | Étapes | Résultat attendu | Priorité | Spec |
|---|---|---|---|---|---|---|
| SOC-14 | Profil d'un compte restreint | Rôle (2 menus, description) et habilitation | Ouvrir /profil | Nom, identifiant, e-mail, « Actif », « Non requis », rôle et description, « 3 menu(s) », niveau d'habilitation ; pas de mention « Administrateur » | P2 | profil/profil.spec.ts |
| SOC-15 | Profil administrateur | Admin | Ouvrir /profil | « Administrateur », « Tous (administrateur) », texte d'accès total | P3 | profil/profil.spec.ts |
| SOC-16 | Changement nominal | Compte en service | Mot de passe actuel, nouveau, confirmation, puis Modifier | 200 et « Mot de passe modifié. » ; champs vidés, session conservée ; l'ancien mot de passe donne 401, le nouveau 201 | P1 | profil/profil.spec.ts |
| SOC-17 | Erreurs de changement | Idem | Champs vides ; 5 caractères ; espace final ; confirmation différente ; mot de passe actuel faux | Messages exacts, sans appel API ; pour l'actuel faux : 400 « Mot de passe actuel incorrect », ancien mot de passe toujours valable | P1 | profil/profil.spec.ts |
| SOC-18 | Obligation en cours avec une session ouverte | Jeton obtenu par l'API, mustChangePwd vrai | Ouvrir /profil, puis changer le mot de passe | Alerte « Vous devez changer… » et « Exigé… » ; après le changement : alerte masquée, « Non requis », /auth/me faux | P2 | profil/profil.spec.ts |

## Écran Utilisateurs

| Id | Scénario | Préconditions | Étapes | Résultat attendu | Priorité | Spec |
|---|---|---|---|---|---|---|
| SOC-20 | Liste des comptes | Rôle et utilisateur créés | Ouvrir /admin/users ; vérifier les colonnes ; rechercher l'identifiant, puis « admin », puis un terme inconnu | Colonnes présentes, la ligne affiche le rôle ; `admin` n'est jamais listé ; « Aucun compte trouvé » | P1 | users/utilisateurs-ecran.spec.ts |
| SOC-21 | Création nominale ; mot de passe provisoire non bloqué par l'API | Rôle créé | « Ajouter un utilisateur », remplir, choisir le rôle, « Créer » ; puis jeton obtenu par POST /auth/login avec le mot de passe provisoire | 201 et « Utilisateur créé » ; la connexion répond avec mustChangePwd vrai ; l'API sert les routes avec ce jeton (règle confirmée : seul l'écran de connexion impose le changement) | P1 | users/utilisateurs-ecran.spec.ts |
| SOC-22 | Erreurs de saisie | — | E-mail absent ou invalide ; mot de passe de 5 caractères ou bordé d'espaces ; mêmes corps envoyés à l'API | « Créer » désactivé, champ en erreur ; l'API répond 400 ; aucun compte créé | P1 | users/utilisateurs-ecran.spec.ts |
| SOC-23 | Identifiant déjà utilisé | Compte existant | Créer avec le même identifiant ; puis par l'API avec des espaces autour | 409 « Cet identifiant est déjà utilisé », la modale reste ouverte ; 409 aussi pour la variante avec espaces | P1 | users/utilisateurs-ecran.spec.ts |
| SOC-24 | Modification du rôle et de la confidentialité | Rôles A et B, une confidentialité, compte sur A | « Modifier », choisir B et l'habilitation, « Enregistrer » | 200 et « Utilisateur modifié » ; la ligne affiche B ; /auth/me de l'utilisateur renvoie B sans reconnexion | P1 | users/utilisateurs-ecran.spec.ts |
| SOC-25 | Désactivation depuis la fiche | Compte actif | Basculer « Compte désactivé », enregistrer, se connecter ; puis réactiver | Badge « Désactivé », connexion 401 ; après réactivation, connexion 201 | P1 | users/utilisateurs-ecran.spec.ts |
| SOC-26 | Jeton déjà émis (FAILLE F1) | Session ouverte | Désactiver le compte, ou rétrograder un administrateur | /auth/me, /auth/profile et change-password répondent 401 ; l'admin rétrogradé reçoit 403 sur /users et /roles/menus avec le même jeton, et ses menus se réduisent à `['/']` | P1 | users/utilisateurs-session.spec.ts |
| SOC-27 | Réinitialisation du mot de passe | Compte actif | POST /users/:id/reset-password ; ou saisie dans la fiche | Ancien mot de passe 401, nouveau accepté avec mustChangePwd vrai ; reset de moins de 6 caractères : 400 ; id inconnu : 404 ; depuis la fiche, le changement est aussi exigé à la connexion | P1 | users/utilisateurs-ecran.spec.ts, users/utilisateurs-session.spec.ts |
| SOC-28 | Suppression | Compte créé | « Supprimer », puis « Annuler » ; puis « Supprimer » confirmé | Annuler garde le compte. Confirmer : 200, « Utilisateur supprimé », ligne absente, connexion 401, jeton déjà émis en 401 | P1 | users/utilisateurs-ecran.spec.ts, users/utilisateurs-session.spec.ts |
| SOC-29 | Protection du compte admin | Seed | PATCH (e-mail, isDisabled, isAdmin, roleId), DELETE, PATCH /users/confidentialite | 400 avec messages exacts ; la mise à jour en masse touche 0 ligne ; `admin` reste connectable et administrateur | P1 | users/utilisateurs-session.spec.ts |

## Écran Rôles

| Id | Scénario | Préconditions | Étapes | Résultat attendu | Priorité | Spec |
|---|---|---|---|---|---|---|
| SOC-30 | Création avec menus | — | Nom vide ou fait d'espaces, puis un nom ; cocher Recherche et Utilisateurs ; « Créer le rôle » | Bouton inactif sans nom ; puis 201, « Rôle créé », formulaire vidé ; un porteur du rôle voit exactement ces menus plus « / » | P1 | roles/roles-ecran.spec.ts |
| SOC-31 | Modification des menus | Rôle [/search], porteur connecté | « Permissions », décocher Recherche, cocher Utilisateurs, « Enregistrer » ; variante : saisir puis « Annuler » | « Rôle mis à jour » ; /auth/me change et GET /users passe de 403 à 200 avec le même jeton ; « Annuler » demande confirmation et n'enregistre rien | P1 | roles/roles-ecran.spec.ts |
| SOC-32 | Désactivation du rôle | Rôle [/admin/users, /search], porteur connecté | PATCH isActive faux, puis vrai | Menus réduits à `['/']` et /users en 403 ; puis menus rendus et 200 | P1 | roles/roles-ecran.spec.ts (fixme pour l'interrupteur à l'écran : question) |
| SOC-33 | Rôle système non modifiable | Seed | Ligne système : tag « Système », bouton « Voir » ; PATCH et DELETE par l'API | Carte en lecture seule ; l'API répond 400 avec message exact ; rôle inchangé | P1 | roles/roles-ecran.spec.ts |
| SOC-34 | Suppression d'un rôle utilisé | Rôle [/admin/users] avec un porteur | « Supprimer », lire « 1 utilisateur(s) perdront… », confirmer | 200 et « Rôle supprimé » ; le porteur n'a plus de rôle, menus `['/']`, /users en 403 ; un second DELETE répond 404 | P1 | roles/roles-ecran.spec.ts (fixme P3 pour un rôle destinataire de courrier : fixture courrier manquante) |
| SOC-35 | Validation du rôle | — | API : nom vide, fait d'espaces, de 201 caractères ; menuKeys avec clés inconnues, « / » ou doublons ; PATCH sur id inconnu | 400 ; seules les clés assignables sont retenues ; 404 | P2 | roles/roles-ecran.spec.ts (fixme pour un nom en double en 409 : question) |

## Permissions API du socle

| Id | Scénario | Préconditions | Étapes | Résultat attendu | Priorité | Spec |
|---|---|---|---|---|---|---|
| SOC-36 | Utilisateur sans menu d'administration | Rôle [/search] | Table de 18 routes : users, roles, document-permissions, file-types, confidentialites | 403 partout ; aucune donnée modifiée | P1 | api-acces/permissions-socle.spec.ts |
| SOC-37 | Administrateur délégué (menus Utilisateurs, Rôles) | Rôle [/admin/users] ; rôle [/admin/roles] | Créer un admin ; se promouvoir ; reset, patch, désactiver, groups, delete sur un autre admin et sur `admin` ; attribuer le rôle système ; s'attribuer un rôle non système plus large ; élargir son propre rôle | 403 pour tout ce qui touche `isAdmin`, un compte admin ou le rôle système (FAILLE F2 corrigée ; 400 pour PATCH et DELETE de `admin`) ; s'attribuer un rôle plus large et élargir son propre rôle : 200 (règle confirmée) | P1 | api-acces/permissions-socle.spec.ts |
| SOC-38 | Droits sur un document et par type (FAILLES F3 et droits par type) | Rôle avec menus de sécurité par type ; rôle [/search] | POST /referentials/document-permissions ; sans menu de sécurité : POST, GET et DELETE /referentials/document-type-permissions | 403 partout ; le droit accordé par l'admin reste en place | P1 | api-acces/permissions-socle.spec.ts |

## Sécurité : confidentialités

| Id | Scénario | Préconditions | Étapes | Résultat attendu | Priorité | Spec |
|---|---|---|---|---|---|---|
| SOC-40 | Créer un niveau | Admin | Saisir un libellé, puis Ajouter | 201 et « Élément créé » ; rang multiple de 10, au-dessus de tous les rangs actifs | P1 | securite/confidentialites.spec.ts |
| SOC-41 | Libellé vide ; rang non saisissable | Admin | Libellé vide ou fait d'espaces ; POST avec `rank` | Ajouter inactif ; 400 ; `rank` ignoré (calculé) | P2 | securite/confidentialites.spec.ts |
| SOC-42 | Doublon de libellé | Niveau existant | Même libellé à l'écran ; variantes de casse et d'espaces par l'API ; désactiver puis recréer | 409 « Un niveau de confidentialité actif porte déjà ce libellé » (jamais 500) ; libellé réutilisable après désactivation | P1 | securite/confidentialites.spec.ts |
| SOC-43 | Renommer en ligne | 2 niveaux | Édition en ligne ; renommer vers l'autre libellé ; PATCH avec rang, avec espaces, sur id inconnu | « Modifié », rang inchangé ; 409 et valeur rétablie ; 400 ; 404 | P1 | securite/confidentialites.spec.ts |
| SOC-44 | Désactiver un niveau porté par un compte | Niveau et utilisateur habilité | Désactiver ; DELETE sur id inconnu | « Élément désactivé », absent des listes ; le compte garde son habilitation ; 404 | P1 | securite/confidentialites.spec.ts |
| SOC-45 | Refus sans le menu | Rôle limité à /admin/dossiers | API GET/POST/PATCH/DELETE ; barre latérale ; écran par URL directe | GET 200, écritures 403 ; pas de section « Sécurité Documentaire » ; cible : écran « Accès refusé » | P1 | securite/confidentialites.spec.ts (fixme « en attente du lot transverse : écran Accès refusé » pour l'écran) |
| SOC-46 | Titulaire du seul menu Confidentialités | Rôle [confidentialites] | POST/PATCH/DELETE ; PATCH /users/confidentialite | 201/200/200 ; 403 sur le menu voisin | P2 | securite/confidentialites.spec.ts |

## Sécurité : confidentialité des utilisateurs

| Id | Scénario | Préconditions | Étapes | Résultat attendu | Priorité | Spec |
|---|---|---|---|---|---|---|
| SOC-47 | Affectation en masse | 2 comptes, 1 niveau | Rechercher, cocher 2 comptes, choisir le niveau, Appliquer, confirmer | « Niveau appliqué à 2 utilisateur(s). » ; colonne et GET /users à jour | P1 | securite/confidentialite-utilisateurs.spec.ts |
| SOC-48 | Retrait de l'habilitation | 2 comptes habilités | Cocher sans niveau, puis Retirer | Alerte « Aucun niveau sélectionné » ; habilitation remise à null | P1 | securite/confidentialite-utilisateurs.spec.ts |
| SOC-49 | Compte admin exclu | Seed | Rechercher « admin » ; PATCH qui le cible | Absent de la table ; `{updated:0}` | P1 | securite/confidentialite-utilisateurs.spec.ts |
| SOC-50 | Pas de porte dérobée par cet écran | Rôle [confidentialite-utilisateurs] | GET /users ; PATCH en masse avec isAdmin, roleId, password ; PATCH /users/:id ; POST /users | 200 ; champs étrangers ignorés ; 403 ; 403 | P1 | securite/confidentialite-utilisateurs.spec.ts |
| SOC-51 | Saisies invalides | Compte | `userIds:[]`, niveau absent, mauvais types ; niveau inexistant ou désactivé | 400 dans tous les cas (le 500 sur niveau inexistant est corrigé) | P2 | securite/confidentialite-utilisateurs.spec.ts |
| SOC-52 | Refus sans le menu | Rôle [/admin/dossiers] | API GET /users et PATCH ; barre latérale ; écran par URL | 403/403 ; section absente ; cible : écran « Accès refusé » | P1 | securite/confidentialite-utilisateurs.spec.ts (fixme « en attente du lot transverse : écran Accès refusé » pour l'écran) |

## Sécurité : type de document par rôle et par utilisateur

| Id | Scénario | Préconditions | Étapes | Résultat attendu | Priorité | Spec |
|---|---|---|---|---|---|---|
| SOC-53 | Octroyer à un rôle sur 2 types | Rôle, 2 types | Rôles, Types, niveau « Consultation », Accorder, déplier | « Droit accordé (1 × 2). » ; 2 lignes `scope:role` | P1 | securite/type-par-profil.spec.ts |
| SOC-54 | Retrait unitaire, puis « Tout retirer » | Rôle avec 3 droits, rôle témoin | Retirer un droit ; Tout retirer | « Droit retiré. », puis « 2 droits retirés. » ; droits du témoin intacts | P1 | securite/type-par-profil.spec.ts |
| SOC-55 | Saisies invalides | Rôle, acteur, type, type désactivé | Accorder sans sélection ; 11 corps invalides ; DELETE sur id inconnu | Avertissement à l'écran ; 400 (niveau Denied, références inconnues ou désactivées, dates) ; 404 ; rien d'écrit | P1 | securite/type-par-profil.spec.ts |
| SOC-56 | « Denied » jamais proposé | — | GET permission-levels ; ouvrir le Select « Niveau » | 4 options, sans « Denied » | P2 | securite/type-par-profil.spec.ts |
| SOC-57 | Cloisonnement des deux écrans | Droit par rôle et droit par acteur sur un même type | Ouvrir les 2 écrans | Chacun ne montre que son propre périmètre | P2 | securite/type-par-profil.spec.ts |
| SOC-58 | Octroi daté à un utilisateur, puis retrait | Acteur avec profil par défaut, type | Utilisateurs, Types, « Modification », du 01/01/2026 au 31/12/2026, Accorder, déplier, retirer | Corps envoyé exact ; « 01/01/2026 → 31/12/2026 » ; retrait OK | P1 | securite/type-par-utilisateur.spec.ts |
| SOC-59 | Droits par type réservés aux menus de sécurité par type | Rôle [/admin/dossiers] ; rôle [type-par-utilisateur] ; droit accordé par l'admin | Sans menu : POST, GET, DELETE ; titulaire du menu : GET, POST sur son rôle, DELETE du droit d'autrui et du sien | Sans menu : 403 ×3, rien d'écrit ; titulaire : 200, 201, 200, 200 (décision du 2026-11-22) | P1 | securite/type-par-utilisateur.spec.ts |
| SOC-60 | Effet d'un droit par type sur la visibilité | — | — | — | P3 | securite/effets-acces.spec.ts (fixme : aucune aide de création de document) |
| SOC-61 | Effet du rang de confidentialité sur la visibilité | — | — | — | P3 | securite/effets-acces.spec.ts (fixme : même motif) |

## Référentiels

| Id | Scénario | Préconditions | Étapes | Résultat attendu | Priorité | Spec |
|---|---|---|---|---|---|---|
| SOC-62 | Types de document : créer, renommer, supprimer | Admin | Ajouter ; modifier en ligne ; Supprimer et confirmer | « Type de document créé », « Modifié », « Type de document supprimé » ; libellé réutilisable | P1 | referentiels/types-document.spec.ts |
| SOC-63 | Types de document : requis, doublon, inconnus | 2 types | Libellé vide ; doublon à la création et au renommage ; PATCH/DELETE sur id inconnu | Bouton inactif ; 409 « Un type de document actif porte déjà ce libellé » ; 400 ; 404 | P1 | referentiels/types-document.spec.ts |
| SOC-64 | Exports Excel et PDF (4 écrans) | Une ligne créée | Boutons Excel et PDF ; GET export | Fichiers `.xlsx` (PK) et `.pdf` (%PDF-), MIME et nom corrects | P1 | referentiels/exports.spec.ts |
| SOC-65 | Dossiers : racine, sous-dossier, code, suppression | Admin | Formulaire Nom/Code/Élément parent ; modifier le code en ligne ; supprimer la racine | Chemins et profondeurs corrects ; code requis restauré s'il est vidé ; toute la branche désactivée | P1 | referentiels/dossiers.spec.ts |
| SOC-66 | Dossiers : erreurs et déplacement | A > B, un dossier désactivé | Sans code ; doublon ; parent inconnu ou désactivé ; déplacements | Bouton inactif ; 409 ; 400 « Élément parent introuvable » ; 400 « Déplacement cyclique interdit » ; déplacement vers la racine recalcule le chemin | P2 | referentiels/dossiers.spec.ts |
| SOC-67 | Plan de classement : nominal et erreurs | Admin | Racine sans code, rubrique cotée, code vidé, renommage, suppression ; appels API invalides | Code remis à null ; `{deactivated:true,count:2}` ; 400 et 404 | P1 | referentiels/plans-classement.spec.ts (fixme pour une cote en double : question) |
| SOC-68 | Géolocalisation : nominal et erreurs | Admin | Nom et code requis, enfant, code en ligne, suppression ; appels API invalides | Suppression en cascade ; 400 et 404 ; clé absente de GET /roles/menus (écran masqué) | P2 | referentiels/geolocalisation.spec.ts |
| SOC-69 | Lecture partagée, écriture par menu | Rôle [/admin/dossiers] | GET et exports des 4 référentiels ; écritures sur types, plans, lieux, file-types ; écritures sur dossiers ; barre latérale ; écran Types par URL | 200 ; 403 ×10 ; dossiers 201/200/200 ; « Types de document » absent du menu ; cible : écran « Accès refusé » | P1 | referentiels/permissions.spec.ts (fixme « en attente du lot transverse : écran Accès refusé » pour l'écran) |

## Paramétrage e-mail (sans SMTP)

| Id | Scénario | Préconditions | Étapes | Résultat attendu | Priorité | Spec |
|---|---|---|---|---|---|---|
| SOC-70 | Enregistrer l'identité et la retrouver après rechargement | Admin | Saisir organisation, e-mail et site, Enregistrer, recharger ; vider un champ | PUT 200 et « Paramétrage enregistré » ; aperçu mis à jour pendant la saisie ; valeurs relues ; un champ vidé devient null | P1 | parametres/email-template.spec.ts |
| SOC-71 | Saisie invalide bloquée par l'écran | Admin | E-mail invalide ; site `ftp://…` puis `www.…` | Messages de validation ; aucun PUT émis | P2 | parametres/email-template.spec.ts |
| SOC-72 | Validation de l'API, mise à jour partielle | Admin | PUT d'URL invalides, d'e-mail invalide, de 201 caractères, de clé hors contrat ; PUT partiel | 400 sans écriture ; champ absent conservé ; chaîne blanche devient null | P2 | parametres/email-template.spec.ts |
| SOC-73 | Déposer un logo PNG | Admin, aucun logo | Envoyer un PNG de 1 px, recharger | POST 201 et « Logo mis à jour » ; image affichée ; boutons « Remplacer » et « Retirer » | P1 | parametres/email-template.spec.ts |
| SOC-74 | Logo refusé (format, poids, absence) | Admin | API puis écran : SVG ; 1 Mo + 1 octet ; aucun fichier | 400 avec message exact ; à l'écran, message lisible et aucun POST | P2 | parametres/email-template.spec.ts |
| SOC-75 | Retirer le logo après confirmation | Logo déposé | « Retirer » puis Annuler ; « Retirer » puis confirmer | Annuler : aucun DELETE ; confirmer : DELETE 200, « Logo retiré », GET du logo en 404 | P1 | parametres/email-template.spec.ts |
| SOC-76 | Accès refusé sans le menu | Utilisateur [/search] ; délégué titulaire du menu | 4 appels API ; barre latérale ; accès direct | 403 ×4 ; logo public toujours en 200 ; le délégué peut paramétrer ; pas de section Administration ; GET du paramétrage en 403 à l'ouverture ; cible : écran « Accès refusé » | P1 | parametres/email-template.spec.ts (fixme « en attente du lot transverse : écran Accès refusé » pour l'écran) |
| SOC-77 | Le GET du logo est public | Logo déposé, puis retiré | Client sans jeton | Paramétrage 401 (témoin) ; logo 200 `image/png` avec cache public ; sans logo, 404 | P1 | parametres/email-template.spec.ts |

## Tableaux de bord

| Id | Scénario | Préconditions | Étapes | Résultat attendu | Priorité | Spec |
|---|---|---|---|---|---|---|
| SOC-78 | Agencement par défaut | Nouvel utilisateur avec /dashboards | Connexion, ouvrir /dashboards | `parDefaut` vrai, 5 widgets aux positions livrées, période de 30 jours | P1 | dashboards/dashboards-ui.spec.ts |
| SOC-79 | Le filtre de période relance l'agrégat | Idem | « 7 j », « Année », « Aujourd'hui », « Perso. », puis Personnaliser | Requêtes overview aux bonnes bornes ; filtre masqué en mode édition | P2 | dashboards/dashboards-ui.spec.ts |
| SOC-80 | Ajouter un widget par la modale | Agencement sans `evolution` | Personnaliser, Ajouter un widget, Ajouter, Enregistrer, recharger | Seul le widget absent est proposé ; PUT 200 et « Tableau de bord enregistré » ; widget conservé | P1 | dashboards/dashboards-ui.spec.ts |
| SOC-81 | Retirer un widget ; Annuler sans effet | Agencement par défaut | Retirer puis Annuler ; Retirer puis Enregistrer, recharger | Annuler : aucun PUT ; Enregistrer : retrait conservé | P1 | dashboards/dashboards-ui.spec.ts |
| SOC-82 | Disposition personnalisée conservée | Disposition posée par l'API | PUT de positions, GET, ouvrir l'écran | Positions relues à l'identique, ordre respecté à l'écran | P1 | dashboards/dashboards-ui.spec.ts (glisser-déposer en fixme P3) |
| SOC-83 | Réinitialiser | Disposition « kpis seul » | Personnaliser, Réinitialiser | DELETE 200, « Agencement par défaut rétabli », 5 widgets | P1 | dashboards/dashboards-ui.spec.ts |
| SOC-84 | Isolation entre utilisateurs | Deux nouveaux utilisateurs | A personnalise ; B lit, personnalise, réinitialise | B garde le défaut ; A reste intact | P1 | dashboards/dashboards-api.spec.ts |
| SOC-85 | PUT layout : filtrage, bornes, refus | Utilisateur avec /dashboards | Widget inconnu, doublon, tailles minimales, corps mal formés, liste vide, x + w > 12 | Inconnu écarté, doublon fusionné, minima appliqués ; 400 sans écriture ; liste vide ramène le défaut ; x + w ≤ 12 | P2 | dashboards/dashboards-api.spec.ts (le cas x + w en fixme « en attente du lot transverse » : `common/agencement.service.ts`, A-D3) |
| SOC-86 | Sans /dashboards : 403 sur l'agencement ; droit rendu, disposition retrouvée | Utilisateurs restreints | GET/PUT/DELETE ; retrait puis restitution du droit | 403 ×3 ; disposition intacte après restitution | P1 | dashboards/dashboards-api.spec.ts |
| SOC-87 | Sans /dashboards : statistiques refusées ; accueil | Utilisateur [/search] | POST overview, targets, export ; puis menu accordé ; connexion | 403 ×3, puis 200 ×3 avec le même jeton (décision du 2026-11-22). Cible écran : pas de redirection vers /dashboards ni d'entrée au menu, « Accès refusé » par URL | P1 | dashboards-api.spec.ts ; dashboards-ui.spec.ts (fixme « en attente du lot transverse : écran Accès refusé », A-D6) |
| SOC-88 | Export et validation des filtres | Admin | Export csv, xlsx, pdf ; filtres invalides | Bon type de contenu ; 400 (jamais 500) pour un format ou une date inexistante ; 29/02/2024 accepté | P2 | dashboards/dashboards-api.spec.ts |

## Journal d'audit

| Id | Scénario | Préconditions | Étapes | Résultat attendu | Priorité | Spec |
|---|---|---|---|---|---|---|
| SOC-89 | Consultation du journal | — | PUT du gabarit, puis lecture du journal | Action tracée | P3 | audit/journal-audit.spec.ts (fixme : aucun écran ni API de consultation ; le gabarit et l'agencement n'écrivent pas au journal) |
