# Archivage par QR — Pages, éléments UI & fonctionnalités

> Inventaire de l'interface web (`apps/web`, Next.js + React + Ant Design).
> Source : routes sous `apps/web/app/`. Stack : Next.js (App Router), Ant Design v5, locale `fr_FR`.

## Vue d'ensemble des pages

| Route | Page | Rôle | Accès |
|---|---|---|---|
| `/login` | Connexion | Authentification (JWT) | Public |
| `/` | Accueil / Tableau de bord | Aiguillage vers les écrans | Authentifié |
| `/intercalaires` | **P1** — Génération d'intercalaires QR | Produire les feuilles séparatrices à imprimer | Authentifié |
| `/acquisition` | **P2** — Acquisition par lot | Téléverser, découper (QR), OCR, indexer, valider | Authentifié |
| `/search` | **P3** — Recherche & export | Rechercher, consulter, exporter | Authentifié |
| `/admin` | Administration (redirection) | Redirige vers `/admin/geolocalisation` | Authentifié |
| `/admin/geolocalisation` | Gestion de la Géolocalisation | Référentiel hiérarchique des localisations | Authentifié |
| `/admin/classification-plans` | Plan de classement | Référentiel hiérarchique du plan de classement | Authentifié |
| `/admin/dossier-categories` | Catégories de dossier | Référentiel plat des catégories | Authentifié |
| `/admin/dossiers` | Gestion des Dossiers | Référentiel hiérarchique des dossiers | Authentifié |
| `/admin/document-types` | Types de document | Référentiel plat des types | Authentifié |
| `/admin/users` | Utilisateurs | Gestion des comptes | Authentifié |

### Chrome applicatif (commun à toutes les pages sauf `/login`)

Composant `AuthShell` (`app/components/AuthShell.tsx`) :

- **Garde d'authentification** : sans jeton → redirection `/login` ; avec jeton sur `/login` → redirection `/` ; spinner de chargement pendant la vérification (`/auth/me`).
- **Barre latérale (Sider)** fixe (280 px), groupée en deux sections :
  - **Docu-Archives** : Intercalaires, Acquisition par lot, Recherche.
  - **Paramétrage** : Gestion de la Géolocalisation, Plan de classement, Catégories de dossier, Gestion des Dossiers, Types de document, Utilisateurs.
  - Chaque entrée porte une icône ; l'élément actif est mis en surbrillance selon l'URL.
- **En-tête (Header)** : nom complet (ou identifiant) de l'utilisateur + mention `· admin` le cas échéant, et bouton **Déconnexion** (purge du jeton + redirection).

---

## `/login` — Connexion

**Fichier** : `app/login/page.tsx`

### Éléments UI
- Carte centrée, titre **« Docu-Archives »**.
- Formulaire (layout vertical) :
  - Champ **Nom d'utilisateur** (`Input`, autofocus, requis).
  - Champ **Mot de passe** (`Input.Password`, requis).
  - Bouton **Se connecter** (pleine largeur, état `loading`).
- Messages d'erreur (toast) : « Identifiants invalides » / « Connexion impossible (serveur indisponible ?) ».

### Fonctionnalités
- Authentification via `POST /auth/login`.
- Nettoyage des espaces de fin (autofill Edge/Chrome) sur identifiant et mot de passe.
- Stockage du `accessToken` (JWT) dans `localStorage`, puis redirection vers l'accueil.

---

## `/` — Accueil / Tableau de bord

**Fichier** : `app/page.tsx`

### Éléments UI
- Titre **« Archivage par QR »** + sous-titre descriptif.
- Grille de 4 **cartes cliquables** (`Card hoverable`) :
  - **P1 — Intercalaires** → `/intercalaires`
  - **P2 — Acquisition par lot** → `/acquisition`
  - **P3 — Recherche** → `/search`
  - **Administration** → `/admin`

### Fonctionnalités
- Navigation rapide vers les trois écrans métier et l'administration.

---

## `/intercalaires` — P1 · Génération d'intercalaires QR

**Fichier** : `app/intercalaires/page.tsx`

### Éléments UI
- Titre + paragraphe d'aide.
- **Sélecteur de catégorie** (`Radio.Group` de boutons) : chargé depuis `/intercalaires/categories` (Type de document, Plan de classement, Localisation, Dossier, Séparateur vierge).
- **Liste des éléments** de la catégorie (cases à cocher) :
  - Indentation selon la profondeur (`depth × 20 px`) pour rendre l'arbre des référentiels hiérarchiques.
  - Sélection multiple.
  - États : `Spin` (chargement), `Empty` « Aucun élément ».
- Cas **séparateur vierge** : encart `Empty` « Séparateur vierge — une feuille unique sera générée » (pas de liste).
- Bouton **Générer le PDF** (désactivé si aucune sélection, sauf en mode vierge ; état `loading`).

### Fonctionnalités
- Chargement dynamique des éléments à chaque changement de catégorie (`/intercalaires/items?category=…`).
- Garde : génération bloquée tant qu'aucun élément n'est sélectionné (hors catégorie vierge).
- Génération via `POST /intercalaires/generate` → réception d'un **PDF (blob)** ouvert dans un nouvel onglet (une feuille A4 à QR code par élément).
- Gestion d'erreur (toast).

---

## `/acquisition` — P2 · Acquisition par lot

**Fichier** : `app/acquisition/page.tsx`

### Éléments UI

**Fil d'étapes** (`Steps`) : *Téléversement → Traitement → Indexation*.

**Phase 1 — Formulaire de téléversement** (avant création du lot) :
- **Dossier de destination** (`Segmented`) : *Dossier existant* / *Nouveau dossier*.
  - Mode existant : `TreeSelect` arborescent (optionnel — peut être défini par un intercalaire QR « DOSSIER »), avec recherche.
  - Mode nouveau : `Input` libellé du nouveau dossier.
- **Zone de dépôt PDF** (`Upload.Dragger`) : glisser-déposer / sélection multiple, `accept=application/pdf`.
- Alerte d'erreur (`Alert`).
- Bouton **Lancer le traitement** (désactivé tant qu'aucun fichier, ou libellé manquant en mode « nouveau »).

**Phase 2 — Suivi du lot** (carte « Lot #N ») :
- État *Traitement* : `Spin` + « Découpage par QR et OCR en cours… » (polling).
- État *Prêt* : tags récap (`N document(s)`, `x/N validé(s)`), boutons **Indexer / Valider** et **Nouveau lot**.
- **Tableau des documents produits** : colonnes Document (lien), N° pièce, Type, Pages, Statut (`Validé` / `À indexer`) ; pagination.
- `Empty` si aucun document produit (avertissement sur les intercalaires QR).

**Phase 3 — Modale d'indexation** (plein écran) :
- **Volet gauche** : visionneuse PDF (`iframe`) du document sélectionné.
- **Volet droit** :
  - **Indexation commune** (`Card`) : N° pièce, Date du document (`DatePicker`), Type de document (`Select`), Plan de classement (`TreeSelect`), Dossier (`TreeSelect`), Description ; bouton **Appliquer à tous** (un champ vide n'est pas modifié).
  - **Tableau éditable par document** (une ligne = un document) : indicateur de ligne active (œil), Type (`Select`), Date (`DatePicker`), Description (`Input`), N° pièce (`Input`), Classement (`TreeSelect`), Dossier (`TreeSelect`), Statut.
  - Compteur `x/N validé(s)` + boutons **Enregistrer** et **Valider tout le lot**.

### Fonctionnalités
- Chargement des référentiels (types, plans, dossiers) pour les listes.
- Création du lot (`POST /batches`), avec dossier existant **ou** nouveau dossier créé à la volée.
- Téléversement multi-PDF (`POST /batches/{id}/files`, multipart).
- **Traitement asynchrone** : découpage par QR d'intercalaire + OCR côté worker ; **polling** du statut (`GET /batches/{id}`) jusqu'à fin (statuts 0=en cours, 1=ok, 2=échec).
- Chargement des documents produits (`GET /batches/{id}/documents`).
- Ouverture **automatique** de la modale d'indexation à la fin du traitement (une fois par lot).
- Visionneuse PDF par document (`GET /documents/{id}/files/{fileId}/content`).
- **Indexation commune** appliquée à tous les documents, et **édition fine** ligne par ligne.
- Enregistrement (`PATCH /documents/{id}/indexation`) avec ou sans **validation** (archivage du lot).
- Finalisation automatique quand tous les documents sont validés → réinitialisation pour un nouveau lot.
- Relance possible en cas d'échec de traitement.

---

## `/search` — P3 · Recherche multi-critères & export

**Fichier** : `app/search/page.tsx`

### Éléments UI
- Titre + paragraphe d'aide.
- **Barre de recherche plein-texte** (`Input` large, préfixe loupe, `allowClear`) — recherche sur libellé + référence + texte OCR ; validation par Entrée.
- Boutons **Rechercher** et **Réinitialiser** (désactivé si rien à réinitialiser).
- **Filtres avancés** (`Collapse`, ouvert par défaut) :
  - Type de document (`Select` recherchable).
  - Dossier (`TreeSelect`).
  - Plan de classement (`TreeSelect`).
  - Localisation (`TreeSelect`).
  - Date du document (`RangePicker` Du → Au).
- **Puces de filtres actifs** (`Tag` fermables) : chaque filtre appliqué devient une puce supprimable ; lien **Tout effacer**.
- **Carte de résultats** :
  - Titre dynamique « N résultat(s) ».
  - **Boutons d'export** : Excel, CSV, PDF, Word (désactivés si 0 résultat).
  - **Tableau** : colonnes Libellé (lien d'ouverture), Type de document, Référence, Date document, Dossier, Plan de classement — chacune **triable** ; pagination serveur (10/20/50/100), total affiché.
  - `Empty` « Aucun document ne correspond à ces critères. ».

### Fonctionnalités
- Chargement des référentiels (types, dossiers, plans, localisations) pour les filtres.
- Distinction **brouillon** (formulaire édité) vs **critères appliqués** : la recherche ne part qu'au clic « Rechercher » / Entrée / suppression d'une puce.
- Recherche serveur (`POST /documents/search`) : plein-texte + filtres + tri + pagination.
- Suppression individuelle de filtre via les puces ; réinitialisation globale.
- **Export** (`POST /documents/export`) en **Excel (xlsx)**, **CSV**, **PDF**, **Word (docx)** — l'export reflète exactement les filtres et le tri courants ; téléchargement du blob.
- **Ouverture d'un document** : résolution de la version courante (`GET /documents/{id}`) puis affichage du fichier (`…/files/{fileId}/content`) dans un nouvel onglet.
- *(Contrôle d'accès « refus par défaut » appliqué côté API : seuls les documents autorisés apparaissent.)*

---

## Administration des référentiels

### Patron commun (pages référentiels)
La plupart des pages d'admin partagent ce schéma :
- **Mise en page deux colonnes** : tableau (gauche) + carte « Nouvel élément / Nouvelle … » (droite).
- **Édition en ligne** (`EditableText` / `EditableSelect` / `EditableLocation`) : clic sur une cellule → champ d'édition → validation à Entrée/blur (champ requis restauré si vidé).
- **Suppression** : bouton corbeille + `Popconfirm` (Oui/Non).
- **Export** : boutons **Excel** et **PDF** (`GET …/export?format=…`).
- **Pagination** : 10/20/50/100, total affiché.
- Pour les référentiels hiérarchiques : **arbre déplié** (org-chart), `TreeSelect` pour choisir le parent.

---

### `/admin/geolocalisation` — Gestion de la Géolocalisation
**Fichier** : `app/admin/geolocalisation/page.tsx`

- **Tableau hiérarchique** : colonnes *Nom de l'élément* (éditable, requis), *Code* (éditable, requis), action *Supprimer*.
- **Carte « Nouvel élément »** : Nom * (Entrée pour valider), Parent (`TreeSelect`, optionnel = racine), Code *.
- Fonctions : créer / modifier (in-line) / supprimer (avec sous-éléments) / exporter (Excel, PDF).
- API : `/referentials/locations` (GET/POST/PATCH/DELETE) + `/export`.

### `/admin/classification-plans` — Plan de classement
**Fichier** : `app/admin/classification-plans/page.tsx`

- **Tableau hiérarchique** : *Nom de l'élément* (éditable, requis), *Code* (éditable, **optionnel** — peut être vidé), action *Supprimer*.
- **Carte « Nouvel élément »** : Nom *, **Parent * (obligatoire)** (`TreeSelect`), Code (optionnel).
- Fonctions : créer / modifier / supprimer / exporter (Excel, PDF).
- API : `/referentials/plans` (+ `/export`).

### `/admin/dossier-categories` — Catégories de dossier
**Fichier** : `app/admin/dossier-categories/page.tsx`

- **Tableau plat** : *Libellé* (éditable, requis), action *Supprimer*.
- **Carte « Nouvelle catégorie »** : Libellé * (Entrée pour valider).
- Fonctions : créer / modifier / supprimer / exporter (Excel, PDF).
- API : `/referentials/dossier-categories` (+ `/export`).

### `/admin/dossiers` — Gestion des Dossiers
**Fichier** : `app/admin/dossiers/page.tsx`

- **Tableau hiérarchique** : *Nom de l'élément* (éditable, requis), *Code* (éditable, requis), *Localisation* (`EditableLocation` → `TreeSelect`), *Catégorie* (`EditableSelect`), action *Supprimer*.
- **Carte « Nouveau dossier »** : Nom *, Code *, Élément parent (optionnel), **Localisation * (obligatoire)**, **Catégorie * (obligatoire)**.
- Fonctions : créer / modifier (libellé, code, localisation, catégorie) / supprimer (avec sous-éléments) / exporter (Excel, PDF).
- Croisement de trois référentiels : dossiers, localisations, catégories de dossier.
- API : `/referentials/dossiers`, `/referentials/locations`, `/referentials/dossier-categories` (+ `/export`).

### `/admin/document-types` — Types de document
**Fichier** : `app/admin/document-types/page.tsx`

- **Tableau plat** : *Libellé* (éditable, requis), action *Supprimer*.
- **Carte « Nouveau type de document »** : Libellé * (Entrée pour valider).
- Fonctions : créer / modifier / supprimer / exporter (Excel, PDF).
- API : `/referentials/document-types` (+ `/export`).

### `/admin/users` — Utilisateurs
**Fichier** : `app/admin/users/page.tsx`

- **Formulaire en ligne** (`Form` inline) : Identifiant *, Prénom *, Nom *, Mot de passe * (≥ 8 caractères), bouton **Créer**.
- **Tableau** : colonnes Identifiant, Nom, Admin (Oui/Non), Désactivé (Oui/Non) ; pagination.
- Fonctions : lister / créer un utilisateur. *(Pas d'édition ni de suppression dans l'UI actuelle.)*
- API : `/users` (GET/POST).

---

## Récapitulatif transverse des fonctionnalités

- **Authentification JWT** : login, garde d'accès globale, déconnexion, profil (`/auth/me`).
- **Chaîne d'archivage QR** : génération d'intercalaires (P1) → acquisition/découpage/OCR (P2) → recherche/export (P3).
- **Traitement asynchrone** des lots avec suivi de progression (polling).
- **Indexation** des documents : commune (en masse) + fine (par document) avec visionneuse intégrée.
- **Recherche plein-texte** (libellé + référence + OCR) combinée à des filtres avancés, tri et pagination serveur.
- **Export multi-formats** : grille de recherche (Excel, CSV, PDF, Word) ; référentiels (Excel, PDF).
- **Référentiels** plats (types de document, catégories de dossier) et hiérarchiques (localisations, plan de classement, dossiers) avec édition en ligne et arbres.
- **Gestion des utilisateurs** (création de comptes).
- **Localisation française** (Ant Design `fr_FR`, dates `JJ/MM/AAAA`).
</content>
</invoke>
