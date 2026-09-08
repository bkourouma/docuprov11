# Plan d'implémentation — Menu « Sécurité Documentaire »

Document de portage. Il décrit **uniquement les fonctionnalités** (données, règles, écrans, API)
du menu « Sécurité Documentaire », pour pouvoir les réimplémenter à l'identique dans une autre
application, quelle que soit la technologie. Aucune consigne de design ou de mise en page.

Référence d'origine : DocuPro-V6 (API NestJS + PostgreSQL/Prisma, front Next.js).

---

## 1. À quoi sert ce menu

Il administre **qui a le droit de voir et de manipuler quel document**. Deux axes indépendants
cohabitent ; les deux doivent être implémentés, ils ne se remplacent pas.

| Axe | Question posée | Porté par | Écrans concernés |
|---|---|---|---|
| **Confidentialité** (habilitation) | *Cet utilisateur est-il assez habilité pour voir ce document ?* | un **rang** numérique comparé entre l'utilisateur et le document | « Confidentialité des utilisateurs », « Confidentialités » |
| **Permission** (niveau d'action) | *Une fois qu'il le voit, que peut-il en faire ?* | un **niveau** 1→5 accordé à un bénéficiaire | « Sécurité type document par utilisateur », « … par rôle » |

Règle d'ensemble : **l'axe confidentialité filtre l'accès (voir / ne pas voir)**, **l'axe
permission gradue les actions (lire / modifier / administrer / archiver)**. Un utilisateur doit
passer le premier avant que le second soit calculé.

---

## 2. Le menu et ses écrans

Section de menu : **« Sécurité Documentaire »**, 4 entrées.

| Libellé du menu | Route / clé de permission | Rôle fonctionnel |
|---|---|---|
| Sécurité type document par utilisateur | `/admin/securite/type-par-utilisateur` | Accorder un niveau sur un ou plusieurs **types de documents** à des **utilisateurs nommés** |
| Sécurité type document par rôle | `/admin/securite/type-par-profil` | Idem, mais à des **rôles entiers** |
| Confidentialité des utilisateurs | `/admin/securite/confidentialite-utilisateurs` | Affecter en masse un **niveau d'habilitation** aux comptes |
| Confidentialités | `/admin/securite/confidentialites` | Gérer le **référentiel** des niveaux de confidentialité |

> **Piège à connaître** : la route de l'écran « par rôle » s'appelle historiquement
> `type-par-profil`. Cette chaîne est aussi la **clé stockée en base** dans les permissions de menu
> déjà accordées. Renommer la route obligerait à migrer ces données. Dans une nouvelle application,
> choisissez la clé définitive dès le départ (`type-par-role`) et ne la changez plus.

### Contrôle d'accès au menu lui-même

Le droit d'ouvrir chaque écran est géré par le RBAC de menus de l'application :

- une table `role_menu_permission (role_id, menu_key)` liste les menus visibles par un rôle ;
- chaque écran est déclaré dans un **catalogue de menus** (clé + libellé + section) pour être
  assignable à un rôle ;
- côté serveur, chaque endpoint porte l'annotation « menu requis ». Règle appliquée :
  - administrateur global → tout autorisé ;
  - rôle « système » actif → tout autorisé ;
  - annotation « réservé admin » → refus pour les autres ;
  - annotation « menu requis » → autorisé si l'une des clés figure dans les menus du rôle ;
  - **aucune annotation → tout utilisateur authentifié** (utilisé pour les référentiels en lecture).

Principe retenu : *accès au menu ⟹ accès aux données de cet écran*, y compris aux données
appartenant à un autre écran dont la page a besoin (sinon la page s'ouvre puis échoue en 403).

---

## 3. Modèle de données

### 3.1 `confidentialite` — référentiel des niveaux d'habilitation

| Colonne | Type | Règle |
|---|---|---|
| `confidentialite_id` | entier, clé primaire, auto | |
| `label` | texte (200) | libellé affiché ; unique parmi les niveaux actifs (contrôle applicatif → erreur 409) |
| `rank` | entier | **ordre de restriction : 0 = le moins restrictif** |
| `is_active` | booléen, défaut `true` | suppression = désactivation (jamais de suppression physique) |

Valeurs de départ conseillées (espacement de 10 volontaire, pour pouvoir intercaler) :
`Public 0`, `Interne 10`, `Confidentiel 20`, `Secret 30`.

Le `rank` **n'est pas saisi par l'utilisateur** : à la création, il vaut `max(rank existant) + 10`.

Cette table est référencée par :

| Table | Colonne | Signification |
|---|---|---|
| `app_user` | `confidentialite_id` (nullable) | habilitation du compte ; `null` = aucune habilitation |
| `document` | `confidentialite_id` (nullable) | classement du document ; `null` = document non classé |
| `document_type_setting` | `confidentialite_id` (nullable) | confidentialité **par défaut** appliquée aux documents d'un type |
| `acquisition_batch` | `confidentialite_id` (nullable) | choix fait à l'ouverture d'un lot de numérisation ; écrase le défaut du type |

### 3.2 `permission_level` — référentiel figé des niveaux d'action

Identifiants **fixes** (valeurs de domaine, pas un auto-incrément) :

| id | Nom | Signification |
|---|---|---|
| 1 | Denied | Refus. **Jamais accordable** |
| 2 | Consultation | Lire la fiche et le fichier |
| 3 | Modification | + indexer / modifier les métadonnées |
| 4 | Administration | + gérer les accès du document |
| 5 | Archivistique | + prêts / communication et cycle de vie |

Deux garde-fous obligatoires autour du niveau 1 :

1. la liste des niveaux servie aux écrans d'octroi **exclut l'id 1** ;
2. l'endpoint d'octroi **rejette explicitement** l'id 1 (400), pour un appel direct à l'API qui
   contournerait l'écran.

Raison : c'est **l'absence de ligne** qui vaut refus (deny-by-default). Un « refus » stocké
explicitement créerait deux façons contradictoires d'exprimer la même chose.

### 3.3 `document_type_permission` — droit sur un TYPE de document

C'est la table centrale des deux premiers écrans.

| Colonne | Type | Règle |
|---|---|---|
| `document_type_permission_id` | entier, clé primaire, auto | |
| `document_type_id` | entier, FK `document_type` | `ON DELETE CASCADE` |
| `permission_level_id` | entier, FK `permission_level` | `ON DELETE RESTRICT` |
| `role_id` | entier **nullable**, FK `role` | bénéficiaire **collectif** ; `ON DELETE CASCADE` |
| `user_group_id` | entier **nullable**, FK acteur | bénéficiaire **nommé** |
| `start_date` | horodatage nullable | début de validité ; `null` = sans limite |
| `end_date` | horodatage nullable | fin de validité ; `null` = sans limite |

Contraintes :

- `CHECK ((role_id IS NULL) <> (user_group_id IS NULL))` — **exactement un** bénéficiaire, jamais
  zéro ni deux ;
- index sur `document_type_id` et sur `role_id`.

> **Décision structurante** : le bénéficiaire collectif est le **rôle**, pas un « profil »/groupe
> séparé. Motif : le rôle est la seule population d'utilisateurs que l'administration alimente
> réellement (c'est déjà lui qui porte les menus). Faire cohabiter deux notions de « groupe » dans
> la même table oblige l'ACL à résoudre les deux.

> **Point à trancher chez vous** : il n'existe **pas** de contrainte d'unicité sur
> `(type, niveau, bénéficiaire)`. Accorder deux fois le même droit crée deux lignes. Comme le
> calcul final prend le **maximum** des niveaux, c'est sans effet fonctionnel, mais la liste
> affiche des doublons. Ajoutez un index unique si vous voulez l'éviter.

### 3.4 `document_permission` — droit sur UN document (contexte)

Hors menu, mais **le calcul du niveau effectif l'utilise** : à implémenter si vous portez aussi
la fiche document.

| Colonne | Règle |
|---|---|
| `document_permission_id` | clé primaire auto |
| `document_id` | FK document, `ON DELETE CASCADE` |
| `permission_level_id` | FK niveau |
| `user_group_id` (nullable) | bénéficiaire nommé |
| `group_id` (nullable) | bénéficiaire **profil** (axe différent de `role_id` ci-dessus) |
| `granted_by`, `granted_at` | traçabilité (pas de FK sur l'auteur) |
| `start_date`, `end_date` | fenêtre de validité, nullable |

Contraintes : `CHECK` « exactement un bénéficiaire », plus une unicité
`(document_id, user_group_id, permission_level_id)`.

### 3.5 Notion d'« acteur »

Les droits nominatifs ne visent pas directement le compte (`app_user`) mais l'**acteur**
(`app_user_group` = le couple utilisateur × profil, avec un profil par défaut). Si votre
application n'a pas cette notion, remplacez `user_group_id` par `user_id` partout : rien d'autre
ne change fonctionnellement.

---

## 4. Règles métier à réimplémenter

### 4.1 Peut-il voir le document ? (axe confidentialité)

Fonction `peutAcceder(document, utilisateur)` — **unique point de passage** pour : ouverture de la
fiche, indexation, téléchargement, visionneuse.

1. utilisateur administrateur ou identité machine (agent de numérisation) → **oui** ;
2. document sans confidentialité (`confidentialite_id` vide) → **oui** ;
3. utilisateur **créateur** du document → **oui** (sans ce garde-fou, un agent sous-habilité ne
   pourrait plus indexer ce qu'il vient de créer) ;
4. confidentialité du document introuvable (désactivée entre-temps) → **oui** (ne pas inventer un
   refus sur une référence orpheline) ;
5. sinon → **oui si** `rang(utilisateur) >= rang(document)`, l'utilisateur sans habilitation
   (`null`) échouant toujours.

En cas de refus, répondre **404 « introuvable »** et non 403 : un 403 confirmerait l'existence du
document.

### 4.2 Même règle dans la recherche / les listes

La recherche doit appliquer la même comparaison de rang **directement en SQL**, sinon les listes
révèlent des documents que la fiche refuse d'ouvrir :

```sql
d.confidentialite_id IS NULL
OR EXISTS (
  SELECT 1 FROM app_user u
  JOIN confidentialite uc ON uc.confidentialite_id = u.confidentialite_id
  JOIN confidentialite dc ON dc.confidentialite_id = d.confidentialite_id
  WHERE u.user_id = :userId AND uc.rank >= dc.rank
)
```

Deux écarts **assumés** dans l'implémentation d'origine, à reprendre ou non :

- pas de dérogation « créateur » dans la recherche (un créateur sous-habilité ne voit pas sa pièce
  dans la liste, seulement en ouverture directe) ;
- les tableaux de bord / statistiques ne sont pas filtrés (agrégats, aucun contenu exposé).

### 4.3 Que peut-il en faire ? (niveau effectif)

Fonction `niveauEffectif(document, utilisateur)` → entier 2..5 :

1. administrateur ou identité machine → **5** ;
2. plancher **2 (Consultation)** : quiconque a passé `peutAcceder` peut au moins lire ;
3. créateur du document → au moins **3** ;
4. puis le **maximum** des droits explicites applicables :
   - `document_permission` sur **ce document**, pour l'acteur nommé **ou** son profil ;
   - `document_type_permission` sur **le type** du document, pour l'acteur nommé **ou** son rôle.

⚠️ Les deux tables n'ont pas le même bénéficiaire collectif (profil pour l'une, rôle pour l'autre) :
il faut **deux filtres distincts**, pas une liste d'acteurs partagée.

Le niveau effectif est renvoyé avec le détail du document et pilote l'affichage **et** le contrôle
serveur.

### 4.4 Seuils d'action

| Action | Niveau minimum |
|---|---|
| Lire la fiche, télécharger | 2 |
| Indexer / modifier les métadonnées | 3 |
| Accorder ou retirer un droit sur ce document | 4 |
| Créer un prêt / communication, modifier le cycle de vie | 5 |

Le contrôle doit être **côté serveur**, pas seulement en masquant des boutons.

> Détail d'implémentation qui a un effet réel : le contrôle « niveau ≥ 4 » pour accorder/retirer un
> droit doit vivre dans le **contrôleur** de la fiche document, pas dans la fonction d'octroi
> elle-même. Cette fonction est aussi appelée par d'autres flux (acceptation d'une demande d'accès)
> autorisés par un axe différent ; y placer le contrôle casserait ces flux.

### 4.5 Fenêtres de validité (`start_date` / `end_date`)

Elles sont **saisies, stockées et affichées, mais non appliquées** dans l'implémentation d'origine :
aucun calcul ne filtre sur ces dates. Deux choix possibles chez vous :

- les appliquer : ajouter `AND (start_date IS NULL OR start_date <= now()) AND (end_date IS NULL OR
  end_date >= now())` aux deux requêtes de droits du §4.3 ;
- ne pas les proposer du tout, plutôt que d'afficher un champ sans effet.

---

## 5. Les écrans, un par un

### 5.1 « Sécurité type document par utilisateur » et « … par rôle »

Ces deux écrans sont **le même écran paramétré**, sur la même table. Seul le bénéficiaire change :
acteur nommé (`user_group_id`) d'un côté, rôle (`role_id`) de l'autre. Implémentez-les comme un
composant unique avec un paramètre `scope = user | role`.

**Zone d'octroi — champs**

| Champ | Type | Obligatoire | Source des valeurs |
|---|---|---|---|
| Bénéficiaire(s) | sélection **multiple**, recherche par libellé | oui | liste des acteurs (écran « par utilisateur ») ou liste des rôles actifs (écran « par rôle ») |
| Type(s) de document | sélection **multiple** | oui | référentiel des types de documents |
| Niveau | sélection simple | oui | `permission_level` **sans l'id 1** |
| Date de début | date | non | — |
| Date de fin | date | non | — |

Validation avant envoi : au moins un bénéficiaire, au moins un type, un niveau. Sinon message
d'avertissement, aucun appel.

**Comportement de l'octroi** : produit cartésien `bénéficiaires × types`, un appel unitaire par
combinaison (pas d'endpoint « bulk » — les volumes sont faibles). Confirmation du type
« Droit accordé (3 × 4) », puis remise à zéro des champs et rechargement de la liste.

**Liste des droits** — la même lecture pour les deux écrans, filtrée sur le `scope`.
Regroupée **par bénéficiaire** (dépliable), car le produit cartésien répète le même nom sur autant
de lignes que de types.

- Clé de regroupement = `role_id` / `user_group_id`, **jamais le libellé** : rien n'impose
  l'unicité du nom d'un rôle, et deux homonymes doivent rester deux groupes.
- Ligne de regroupement : nom du bénéficiaire + nombre de droits + action **« Tout retirer »**
  (avec confirmation).
- Ligne de détail : type de document, niveau, période (`—` si sans limite), action **« Retirer »**.
- Le retrait multiple est également une boucle d'appels unitaires.

**Données par ligne renvoyées par l'API** : identifiant du droit, id + libellé du type, id + nom du
niveau, `scope` (`user` ou `role`), `role_id`, `user_group_id`, libellé du bénéficiaire, profil du
bénéficiaire (uniquement pour un acteur nommé), dates.

Repli d'affichage du libellé : nom complet, sinon identifiant de connexion, sinon `#id`.

### 5.2 « Confidentialité des utilisateurs »

Affectation **en masse** du niveau d'habilitation. L'écran de gestion des utilisateurs sait déjà le
faire, mais un compte à la fois.

**Contenu** : la liste des comptes avec, par ligne — nom (ou identifiant), identifiant de connexion,
confidentialité actuelle (ou « Aucune »). Sélection multiple par cases à cocher.

**Actions**

| Élément | Comportement |
|---|---|
| Niveau à appliquer | sélection simple, **effaçable** : vide = *retirer l'habilitation* |
| Recherche | filtre **d'affichage uniquement** (nom ou identifiant) |
| « Sélectionner tout le monde (N) » | porte sur **l'annuaire entier**, pas sur le résultat filtré — sinon le libellé mentirait |
| « Appliquer (N) » | confirmation obligatoire, chiffrant la portée et énonçant la conséquence |

Règles :

- l'opération **écrase** l'habilitation existante, sans historique ni retour arrière ;
- appliquer **sans niveau** = retirer l'habilitation : ces comptes n'atteindront plus **aucun**
  document porteur d'une confidentialité. Cette conséquence doit être écrite explicitement dans la
  confirmation, et signalée dès qu'une sélection est prête à partir sans niveau ;
- le **compte super-administrateur de départ est exclu** de la liste et de la requête (il est
  protégé en écriture partout ailleurs) ;
- la réponse renvoie le **nombre de comptes réellement modifiés**, affiché à l'utilisateur.

### 5.3 « Confidentialités »

Référentiel simple, mais avec la notion d'ordre.

| Action | Comportement |
|---|---|
| Lister | uniquement les niveaux **actifs**, triés par `rank` croissant |
| Créer | saisie du **libellé seul** ; `rank = max + 10` automatique ; refus si un niveau actif porte déjà ce libellé (409) |
| Modifier | **libellé uniquement** ; même contrôle d'unicité |
| Supprimer | **désactivation** (`is_active = false`) ; les documents et comptes qui référençaient le niveau ne sont pas modifiés |

Colonnes affichées : rang (valeur numérique, plus un repère visuel de position dans l'échelle) et
libellé. Le rang est en lecture seule.

> **Conséquence de la désactivation** à connaître : un document référençant un niveau désactivé
> devient **accessible à tous** (règle §4.1, point 4). Si ce n'est pas le comportement voulu, il faut
> soit interdire la désactivation d'un niveau encore référencé, soit traiter la référence orpheline
> comme un refus.

> **Le rang n'est pas modifiable** après création : réordonner l'échelle changerait rétroactivement
> l'accès à tous les documents déjà classés. Si vous voulez le permettre, prévoyez un écran
> explicite qui annonce cet effet.

---

## 6. API REST à fournir

Préfixe d'exemple : `/api`. Colonne « Garde » = contrôle d'accès attendu.

### Référentiels

| Méthode | Chemin | Corps | Réponse | Garde |
|---|---|---|---|---|
| GET | `/referentials/confidentialites` | — | `[{ confidentialiteId, label, rank }]` actifs, tri `rank` | authentifié |
| POST | `/referentials/confidentialites` | `{ label }` | niveau créé | menu « Confidentialités » |
| PATCH | `/referentials/confidentialites/:id` | `{ label }` | niveau mis à jour | menu « Confidentialités » |
| DELETE | `/referentials/confidentialites/:id` | — | `{ deactivated: true }` | menu « Confidentialités » |
| GET | `/referentials/permission-levels` | — | `[{ permissionLevelId, name }]` **sans l'id 1** | authentifié |
| GET | `/referentials/document-types` | — | types de documents (lookup) | authentifié |

### Droits par type de document

| Méthode | Chemin | Corps | Réponse | Garde |
|---|---|---|---|---|
| GET | `/referentials/document-type-permissions` | — | liste enrichie (voir §5.1) | authentifié |
| POST | `/referentials/document-type-permissions` | `{ documentTypeId, permissionLevelId, roleId? , userGroupId?, startDate?, endDate? }` | droit créé | accès à l'écran |
| DELETE | `/referentials/document-type-permissions/:id` | — | `{ deleted: 1 }` | accès à l'écran |

Validation du corps de l'octroi : identifiants entiers positifs ; **exactement un** de `roleId` /
`userGroupId` (« Fournir exactement un bénéficiaire ») ; dates au format `AAAA-MM-JJ`, facultatives.
Retrait d'un identifiant inexistant → 404.

> Dans l'implémentation d'origine, POST et DELETE ne portent **aucune annotation serveur** : l'accès
> à l'écran (barre de menus) fait seul office de filtre. C'est une décision explicite du propriétaire
> du produit, pas un oubli. **Pour une nouvelle application, exigez la clé de menu sur ces deux
> endpoints** — c'est cohérent et sans coût.

### Comptes utilisateurs

| Méthode | Chemin | Corps | Réponse | Garde |
|---|---|---|---|---|
| GET | `/users` | — | `[{ userId, username, fullName, confidentialiteId, confidentialite: { confidentialiteId, label, rank } }]` | menu « Utilisateurs » **ou** menu « Confidentialité des utilisateurs » |
| PATCH | `/users/confidentialite` | `{ userIds: number[], confidentialiteId: number \| null }` | `{ updated: N }` | idem |

Règles :

- `userIds` non vide ; `confidentialiteId` nullable **explicitement** (le `null` porte le sens
  « retirer ») ;
- le compte super-administrateur est exclu **par la requête elle-même**, pas seulement par le front ;
- ⚠️ **ordre de déclaration des routes** : `PATCH /users/confidentialite` doit être enregistré
  **avant** `PATCH /users/:id`, sinon le segment « confidentialite » est capté par `:id` et renvoie
  une erreur de conversion (400).

Ne **pas** réutiliser `PATCH /users/:id` pour cet écran : cet endpoint touche aussi le mot de passe,
le drapeau administrateur et le rôle, et doit rester réservé au menu « Utilisateurs ».

### Listes de bénéficiaires

| Écran | Source | Filtre |
|---|---|---|
| par utilisateur | liste des acteurs (`user_group_id` + libellé) | — (n'afficher que le nom de la personne) |
| par rôle | liste des rôles | rôles **actifs** uniquement |

---

## 7. Ordre d'implémentation conseillé

1. **Référentiels** — tables `confidentialite` et `permission_level` + données de départ
   (4 confidentialités, 5 niveaux figés). Endpoints de lecture. Rien ne fonctionne sans eux.
2. **Écran « Confidentialités »** — CRUD complet, rang automatique, désactivation.
3. **Habilitation des comptes** — colonne `app_user.confidentialite_id`, endpoint d'affectation en
   masse, écran « Confidentialité des utilisateurs ».
4. **Application de l'axe confidentialité** — `peutAcceder` (§4.1) sur la fiche / le téléchargement,
   puis le filtre SQL dans la recherche (§4.2). *À faire d'un bloc : la fiche et la liste doivent
   dire la même chose.*
5. **Table `document_type_permission`** + contrainte « exactement un bénéficiaire », endpoints
   liste / octroi / retrait.
6. **Écran commun des droits par type**, instancié deux fois (`scope = user`, `scope = role`).
7. **Calcul du niveau effectif** (§4.3) et **application des seuils** (§4.4) côté serveur, puis
   affichage conditionnel côté écran.
8. **RBAC des menus** — déclarer les 4 clés dans le catalogue et poser la garde sur les endpoints.

Les étapes 1–3 sont livrables seules (administration pure). L'étape 4 est la première qui **change
ce que voient les utilisateurs** : la prévoir avec une vérification des données existantes.

> ⚠️ **Avertissement de mise en service, tiré de l'expérience** : sur un parc de 16 comptes, un seul
> portait une confidentialité et aucun droit par type n'était provisionné. Activer un
> deny-by-default strict aurait **vidé la recherche pour presque tout le monde**. Avant d'activer
> l'étape 4, comptez les comptes sans habilitation et les documents classés, et provisionnez les
> habilitations d'abord.

---

## 8. Points de vigilance (résumé)

| # | Point | Pourquoi |
|---|---|---|
| 1 | Le niveau « Denied » n'est jamais accordable | L'absence de ligne EST le refus ; deux façons d'exprimer un refus se contredisent tôt ou tard |
| 2 | Contrainte « exactement un bénéficiaire » en base | Une ligne sans bénéficiaire, ou avec deux, casse silencieusement le calcul des droits |
| 3 | Deux bénéficiaires collectifs différents (profil pour un document, rôle pour un type) | Un filtre partagé donnerait des droits que personne n'a accordés |
| 4 | Refus d'accès → 404, pas 403 | Un 403 confirme l'existence du document |
| 5 | Dérogation « créateur » | Sans elle, un agent sous-habilité ne peut plus indexer ce qu'il vient de numériser |
| 6 | Même règle dans la recherche et sur la fiche | Sinon la liste montre ce que la fiche refuse d'ouvrir |
| 7 | Clé de menu ≠ libellé d'écran | Un écran peut être renommé ; sa clé, stockée dans les permissions déjà accordées, ne doit pas bouger |
| 8 | Route « bulk » déclarée avant la route paramétrée | `/users/confidentialite` serait sinon interprété comme `/users/:id` |
| 9 | Compte administrateur protégé exclu côté serveur | Le front ne doit pas être le seul rempart |
| 10 | Contrôle des seuils dans le contrôleur, pas dans la fonction d'octroi | Cette fonction sert aussi des flux autorisés par un autre axe |
| 11 | Dates de validité déclaratives | Décider explicitement : les appliquer, ou ne pas les proposer |
| 12 | Rang non modifiable après création | Réordonner l'échelle change rétroactivement l'accès à tout l'existant |

---

## 9. Recette fonctionnelle

**Référentiel**

- [ ] Créer un niveau : il apparaît en dernier, avec un rang supérieur de 10 au précédent.
- [ ] Créer un niveau au libellé déjà utilisé : refus explicite.
- [ ] Supprimer un niveau : il disparaît des listes ; les comptes qui le portaient ne sont pas modifiés.

**Habilitation**

- [ ] Appliquer un niveau à 3 comptes : le message confirme « 3 » et les lignes se mettent à jour.
- [ ] Appliquer **sans** niveau : l'avertissement s'affiche avant, l'habilitation est bien retirée.
- [ ] Le compte administrateur protégé n'apparaît pas dans la liste.
- [ ] Rechercher puis « Sélectionner tout le monde » : la sélection porte bien sur l'annuaire entier.

**Droits par type**

- [ ] Octroyer 2 bénéficiaires × 3 types : 6 lignes, regroupées en 2 blocs.
- [ ] La liste de niveaux ne propose pas « Denied » ; un appel API direct avec le niveau 1 est refusé.
- [ ] Un appel API sans bénéficiaire, ou avec les deux, est refusé.
- [ ] « Tout retirer » sur un bénéficiaire supprime uniquement ses lignes.
- [ ] Les droits accordés « par rôle » n'apparaissent pas dans l'écran « par utilisateur », et
      réciproquement.

**Application effective** (le vrai test)

- [ ] Un utilisateur **sans** habilitation ne voit aucun document classé, ni en recherche, ni en
      ouverture directe (404).
- [ ] Un utilisateur habilité au rang égal ou supérieur y accède.
- [ ] Sans droit explicite, il obtient le niveau 2 : lecture possible, indexation et gestion des
      accès refusées (403) **même par appel direct à l'API**.
- [ ] Après un droit « Administration » (4) sur le type : il indexe et gère les accès, mais pas le
      cycle de vie.
- [ ] Après « Archivistique » (5) : le cycle de vie passe.
- [ ] Le créateur d'un document y accède même sous-habilité.

> **Conseil de test multi-utilisateurs** : ne testez pas en changeant de session dans le navigateur —
> le stockage local est partagé entre les onglets d'une même origine, le second onglet hérite du
> jeton du premier. Récupérez un jeton par un appel d'authentification direct et posez-le à la main
> dans l'en-tête d'autorisation des appels suivants.

---

## Annexe — Deux écrans facultatifs, non retenus

Prévus à l'origine, retirés de l'interface. À implémenter seulement si le besoin existe chez vous.

**A. Demandes d'accès document.** Un utilisateur qui tombe sur un document sans y avoir de droit
soumet une demande motivée ; un administrateur l'accepte ou la refuse. Table
`document_access_inquiry` : document, demandeur, niveau demandé, motif (texte), période souhaitée,
**statut entier 0 = en attente / 1 = acceptée / 2 = refusée** (avec contrainte de domaine),
décideur et date de décision, date de création.

> Le statut est un entier à trois valeurs, et non un booléen « traité » : un booléen ne permet plus
> de distinguer accepté de refusé une fois la demande traitée.

L'acceptation doit **réutiliser** la fonction d'octroi d'un droit sur un document, et non dupliquer
l'écriture — l'effet doit être strictement identique à un octroi manuel.

**B. Sécurité par classification.** Écran de saisie, **sans table dédiée** : on choisit un plan de
classement, on résout les types de documents qui y sont rattachés, puis on boucle sur le même
endpoint d'octroi pour chaque combinaison (bénéficiaire × type). C'est une façade de saisie sur
`document_type_permission`. Il suffit d'un endpoint listant les plans ayant au moins un type
rattaché, avec la liste de ces types.
