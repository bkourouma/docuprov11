# Docu-GED — Espaces de travail et versions (lot 4a)

Ce document décrit ce que fait le code de la copie de travail `ged-ia-lot-6`, lu directement dans les sources. Il ne décrit aucune exécution sur une base réelle : les règles SQL et les réponses HTTP n'ont été vérifiées que par les tests unitaires décrits en section 10.

Un espace regroupe des documents SANS les déplacer : le classement (dossier, plan) reste celui du document. Un espace n'ouvre jamais un document : chaque lecture ou rattachement passe par la règle documentaire existante (`DocumentsService.canAccess`).

## 1. Vue d'ensemble

- **Espaces** (module `apps/api/src/modules/spaces/`) : création, modification, suppression logique, membres, rattachement de documents, publication par slug.
- **Versions** (module `apps/api/src/modules/doc-versions/`) : dépôt d'une nouvelle version PDF, historique, restauration, ouverture du fichier d'une version. Ces routes sont rangées dans le même lot (commit `2d82d97`).
- **Contrat partagé** : `packages/types/src/ged-spaces.ts` (interfaces) et `packages/types/src/ged.ts` (énumérations `GedSpaceKind`, `GedSpacePermission`, `GedVersionChangeKind`, libellés).
- **Écrans** : `apps/web/app/espaces/` (liste, détail, publication) et l'onglet « Versions » de la fiche document.
- **Principe** : refus par défaut. Un espace non visible répond 404 ; un espace visible sans le droit requis répond 403.

## 2. Modèle de données

Schéma : `packages/db/prisma/models/ged.prisma` (section « 5. Espaces et versions », lignes 313 à 411). Migration : `packages/db/prisma/migrations/20261120120000_add_ged_ia_foundations/migration.sql` (lignes 171 à 222 pour les tables, 488 à 522 pour les contraintes). Copie SQL ré-exécutable : `packages/db/prisma/sql/ged.sql`.

| Table | Colonnes utiles | Contraintes notables |
| --- | --- | --- |
| `ged_space` | `ged_space_id`, `label` (200), `description`, `kind` (0 à 3), `owner_user_group_id`, `publication_slug` (120, unique), `published_at`, `is_active`, `created_at`, `updated_at` | `ck_ged_space_kind` (0 à 3) ; `ck_ged_space_publication` : un slug n'existe que si `kind = 3` et respecte une regex SQL |
| `ged_space_member` | `ged_space_member_id`, `space_id`, `user_group_id` ou `role_id`, `permission` (0 à 2), `added_by`, `added_at` | `ck_ged_space_member_grantee` : exactement un bénéficiaire ; uniques partiels `ux_ged_space_member_user` et `ux_ged_space_member_role` ; suppression en cascade avec l'espace |
| `ged_space_document` | `space_id`, `document_id`, `added_by`, `added_at` | Clé primaire composite `(space_id, document_id)` ; cascade depuis l'espace et le document |
| `ged_version_info` | `document_version_id` (unique, 1-1 avec `document_version`), `space_id` (nullable), `content_hash` (SHA-256), `change_kind` (0 à 4), `change_summary`, `source_item_id`, `ai_decision_id`, `restored_from_version_id`, `created_at` | `ck_ged_version_info_change_kind` (0 à 4) ; `ck_ged_version_info_hash` ; `ck_ged_version_info_restore` : une restauration seulement (`change_kind = 3`) |

Points à connaître :

- `document_version` existe déjà et n'est pas modifiée par le lot ; les attributs GED (empreinte, nature du changement, restauration) vivent dans `ged_version_info` (`ged.prisma:385-389`).
- Les colonnes d'auteur (`added_by`, `created_by`) n'ont pas de clé étrangère : ce sont des traces (`ged.prisma:355`, `374`).
- Une suppression d'espace est LOGIQUE : `is_active = false`, slug libéré (section 8). Les lignes de membres et de rattachement restent.
- Le schéma ne possède pas de colonne « version d'espace » : un espace n'a pas d'historique propre, seulement le journal d'audit (section 4).
- `ged_version_info.space_id` existe, mais `doc-versions.service.ts` ne le renseigne jamais (recherche de `spaceId` : aucun résultat dans ce module). La colonne est donc inutilisée par ce lot.

## 3. Rôles de membres et règles d'accès

### 3.1 Natures d'espace

Énumération : `packages/types/src/ged.ts:147-160`.

| Valeur | Nature | Qui y accède |
| --- | --- | --- |
| 0 | Privé | Le propriétaire seul |
| 1 | Partagé | Propriétaire et membres |
| 2 | Collaboration | Propriétaire et membres (les contributeurs rattachent et détachent) |
| 3 | Publication | Lecture pour tout utilisateur authentifié ayant le menu `/espaces` (section 4) |

Un espace publié (3) ne change pas de nature sans dépublication (`space-access.ts:176-180`, `spaces.service.ts:427-432`).

### 3.2 Permissions de membre

`GedSpacePermission` (`packages/types/src/ged.ts:163-174`) : **0 Lecture**, **1 Contribution**, **2 Gestion**.

Un membre est un compte-groupe OU un rôle actif (`ck_ged_space_member_grantee`). Si la personne cumule plusieurs lignes qui la visent, la permission la plus haute s'applique (`space-access.ts:87-100`).

### 3.3 Matrice de décision

Source : `apps/api/src/modules/spaces/domain/space-access.ts`, fonction `resolveSpaceAccess` (lignes 133-160). L'ordre est celui du code.

| Acteur | Privé (0) | Partagé / Collaboration (1, 2) | Publication (3) |
| --- | --- | --- | --- |
| Espace inactif (supprimé) | Invisible, y compris pour le propriétaire | Invisible | Invisible |
| Propriétaire (un de SES comptes-groupes) | Propriétaire : tous les droits | Propriétaire : tous les droits | Propriétaire : tous les droits |
| Membre lecture (0) | Invisible (membres résiduels ignorés) | Lecture seule | Lecture seule, membre conservé |
| Membre contribution (1) | Invisible | Lecture + rattachement / détachement | Idem, portée documentaire complète |
| Membre gestion (2) | Invisible | Gestion : modifier, membres, publier, dépublier, détacher sans `canAccess` | Idem |
| Administrateur non membre | Invisible (aucun passe-droit) | Lecture seule (`access: null`) | Lecture seule |
| Autre utilisateur authentifié | Invisible | Invisible (404) | Lecture seule, portée documentaire publique |

Droits dérivés (`decisionFor`, lignes 102-116) :

- contribuer : propriétaire ou permission >= 1 ;
- gérer (modifier, membres, publier, dépublier) : propriétaire ou permission >= 2 ;
- supprimer : propriétaire seul (`canDelete`).

Contrôle côté service : `SpacesService.authorize` (`spaces.service.ts:194-214`). Non visible : 404 « Espace introuvable ». Droit insuffisant : 403 avec un message précis.

### 3.4 Lien avec les droits documentaires

L'appartenance à un espace ne donne JAMAIS accès à un document (`space-access.ts:6-8`, `spaces.service.ts:141-143`). Deux règles s'appliquent :

1. **Vue d'un document dans un espace** : `isDocumentListable` (`space-access.ts:166-174`). `canAccess` prime toujours. En portée publique (lecteur d'une publication sans appartenance), un document avec confidentialité est exclu même s'il est accessible.
2. **Rattacher** : il faut le droit de contribution sur l'espace ET `DocumentsService.canAccess` sur le document. Un document inexistant ou refusé répond 404 « Document introuvable », sans révéler son existence (`spaces.service.ts:744-746`).

`DocumentsService.canAccess` (`apps/api/src/modules/documents/documents.service.ts:58-87`) : administrateur et agent de numérisation passent toujours ; sinon droits par document et par type (`isVisibleByPermissions`), créateur, droit nominatif, puis confidentialité par rang.

Détacher (`spaces.service.ts:779-796`) : propriétaire ou gestionnaire détachent sans `canAccess` (ils doivent pouvoir retirer une pièce devenue invisible pour eux, sans rien y lire). Un simple contributeur doit passer `canAccess`, sinon 404.

Les versions d'un document relèvent d'une autre règle : écrire exige le niveau 3 sur le document (section 5), pas le rôle de l'espace.

### 3.5 Administrateur

- Pas de droit implicite de gestion sur les espaces d'autrui (`space-access.ts:125-128`) : lecture seule sur les espaces 1 à 3.
- Espace privé d'autrui : invisible, même pour l'administrateur (`space-access.ts:43-49`, test `spaces.service.spec.ts:564-567`).
- Le menu `/espaces` est accordé à l'administrateur par `MenuPermissionGuard` (`apps/api/src/modules/auth/menu-permission.guard.ts`, `if (user.isAdmin) return true`).

### 3.6 Droits de menu

Tous les endpoints de `SpacesController` portent `@UseGuards(MenuPermissionGuard)` et `@RequireMenu('/espaces')` (`spaces.controller.ts:50-51`, `spaces.menus.ts`). Le menu est aussi déclaré dans `apps/api/src/modules/roles/menu-catalog.ts:55` et `apps/web/app/components/nav.ts:53-58`. L'accès au menu est donc une première barrière, avant les règles d'espace.

Les endpoints de versions (`DocVersionsController`) n'ont PAS de garde de menu : ils s'appuient uniquement sur les droits documentaires (`doc-versions.controller.ts`).

## 4. Publication

Clarification : la publication porte sur l'ESPACE entier (nature 3 et slug), jamais sur un document isolé. Les documents visibles d'un espace publié sont ceux que le lecteur peut ouvrir, filtrés par la portée publique (section 3.4).

### 4.1 Qui peut publier et dépublier

- Publier et dépublier : propriétaire ou gestionnaire (`spaces.service.ts:819`, `865`).
- Un espace privé ne se publie pas (409 : « partagez-le d'abord ») : `canPublish` (`space-access.ts:183-189`), `spaces.service.ts:820-824`.
- Un espace déjà publié peut être republié avec un autre slug.

### 4.2 Lecture d'une publication : authentification obligatoire

- Le garde JWT global (`apps/api/src/modules/auth/jwt-auth.guard.ts`, enregistré dans `apps/api/src/app.module.ts:83` par `APP_GUARD`) refuse toute requête sans jeton, sauf routes marquées `@Public()`.
- `SpacesController` et `getPublished` ne portent AUCUN `@Public()` ; le test `spaces.service.spec.ts:886-892` le vérifie.
- En plus, `GET /spaces/published/:slug` exige le menu `/espaces` (section 3.6). Un utilisateur authentifié sans ce menu ne lit donc pas la publication.
- Aucune route anonyme ni lien public n'existe dans le code de ce lot.
- Le slug invalide, inconnu ou d'un espace dépublié répond 404 (`spaces.service.ts:403-422`).
- Chaque lecture par slug est journalisée (`audit.navigation`, activité `open published space`).

### 4.3 Documents d'une publication

- `GET /spaces/:id/documents` pour un lecteur non membre : seuls les documents SANS confidentialité ET accessibles par `canAccess` sont listés (`space-access.ts:157`, `isDocumentListable`).
- Publier ne rend donc jamais visible un document dont la confidentialité l'interdit (commentaire `space-access.ts:41-43`).
- Le nombre de documents retournés à la publication (`nonPublishableCount`) est documenté en section 9.

## 5. Versions

Routes : `apps/api/src/modules/doc-versions/doc-versions.controller.ts`. Service : `doc-versions.service.ts`. Empreinte : `domain/version-hash.ts`.

### 5.1 Création

`POST /documents/:id/versions` (multipart, champ `file`, champs texte `changeSummary` et `comment`).

- Accès : `canAccess` (404 sinon), niveau effectif >= 3 « Modification » (403 sinon ; `MIN_WRITE_LEVEL`, `doc-versions.service.ts:39`).
- Refus 409 si le document est gelé (`is_frozen`) ou épuré (`document_state = 3`) (`assertCanModify`, lignes 292-312).
- Fichier : 100 Mio au plus (`doc-versions.dto.ts:4`), contenu commençant par `%PDF-` (`validateUpload`, lignes 314-324). Vide ou non PDF : 400.
- Contenu identique à la version courante (même empreinte) : 409 « Contenu identique à la version courante » (lignes 165-168).
- La nouvelle version reçoit une seule pièce PDF (lignes 170-189), nature `Modification` (1), commentaire et résumé facultatifs.
- Ordre d'écriture, décrit en commentaire (lignes 364-372) : lignes créées non courantes, puis binaires sur le coffre, puis bascule `is_current`. En cas d'échec, les binaires et les lignes de la nouvelle version sont retirés ; l'ancienne version reste courante.
- Audit : `version-created:vN` sur l'objet `document:<id>`.
- La réponse est la version complète, avec le code HTTP par défaut de POST.

### 5.2 Historique

`GET /documents/:id/versions` : accès par `canAccess` seulement.

- Tri : numéro de version décroissant.
- Les versions antérieures à la GED (sans `ged_version_info`) sont complétées : nature déduite (1 = Création, sinon Modification), empreinte de la pièce unique (`toRow`, lignes 488-516).
- Chaque version expose : numéro, version courante ?, validée ? (lecture seule ici), commentaire, auteur, nature et résumé, empreinte SHA-256, numéro de la version restaurée, pièces (identifiant, nom, extension, taille, pages).
- L'onglet « Historique » de la fiche document (`apps/web/app/documents/[documentId]/page.tsx:371-372`) est un AUTRE objet : le journal d'activité du document, pas l'historique des versions.

### 5.3 Restauration

`POST /documents/:id/versions/:versionId/restore` (corps facultatif `{ changeSummary }`, réponse 201).

- Mêmes garde-fous que la création (accès, niveau 3, non gelé, non épuré).
- Refus 404 si la version n'appartient pas au document ; 409 si c'est déjà la version courante, si elle n'a aucune pièce, ou si un binaire manque sur le coffre (rien n'est écrit dans ce cas).
- Tous les binaires sources sont lus AVANT toute écriture (lignes 243-267).
- Une NOUVELLE version est créée (nature `Restauration` = 3, `restored_from_version_id` renseigné). Aucune version n'est réécrite ni supprimée.
- Les pièces copiées gardent leur type, nom, extension, pages, OCR, redaction et protection PDF (lignes 254-266).
- Empreinte de la nouvelle version : calculée sur les pièces copiées (`computeVersionHash`).
- Audit : `version-restored:vN` `from:vM`.
- Le texte de confirmation de l'écran dit « restaurer ne réécrit jamais l'historique » (`apps/web/app/components/documents/VersionsTab.tsx:14-18`).

### 5.4 Ouverture du contenu

`GET /documents/:id/versions/:versionId/files/:fileId/content` : accès par `canAccess`, puis fichier de la version (404 sinon) et présence sur le coffre (404 sinon). Le flux est renvoyé avec le type `application/pdf` (`doc-versions.service.ts:145-147`).

### 5.5 Empreinte de version

Fichier : `apps/api/src/modules/doc-versions/domain/version-hash.ts`.

- Une seule pièce : son SHA-256 tel quel.
- Plusieurs pièces : SHA-256 de la concaténation des empreintes, séparées par un retour à la ligne, dans l'ordre `sort_order`.
- Aucune pièce : erreur.

### 5.6 Ce qui n'est pas implémenté

- Aucune suppression de version, aucune fusion, aucune comparaison de versions (recherche de `diff` ou `compare` : rien dans le module).
- Aucune route pour valider une version : le champ `isValidated` est seulement lu ; il est écrit ailleurs (`documents.service.ts:442`).
- Aucune extraction de texte ni OCR déclenchés à la création d'une version (`ged-recherche.md:28` : « Pas de hook dans doc-versions »).
- La nature `ModificationIa` (4) est définie dans le contrat et le schéma, mais aucun écrivain ne la produit dans le code recherché (`change_kind = 4` absent).
- Les natures `SynchroSource` (2) ne sont pas non plus produites ici ; la synchronisation des connecteurs n'écrit pas `ged_version_info` dans le code recherché.
- Écrivains trouvés de `ged_version_info` : `doc-versions.service.ts` (natures 1 et 3) et `collab/persistence/collab-persistence.service.ts` (natures 0 et 1, lot 4b).

## 6. Endpoints REST

Préfixe global `/api` (`apps/api/src/main.ts:46`). Toutes les routes exigent un JWT (garde global).

### 6.1 Espaces (`SpacesController`, `apps/api/src/modules/spaces/spaces.controller.ts`)

Toutes ces routes exigent le menu `/espaces`.

| Méthode et route | Droit requis | Effet | Réponses d'erreur notables |
| --- | --- | --- | --- |
| `GET /spaces` | Menu | Espaces actifs visibles de l'acteur | Aucune |
| `POST /spaces` | Menu, un groupe par défaut | Crée un espace (nature 0 à 2) ; propriétaire = groupe par défaut | 403 sans groupe ou identité machine ; 400 si corps invalide |
| `GET /spaces/member-candidates` | Propriétaire ou gestionnaire d'un espace partagé actif | Utilisateurs actifs (un groupe chacun) et rôles actifs | 403 sinon |
| `GET /spaces/published/:slug` | Menu + authentification | Lecture d'une publication par slug (journalisée) | 404 |
| `GET /spaces/:id` | Lecture | Détail, membres si gestionnaire, compte des documents VISIBLES si gestionnaire | 404 invisible |
| `PATCH /spaces/:id` | Gestion | Libellé, description, nature (sans nature 3) | 409 si publié ; 403 privatiser sans être propriétaire |
| `DELETE /spaces/:id` | Propriétaire | Suppression logique, slug libéré | 403 pour un gestionnaire |
| `GET /spaces/:id/members` | Gestion | Liste des membres | 400 si espace privé |
| `POST /spaces/:id/members` | Gestion | Ajoute un utilisateur (`userGroupId`) OU un rôle (`roleId`) | 400 privé, utilisateur absent ou désactivé, rôle inactif ; 409 doublon ou propriétaire |
| `PATCH /spaces/:id/members/:memberId` | Gestion | Change la permission | 404 si le membre n'est pas de cet espace |
| `DELETE /spaces/:id/members/:memberId` | Gestion | Retire un membre | 404 |
| `GET /spaces/:id/documents` | Lecture | Documents visibles, pagination `limit` (1 à 200, 100 par défaut) et `offset` | Aucun total renvoyé |
| `POST /spaces/:id/documents` | Contribution + `canAccess` | Rattache un document | 404 document inaccessible ; 409 déjà rattaché |
| `DELETE /spaces/:id/documents/:documentId` | Contribution (+ `canAccess` pour un simple contributeur) | Détache (le document reste intact) | 404 |
| `POST /spaces/:id/publish` | Gestion | Publie avec slug facultatif (200) | 409 privé, slug déjà pris |
| `POST /spaces/:id/unpublish` | Gestion | Repasse en Partagé, slug libéré (200) | 409 si non publié |

Schémas de corps : `apps/api/src/modules/spaces/spaces.dto.ts` (zod, `.strict()`). Le slug (`slugSchema`, lignes 58-63) : 3 à 120 caractères, minuscules, chiffres et tirets.

### 6.2 Versions (`DocVersionsController`, `apps/api/src/modules/doc-versions/doc-versions.controller.ts`)

Pas de garde de menu ; droits documentaires uniquement.

| Méthode et route | Droit requis | Effet |
| --- | --- | --- |
| `GET /documents/:id/versions` | `canAccess` | Historique complet, plus récent d'abord |
| `POST /documents/:id/versions` | `canAccess` + niveau >= 3, non gelé, non épuré | Dépose une nouvelle version PDF (multipart) |
| `POST /documents/:id/versions/:versionId/restore` | Idem | Crée une nouvelle version à partir d'une ancienne (201) |
| `GET /documents/:id/versions/:versionId/files/:fileId/content` | `canAccess` | Flux du fichier de la version |

## 7. Écrans web

| Écran | Fichier | Contenu |
| --- | --- | --- |
| Liste des espaces `/espaces` | `apps/web/app/espaces/page.tsx` | Tableau (libellé, type, propriétaire, documents, membres, publication, « Mon droit »), recherche et filtre de type côté client, bouton « Nouvel espace » qui ouvre le formulaire de création, puis le détail de l'espace créé |
| Détail `/espaces/[spaceId]` | `apps/web/app/espaces/[spaceId]/page.tsx` | En-tête et actions selon `canManage` / `canContribute` / propriétaire ; onglets « Documents (n) » (rattacher, détacher) et « Membres » (ajout, changement de droit, retrait) |
| Publication `/espaces/publie/[slug]` | `apps/web/app/espaces/publie/[slug]/page.tsx` | Lecture seule : aucun bouton, pas de colonne d'action, documents filtrés par l'API |
| Formulaire d'espace | `apps/web/app/components/espaces/SpaceFormModal.tsx` | Création et modification ; nature choisie parmi 0 à 2 ; aide par type (`KIND_HELP`) ; nature figée pour un espace publié |
| Modales de publication et de rattachement | `apps/web/app/espaces/[spaceId]/page.tsx` (`PublishModal`, `AttachModal`) | Slug facultatif ; recherche de documents par libellé via `/documents/search` |
| Badges et compteurs | `apps/web/app/components/espaces/SpaceBadges.tsx`, `SpaceCount.tsx`, `SpaceDocumentsTable.tsx` | Présentation |
| Client API | `apps/web/app/lib/espaces.ts` | `espacesApi` (un appel par route), `KIND_HELP`, `EDITABLE_KINDS`, `publicPath` |
| Onglet « Versions » de la fiche document | `apps/web/app/components/documents/VersionsTab.tsx`, monté par `apps/web/app/documents/[documentId]/page.tsx:360-366` | Chronologie, dépôt PDF (bouton si `canIndex`, c'est-à-dire niveau >= 3), restauration avec confirmation, ouverture du PDF, copie du SHA-256 |
| Client versions | `apps/web/app/lib/doc-versions.ts` | `docVersionsApi` (dépôt en `FormData`, ouverture par blob avec jeton) |

Entrée vers l'éditeur : le bouton « Nouveau document » du détail mène à `/editeur/nouveau?spaceId=<id>` (visible pour les contributeurs). Ce lot ne crée pas le document ; c'est le lot 4b/4c (`docs/ged-redaction.md`).

La fiche document n'affiche pas les espaces qui la contiennent (aucune référence à `espaces` dans `apps/web/app/documents/[documentId]/page.tsx`).

Menu de navigation : `apps/web/app/components/nav.ts:53-58`, libellé « Espaces ».

## 8. Décisions métier relevées dans le code

Chaque point est tiré d'un commentaire, d'une constante ou d'un test. Aucune n'a été inventée ; le statut « validée » n'est pas écrit dans le code, il est repris ici tel qu'il est codé.

1. **Espace privé = propriétaire seul.** Ni l'administrateur ni un ancien membre n'y accèdent (`space-access.ts:3`, `:123`, `:141`; tests `spaces.service.spec.ts:556-587`).
2. **Administrateur en lecture seule** sur les espaces 1 à 3 d'autrui, présenté comme « choix prudent et réversible » (`space-access.ts:125-128` ; test `space-access.spec.ts:114-124`).
3. **Publication = lecture seule**, pour tout authentifié, avec portée documentaire publique (`space-access.ts:129`, `:157`).
4. **Publier ne rend jamais visible un document confidentiel** (`space-access.ts:41-43` ; `isDocumentListable`, `:166-174`).
5. **Appartenance ≠ droit documentaire** (`space-access.ts:6-8` ; `spaces.service.ts:141-143`).
6. **404 pour l'invisible, 403 pour le droit manquant** (`spaces.service.ts:194-214`), avec un message par cas.
7. **Compte de documents réservé au gestionnaire** : seul un nombre de documents VISIBLES est donné, jamais le compte brut (`spaces.service.ts:239-243`, `:389-394`).
8. **Les publications d'autrui ne figurent pas dans le listing** : elles se lisent par slug (`spaces.service.ts:327-332`, « choix prudent »).
9. **Détacher** : gestionnaire sans `canAccess`, contributeur avec (`spaces.service.ts:773-778`).
10. **Suppression logique**, slug libéré, documents intacts (`spaces.service.ts:466-467` ; test `spaces.service.spec.ts:1042-1051`).
11. **Seul le propriétaire supprime** ou rend un espace privé (`spaces.service.ts:210-211`, `:435-437`).
12. **Publication exige un espace partagé** (`canPublish`, `space-access.ts:183-189`).
13. **Pas de changement de nature d'un espace publié** sans dépublication (`canChangeKind`, `space-access.ts:176-180`).
14. **Dépublier** : retour à Partage, slug libéré et réutilisable (`spaces.service.ts:864-881` ; test `spaces.service.spec.ts:924-936`).
15. **Lecture par slug jamais anonyme** ; route sans `@Public()` et menu exigé (`spaces.controller.ts:42-47` ; test `spaces.service.spec.ts:886-892`).
16. **Slug** : minuscules, sans accents, tirets réduits ; suffixe `-2`, `-3`… si pris (`space-slug.ts:14-38`).
17. **Pagination avant le filtre documentaire** : une page ne contient que des documents visibles, sans trou ni total (`spaces.service.ts:721-726`).
18. **Pagination par défaut** : 100 documents, plafond 200 (`spaces.dto.ts:72-75`).
19. **Restaurer = nouvelle version**, jamais une réécriture de l'historique (`VersionsTab.tsx:14-18`, `doc-versions.service.ts:269-278`).
20. **Niveau 3 « Modification »** requis pour écrire une version (`doc-versions.service.ts:38-39`) ; le bouton de l'écran est masqué sous ce niveau (`documents/[documentId]/page.tsx:188`, `:365`).
21. **Document gelé ou épuré : pas de nouvelle version** (`doc-versions.service.ts:303-311`).
22. **Un contenu identique à la version courante est refusé** (`doc-versions.service.ts:165-168`).
23. **Seuls les PDF sont déposés**, contrôle sur la signature et non sur le nom (`doc-versions.service.ts:319-322`).
24. **Empreinte de version** : une pièce = son SHA-256 ; plusieurs = hachage de la liste ordonnée (`version-hash.ts:8-16`).
25. **Limite de dépôt** : 100 Mio (`doc-versions.dto.ts:3-4`).

## 9. Limites connues et incohérences relevées

### 9.1 Incohérences entre commentaires et code

- **Schéma et publication anonyme.** `packages/db/prisma/models/ged.prisma:319-321` décrit la publication comme « diffusé, éventuellement hors authentification via publicationSlug ». Le code ne permet AUCUNE lecture anonyme (section 4.2 ; `spaces.service.spec.ts:886-892`). Le commentaire du schéma est donc faux pour ce lot et devrait être corrigé.
- **Compte des documents confidentiels à la publication.** `spaces.service.ts:856-858` compte TOUS les documents rattachés ayant une confidentialité, sans tenir compte de ce que l'appelant peut voir. Le commentaire de `spaces.service.ts:239-243` dit au contraire qu'un compte brut révèle l'existence de documents masqués. Un gestionnaire sans droit sur un document confidentiel obtient ainsi un compte qui le lui révèle. Le champ `nonPublishableCount` devrait être calculé sur les documents visibles de l'appelant, ou son usage précisé.
- **Publier un espace privé est proposé à l'écran.** `apps/web/app/espaces/[spaceId]/page.tsx:221` affiche « Publier » sans tester la nature ; l'API répond alors 409 (`spaces.service.ts:820-824`). Un bouton masqué pour la nature 0 éviterait l'erreur.

### 9.2 Points à confirmer (non tranchés dans le code)

- **Documents épurés ou gelés dans un espace.** Le rattachement (`spaces.service.ts:737-768`) et le listing (`visibleDocuments`, `:687-719`) ne testent ni `document_state` ni `is_frozen`. `DocumentsService.canAccess` (`documents.service.ts:58-87`) ne le fait pas non plus. La recherche, elle, exclut épurés et gelés (`docs/ged-recherche.md:36`, `:73`). Un document épuré peut donc apparaître dans un espace. Aucun commentaire ne tranche.
- **Membres conservés lors de la privatisation.** Passer un espace en privé ne supprime pas ses lignes de membres (`spaces.service.ts:433-437`) ; elles sont seulement ignorées (`space-access.ts:141`). Repasser l'espace en partagé les rendra donc à nouveau actifs. Le test `spaces.service.spec.ts:474` l'indique sans dire si c'est voulu.
- **Propriétaire et autre compte-groupe.** `addMember` refuse seulement le compte-groupe exact propriétaire (`spaces.service.ts:511`). Un autre compte-groupe de la même personne peut être ajouté comme membre ; la règle « propriétaire d'abord » le rend sans effet, mais la contrainte n'est pas uniforme.
- **Nouvelle version d'un document multi-pièces.** `create` (`doc-versions.service.ts:170-189`) produit une version à UNE pièce, prise sur la première pièce de la version courante. Les autres pièces ne sont pas reprises. Le commentaire ne dit pas si c'est voulu.
- **OCR absent de la nouvelle version.** La pièce créée n'a pas d'`ocrText` (lignes 170-189). Comme aucun hook n'existe (`docs/ged-recherche.md:28`), la recherche ne voit pas le nouveau contenu tant qu'aucun traitement n'est lancé ailleurs. Ce point n'est pas traité par ce lot.
- **Type de contenu fixe.** `openFileContent` renvoie toujours `application/pdf` (`doc-versions.service.ts:145-147`), alors que le contrat accepte des extensions variées (la restauration recopie `fileExtension`). Un fichier non PDF serait mal typé.
- **Édition de membres sur un espace privé.** Le serveur refuse (400) et l'écran affiche un message dédié (`[spaceId]/page.tsx:350-354`). Cohérent, mais à confirmer comme règle.

### 9.3 Limites techniques

- **Pas de pagination côté écran.** Le détail charge `GET /spaces/:id/documents` sans paramètres (`apps/web/app/lib/espaces.ts:69`) : au-delà de 100 documents visibles, les suivants ne sont pas affichés. Le titre « Documents (n) » compte la page chargée (`[spaceId]/page.tsx:306-310`).
- **Coût du compte de documents.** Pour un gestionnaire, `getDetail` appelle `canAccess` sur chaque document rattaché (`spaces.service.ts:392-394`, `visibleDocuments`). Coût linéaire, par lots de 10.
- **Limite de débit.** Aucune sur les routes d'espaces ou de versions (aucun `Throttle` ni `429` dans ces modules ; la recherche IA en a une, `docs/ged-recherche.md:50`).
- **Provider dupliqué.** `SpacesModule` et `DocVersionsModule` déclarent chacun `DocumentsService` (`spaces.module.ts:9-12`, `doc-versions.module.ts`). Le commentaire justifie l'absence d'état partagé ; c'est un choix, non une erreur.
- **Versions : pas de menu.** Un utilisateur authentifié sans menu `/espaces` peut lire et déposer des versions selon ses seuls droits documentaires. C'est cohérent avec la règle « accès documentaire seul », à confirmer.
- **Contrainte SQL plus lâche que le code.** `ck_ged_space_publication` (migration, lignes 494-495) accepte des slugs comme `a--b` que `SLUG_PATTERN` (`space-slug.ts:5`) refuse. Le code est plus strict, sans risque, mais les deux règles divergent.
- **Publication : slug côté écran.** La page publique accepte des lettres majuscules et des soulignements (`publie/[slug]/page.tsx:29`), que l'API refuse ensuite par 404. Sans gravité.

## 10. Tests et commandes

Tests présents :

- `apps/api/src/modules/spaces/spaces.service.spec.ts` (faux Prisma en mémoire qui applique les filtres ; couvre visibilité, 403/404, documents, pagination, publication, membres, audit, candidats).
- `apps/api/src/modules/spaces/domain/space-access.spec.ts` (décision pure, portée documentaire, slugs).
- `apps/api/src/modules/spaces/spaces.dto.spec.ts` (schémas zod).
- `apps/api/src/modules/doc-versions/doc-versions.service.spec.ts` (listing, création, restauration, accès refusé, ouverture du fichier).
- `apps/api/src/modules/doc-versions/domain/version-hash.spec.ts` (empreintes).

Commande exécutée pour ce document, depuis `apps/api` :

```
npx jest src/modules/spaces src/modules/doc-versions
```

Résultat : 5 suites réussies, 120 tests réussis (les fichiers de logs « disque plein » affichés pendant l'exécution proviennent d'un test volontairement en échec côté disque).

Commandes générales du dépôt : `apps/api/package.json` définit `test` (`jest`), `lint` (`eslint "src/**/*.ts"`) ; `apps/web/package.json` définit `lint` (`next lint`) et un `test` limité à `editeur.test.ts`, `redaction.test.ts` et `app/gouvernance/gouvernance-api.test.ts`. Aucun test web ne couvre les espaces ni les versions.

Tests d'intégration : `apps/api` expose `test:e2e` (`jest --config ./test/jest-e2e.json`) ; aucun scénario d'espaces n'a été trouvé dans ce répertoire.

## 11. Non vérifié

- Aucune exécution des requêtes Prisma et SQL sur PostgreSQL : contraintes CHECK, uniques partiels, cascades et `P2002` sont lus dans le schéma et la migration, pas testés sur une base.
- Aucun parcours navigateur : les écrans n'ont pas été ouverts ; les constats de la section 7 viennent du code.
- Le comportement du coffre disque (écriture, retrait, lecture) n'est testé que par des doublures.
- Le comportement réel de la navigation et de l'audit (`audit.navigation`, `audit.dataChange`) n'a été vérifié que par des espions.
