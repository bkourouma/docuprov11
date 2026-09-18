# Docu-Archives — Référentiel des actions par écran

> **Objet de ce document.** Inventaire complet, écran par écran, de **toutes les actions, boutons, champs, filtres et messages** de l'interface web (`apps/web`, Next.js + React + Ant Design, locale française).
> Il sert de **base de travail pour rédiger le guide utilisateur** : chaque section décrit *où cliquer*, *ce qui se passe*, *ce qui est obligatoire* et *les messages affichés*.
>
> Interface en français · dates au format **JJ/MM/AAAA** · thème clair/sombre.

---

## 1. Comprendre l'application en 2 minutes

Docu-Archives transforme des **piles de documents papier** en **archives numériques classées et recherchables**. La chaîne se déroule en trois phases :

| Phase | Écran | Ce que fait l'utilisateur |
|---|---|---|
| **P1** | **Intercalaires** | Génère et imprime des feuilles séparatrices à **QR code**, insérées dans les liasses papier avant numérisation. |
| **P2** | **Acquisition par lot** | Téléverse les PDF scannés ; le système les **découpe** (selon les QR), fait l'**OCR**, stocke les fichiers, puis l'utilisateur **indexe et valide** chaque document. |
| **P3** | **Recherche** | Recherche plein-texte + filtres, **consulte** les documents et **exporte** les résultats (Excel, CSV, PDF, Word). |

Autour de ces trois phases :

- **Tableaux de bord** : indicateurs de pilotage (production, structure du fonds).
- **Paramétrage** : référentiels (Géolocalisation, Plan de classement, Catégories de dossier, Dossiers, Types de document).
- **Administration** : Utilisateurs et Rôles (qui voit quoi).

**Notions clés :**

- **Dossier** = conteneur (chemise) hiérarchique où sont rangés les documents.
- **Cote / N° de pièce** = référence du document.
- **Plan de classement** = arborescence thématique (cotes). **Géolocalisation** = arborescence physique (lieux).
- **Lot** = une session de numérisation ; tous les documents d'un même téléversement partagent le même lot.
- **Statut d'un document** : *À indexer* (orange) → *Validé* (vert, archivé).
- **Accès « refus par défaut »** (P3) : un utilisateur ne voit que les documents auxquels il a explicitement droit ; les **administrateurs** voient tout.

---

## 2. Éléments communs à tous les écrans (le « chrome »)

Ces éléments sont présents sur **toutes les pages sauf la connexion**.

### 2.1 Barre latérale (menu de navigation)

Regroupée en **trois sections** :

- **Docu-Archives** : Tableaux de bord · Intercalaires · Acquisition par lot · Recherche
- **Paramétrage** : Géolocalisation · Plan de classement · Catégories de dossier · Dossiers · Types de document
- **Administration** : Utilisateurs · Rôles

**Actions :**

- **Cliquer un menu** → ouvre l'écran correspondant. L'élément actif est surligné.
- **Replier / Déplier la barre** (bouton en bas de la barre) → réduit la barre aux icônes ; l'état est mémorisé.
- **Cliquer le logo** (en haut) → revient aux Tableaux de bord.
- Les menus affichés **dépendent du rôle** de l'utilisateur (voir *Rôles*). Le tableau de bord reste toujours visible ; un administrateur voit tous les menus.
- **Sur mobile** : la barre est masquée ; on l'ouvre via le **bouton menu** (☰) en haut à gauche.

### 2.2 Barre supérieure (TopBar)

De gauche à droite :

- **Titre de la page courante** (fil d'Ariane) — ex. « Acquisition par lot ».
- **Recherche globale** — bouton « Rechercher… » (badge **Ctrl K**) ; ouvre la **palette de commandes**. Sur mobile : icône loupe.
- **Bouton thème** (soleil/lune) — bascule **clair ↔ sombre** ; l'infobulle indique « Thème clair » ou « Thème sombre ».
- **Menu utilisateur** (avatar avec initiales) — au clic, menu déroulant :
  - Ligne d'identité : nom complet + identifiant + mention « · admin » le cas échéant (non cliquable).
  - **Déconnexion** → efface la session et renvoie à l'écran de connexion.

### 2.3 Palette de commandes (Ctrl + K)

Fenêtre de **navigation rapide** ouverte par **Ctrl + K** (ou l'icône loupe sur mobile).

- **Champ de recherche** : « Rechercher une page ou une action… » (filtre en temps réel sur les libellés et mots-clés).
- **Actions rapides** : « Démarrer un nouveau lot », « Générer des intercalaires », « Rechercher des documents ».
- **Toutes les pages** (Docu-Archives, Paramétrage, Administration) selon les droits de l'utilisateur.
- **Navigation clavier** : `↑` `↓` pour parcourir, `↵ (Entrée)` pour ouvrir, `Échap` pour fermer.
- Si aucune correspondance : « Aucune commande pour « … » ».

### 2.4 Conventions d'édition et de retour visuel

- **Édition en ligne** (dans les référentiels) : cliquer une cellule (libellé, code, catégorie…) l'ouvre en édition ; un **crayon discret** apparaît au survol. On valide par **Entrée** ou en cliquant ailleurs (*blur*). Un **champ obligatoire vidé** est restauré (aucun enregistrement).
- **Flash de confirmation** : après un enregistrement, la cellule/ligne s'éclaire brièvement (≈ 1,2–1,4 s).
- **Messages (toasts)** : succès (vert), avertissement (orange), erreur (rouge). Les libellés exacts sont listés par écran, et récapitulés en **Annexe D**.
- **Confirmations de suppression** : une fenêtre de confirmation (Oui/Non ou Annuler/Supprimer) apparaît **avant toute suppression**.

---

## 3. Cartographie des écrans

| Route | Écran | Section | Rôle |
|---|---|---|---|
| `/login` | Connexion | — | Authentification |
| `/dashboards` | Tableaux de bord | Docu-Archives | Indicateurs de pilotage |
| `/intercalaires` | Intercalaires (P1) | Docu-Archives | Générer les feuilles QR |
| `/acquisition` | Acquisition par lot (P2) | Docu-Archives | Téléverser, découper, OCR, indexer, valider |
| `/search` | Recherche (P3) | Docu-Archives | Rechercher, consulter, exporter |
| `/admin/geolocalisation` | Géolocalisation | Paramétrage | Référentiel hiérarchique des lieux |
| `/admin/classification-plans` | Plan de classement | Paramétrage | Référentiel hiérarchique des cotes |
| `/admin/dossier-categories` | Catégories de dossier | Paramétrage | Référentiel plat |
| `/admin/dossiers` | Dossiers | Paramétrage | Référentiel hiérarchique des chemises |
| `/admin/document-types` | Types de document | Paramétrage | Référentiel plat |
| `/admin/users` | Utilisateurs | Administration | Comptes utilisateurs |
| `/admin/roles` | Rôles | Administration | Menus & accès par rôle |
| `/admin` | (redirection) | — | Redirige vers Géolocalisation |

---

## 4. Connexion (`/login`)

**Rôle :** s'authentifier pour accéder à l'application.

**Champs :**

| Champ | Type | Obligatoire | Détail |
|---|---|---|---|
| **Nom d'utilisateur** | Texte | Oui | Placeholder « ex. agent.archives » ; focus automatique. |
| **Mot de passe** | Mot de passe | Oui | Masqué. Les espaces de fin (autofill) sont automatiquement retirés. |

**Actions :**

- **Se connecter** → ouvre l'application (redirection vers les Tableaux de bord).

**Messages :**

- Champ vide : « Saisissez votre nom d'utilisateur. » / « Saisissez votre mot de passe. »
- Identifiants refusés : « Identifiants invalides — vérifiez votre nom d'utilisateur et votre mot de passe. »
- Serveur injoignable : « Connexion impossible — réessayez ou vérifiez que le serveur est démarré. »

---

## 5. Tableaux de bord (`/dashboards`)

**Rôle :** piloter l'archivage (production, structure du fonds).

**En-tête :** titre « Tableaux de bord » et **indicateur principal** : nombre de **documents archivés**.

**Cartes de graphiques :**

| Carte | Type de graphique | Mesure |
|---|---|---|
| **Répartition par type de document** | Anneau (donut) | Composition du fonds par type. |
| **Répartition par dossier** | Barres | Documents rangés dans chaque dossier. |
| **Répartition par plan de classement** | Barres | Volume par cote. |

**Actions / états :**

- Chaque carte se charge **indépendamment**. Pendant le chargement : squelette animé.
- Carte sans donnée : « Aucune donnée pour cette période. »
- Erreur de chargement : message d'erreur (toast).
- *(Un filtre de période — Aujourd'hui / 7 j / 30 j / Mois / Trim. / Année / Perso. — est prévu pour restreindre les données à une plage ; période par défaut : 30 derniers jours.)*

---

## 6. Intercalaires — Phase P1 (`/intercalaires`)

**Rôle :** produire un **PDF d'intercalaires** à QR code (une feuille A4 par élément), à imprimer et insérer dans les liasses papier **avant** numérisation. Ces QR pilotent le découpage automatique à l'acquisition (P2).

**Disposition :** 3 colonnes — **Catégorie** (gauche) · **Éléments** (centre) · **Aperçu** (droite) — et une **barre d'action** collante en bas.

### 6.1 Choisir une catégorie (colonne gauche)

Liste de catégories chargées automatiquement : **Type de document, Plan de classement, Localisation, Dossier, Séparateur vierge** (chacune avec son icône).

- **Cliquer une catégorie** → la sélectionne, charge ses éléments au centre, réinitialise la sélection et le filtre.

### 6.2 Sélectionner les éléments (colonne centrale)

- **Filtrer les éléments…** : champ de recherche (loupe) — filtre en temps réel ; bouton **✕** pour effacer. Sans résultat : « Aucun résultat » pour le terme saisi.
- **Tout sélectionner / Tout désélectionner** : (en-tête de la carte) coche/décoche **tous les éléments visibles** dans le filtre.
- **Liste à cocher** : un clic sur une ligne coche/décoche l'élément. La **hiérarchie** (plan, localisation, dossier) est rendue par **indentation**.
- **Badge** : nombre total d'éléments sélectionnés.
- Cas **Séparateur vierge** : pas de liste — encart « Séparateur vierge — Une feuille unique à QR code sera générée. Aucune sélection nécessaire. »
- Catégorie sans élément : « Aucun élément — Cette catégorie ne contient aucun élément à imprimer. »

### 6.3 Aperçu (colonne droite)

Vignette A4 de prévisualisation : QR + « INTERCALAIRE » + libellé du **premier élément sélectionné** (ou « Séparateur vierge »). Sous la vignette : « **N** feuille(s) seront générées. »

### 6.4 Générer (barre d'action en bas)

- **Info à gauche** : « **N** élément(s) sélectionné(s) » (ou « Séparateur vierge — 1 feuille »).
- **Tout désélectionner** : vide la sélection (visible si au moins un élément coché).
- **Générer le PDF** : produit le PDF (une feuille par élément) et **l'ouvre dans un nouvel onglet** pour impression.
  - **Désactivé** tant qu'aucun élément n'est sélectionné (hors séparateur vierge). *Aucun PDF vide n'est jamais produit.*
  - Erreur : « Erreur de génération ».

> **Bonne pratique guide :** imprimer les intercalaires, les insérer dans la liasse aux bons endroits, puis numériser l'ensemble en PDF.

---

## 7. Acquisition par lot — Phase P2 (`/acquisition`)

**Rôle :** téléverser les PDF scannés, les transformer en **documents**, puis les **indexer et valider**.

**Fil d'étapes (en haut) :** **Téléversement → Traitement → Indexation** (l'étape courante avance automatiquement ; passe en rouge si le traitement échoue).

### 7.1 Configurer le lot (avant envoi)

**Mode d'acquisition** (sélecteur) :

| Mode | Quand l'utiliser | Effet |
|---|---|---|
| **Sans intercalaire** *(par défaut)* | Documents simples | Les fichiers du lot forment **un seul document**, indexé manuellement. Nécessite de choisir un dossier de destination. |
| **Avec intercalaires (QR + OCR)** | Liasses préparées avec des feuilles QR (P1) | **Découpage automatique** par QR + **OCR** — un document par intercalaire. Le dossier peut être déterminé par les QR. |

**Sélection du dossier (mode « Sans intercalaire ») :**

| Champ | Type | Obligatoire | Détail |
|---|---|---|---|
| **Grand dossier** | Liste (recherchable) | Oui | Dossiers racines (ex. « PEPHAR, GSHA… »). Change de grand dossier → réinitialise le sous-dossier. |
| **Dossier de destination** | Arborescence (recherchable) | Oui | Activé après choix du grand dossier ; affiche les sous-dossiers (ou le grand dossier lui-même s'il n'en a pas). |

**Fichiers :**

- **Zone de dépôt** « Glissez-déposez vos PDF ici » (ou clic pour sélectionner) — **PDF uniquement**, multi-fichiers. Décompte affiché : « N fichier(s) · taille ». Fichier non-PDF : « Seuls les fichiers PDF sont acceptés. »

**Lancer :**

- **Lancer le traitement** → crée le lot, envoie les fichiers (par paquets), lance le traitement.
  - **Désactivé** tant qu'il manque des fichiers, ou (en mode simple) le grand dossier / le dossier de destination. Une infobulle indique le motif.
  - Confirmation : « Lot téléversé, découpage QR + OCR en cours… » (mode QR) ou « … chargement des documents en cours… » (mode simple).

### 7.2 Suivre le traitement

- Barre de progression + message : « Téléversement de N fichier(s)… » → « Traitement en cours… » → « Traitement terminé — document(s) prêt(s) à être indexé(s). »
- **Échec** : encart rouge « Le traitement du lot a échoué » + bouton **Relancer le traitement**.
- Quand c'est prêt : carte **« Lot #N »** avec les tags « **N** document(s) » et « **x/N** validé(s) », et le **tableau des documents produits** :

| Colonne | Contenu |
|---|---|
| **Document** | Libellé (lien → ouvre l'indexation sur ce document). |
| **N° pièce** | Cote (ou —). |
| **Type** | Type de document (ou —). |
| **Pages** | Nombre de pages (ou —). |
| **Statut** | *Validé* (vert) / *À indexer* (orange). |

- **Boutons de la carte** : **Indexer / Valider** (ouvre la modale d'indexation) · **Nouveau lot** (repart de zéro).
- Aucun document produit : « Aucun document produit — Vérifiez vos fichiers PDF, puis relancez un lot. »

### 7.3 Indexer et valider (modale plein écran)

La modale **s'ouvre automatiquement** dès que le lot est prêt. À gauche : **visionneuse PDF** ; à droite : **indexation**.

**Visionneuse (gauche) :** aperçu du document sélectionné. « Chargement du document… » pendant le chargement ; « Aucun aperçu » si aucune ligne sélectionnée ou binaire absent.

**Indexation commune (droite, haut)** — champs appliqués à **tous** les documents :

| Champ | Type |
|---|---|
| **N° pièce** | Texte (« Ex. 001 ») |
| **Date du document** | Saisie JJ/MM/AAAA (les « / » sont insérés automatiquement) |
| **Type de document** | Liste (recherchable) |
| **Plan de classement** | Arborescence (recherchable) |
| **Dossier** | Arborescence (recherchable) |
| **Description** | Texte (libellé commun) |

- **Appliquer à tous** → recopie les champs **renseignés** sur tous les documents (« Un champ laissé vide n'est pas modifié »). Sans aucun champ : « Renseignez au moins un champ commun à appliquer. » Sinon : « Indexation commune appliquée à tous les documents. »

**Tableau éditable par document (droite, bas)** — une ligne = un document, colonnes éditables : **Type de document, Date document, Description, N° pièce, Classement, Dossier**, + **Statut** (lecture seule). L'icône « œil » marque la ligne affichée dans la visionneuse. Cliquer une ligne l'affiche à gauche.

**Barre de validation (bas) :**

- Compteur « **x/N** validé(s) » + mention orange « • modifications non enregistrées » le cas échéant.
- **Enregistrer** (sans valider) → « Indexation enregistrée. »
- **Valider le document / Valider tout le lot** → **contrôle des doublons de N° de pièce** puis confirmation :
  - Doublons détectés : « Doublon de numéro de pièce détecté … Voulez-vous valider quand même ? » → **Valider quand même**.
  - Sinon : « Tous les documents seront archivés. Cette action finalise le lot. Continuer ? » → **Valider le lot**.
- Quand **tous** les documents sont validés : la modale se ferme, tout se réinitialise, et « Acquisition finalisée — prêt pour un nouveau lot. »

**Navigation clavier (modale) :** `↓`/`→` document suivant · `↑`/`←` document précédent · `Entrée` enregistre. Fermer avec des modifications non enregistrées demande confirmation (« Fermer sans enregistrer »).

---

## 8. Recherche — Phase P3 (`/search`)

**Rôle :** rechercher, consulter et exporter les documents. **Seuls les documents autorisés** apparaissent (refus par défaut ; l'administrateur voit tout).

### 8.1 Rechercher

- **Barre plein-texte** (loupe) : « Rechercher dans le libellé, la référence et le texte OCR… ». Lancer par **Entrée** ou le bouton **Rechercher**.
- **Réinitialiser** : efface texte, filtres, tri, revient à la page 1 (désactivé si rien à effacer).

### 8.2 Filtres avancés (repliables, ouverts par défaut)

| Filtre | Type | Placeholder |
|---|---|---|
| **Type de document** | Liste (recherchable) | « Tous les types » |
| **Dossier** | Arborescence (recherchable) | « Tous les dossiers » |
| **Plan de classement** | Arborescence (recherchable) | « Tous les plans » |
| **Localisation** | Arborescence (recherchable) | « Toutes les localisations » |
| **Type de fichier** | Liste (recherchable) | « Tous les types de fichier » |
| **Ajouté par** | Liste (recherchable) | « Tous les utilisateurs » |
| **Date du document** | Plage de dates (Du → Au) | Une seule borne acceptée |

- **Puces de filtres actifs** : chaque filtre appliqué devient une puce fermable (ex. « Type : Contrat », « Date : 01/01/2024 → 31/12/2024 »). **✕** supprime ce filtre ; **Tout effacer** les enlève tous.

### 8.3 Résultats

- Titre dynamique : « **N** résultat(s) ».
- **Tableau** — colonnes **triables** : **Libellé** (lien d'ouverture), **Type de document**, **N° pièce**, **Date document**, **Dossier**, **Plan de classement**.
- **Pagination** : 10 / 20 / 50 / 100 par page (20 par défaut) ; total affiché « N document(s) ».
- Aucun résultat : « Aucun document ne correspond à ces critères — Élargissez la recherche ou effacez des filtres… » + bouton **Tout effacer**.

### 8.4 Exporter

Boutons (en-tête des résultats, préfixe « Exporter : ») : **Excel · CSV · PDF · Word**. L'export **reflète exactement les filtres et le tri courants**. Désactivés si 0 résultat. Fichier : `documents.xlsx` / `.csv` / `.pdf` / `.docx`. Erreur : « Export impossible (HTTP …) ».

### 8.5 Consulter / éditer un document (fiche)

Cliquer un **Libellé** ouvre la fiche (visionneuse à gauche, indexation à droite).

- **Visionneuse** : aperçu PDF. Si le binaire manque : encart « Document indisponible dans le coffre » + « Aucun aperçu » (l'indexation reste consultable).
- **Indexation** (lecture) : Libellé, Type de document, N° pièce, Date du document, Dossier, Plan de classement, Fichier (ARCHIVES).
- **Éditer l'indexation** → passe en édition (Libellé **obligatoire**, + Type, N° pièce, Date, Dossier, Plan). **Enregistrer** → « Indexation enregistrée. » ; **Annuler** pour abandonner.
- **Pied de fiche** :
  - **Supprimer** *(administrateurs uniquement)* → confirmation « Supprimer ce document ? Le document et son fichier numérisé seront définitivement supprimés… » → « Document supprimé. »
  - **Ouvrir dans un nouvel onglet** → affiche le PDF en plein écran.
  - **Fermer**.

---

## 9. Paramétrage — Référentiels

**Patron commun** à ces écrans :

- **Deux colonnes** (desktop) : **tableau** à gauche, **formulaire de création** à droite. Sur mobile : bouton **Nouvel élément** ouvrant un tiroir.
- **Édition en ligne** : cliquer une cellule pour la modifier (Entrée / clic ailleurs pour valider).
- **Supprimer** : bouton corbeille + confirmation **Oui / Non**. Pour les référentiels hiérarchiques, la suppression emporte **les sous-éléments**.
- **Exporter** : boutons **Excel** et **PDF** (en-tête).
- **Pagination** : 10 / 20 / 50 / 100 ; total « N élément(s) ».
- Référentiels hiérarchiques : tableau **arborescent déplié** par défaut ; parent choisi via un sélecteur d'arbre.
- Messages types : « … créé », « Modifié », « … supprimé », « Création impossible », « Modification impossible », « Suppression impossible », « Export impossible — réessayez. »

### 9.1 Géolocalisation (`/admin/geolocalisation`)

**Rôle :** arborescence des **lieux / emplacements physiques** (bâtiment → étage → salle → armoire…).

**Colonnes :** **Nom de l'élément** (éditable, obligatoire) · **Code** (éditable, obligatoire) · action **Supprimer**.

**Créer (« Nouvel élément ») :**

| Champ | Obligatoire | Détail |
|---|---|---|
| **Nom de l'élément** | Oui | « Ex. Direction des Archives » |
| **Parent** | Non | « Aucun (élément racine) » — sinon crée un enfant |
| **Code** | Oui | « Ex. DA » |

Bouton **Ajouter** (désactivé tant que Nom ou Code est vide). Suppression : « Supprimer cet élément et ses sous-éléments ? »

### 9.2 Plan de classement (`/admin/classification-plans`)

**Rôle :** arborescence des **cotes** (ex. Ressources humaines › Paie › Bulletins).

**Colonnes :** **Nom de l'élément** (éditable, obligatoire) · **Code** (éditable, **optionnel** — peut être vidé) · action **Supprimer**.

**Créer :**

| Champ | Obligatoire | Détail |
|---|---|---|
| **Nom de l'élément** | Oui | « Ex. Ressources humaines » |
| **Parent** | **Oui** | « Sélectionner l'élément parent » (chaque élément a un parent) |
| **Code** | Non | « Ex. RH » |

Bouton **Ajouter** (désactivé tant que Nom vide ou Parent non choisi). Suppression : « Supprimer cet élément et ses sous-éléments ? »

### 9.3 Catégories de dossier (`/admin/dossier-categories`)

**Rôle :** liste **plate** de catégories (ex. Dossier administratif, technique, financier).

**Colonnes :** **Libellé** (éditable, obligatoire) · action **Supprimer**.

**Créer (« Nouvelle catégorie ») :** **Libellé** obligatoire (« Ex. Dossier administratif »), bouton **Ajouter**. Suppression : « Supprimer cette catégorie ? »

### 9.4 Dossiers (`/admin/dossiers`)

**Rôle :** arborescence des **dossiers / chemises**, croisant trois référentiels (dossiers, localisations, catégories).

**Colonnes :** **Nom de l'élément** (éditable, obligatoire) · **Code** (éditable, obligatoire) · **Localisation** (arbre éditable) · **Catégorie** (liste éditable) · action **Supprimer**.

**Créer (« Nouveau dossier ») :**

| Champ | Obligatoire | Détail |
|---|---|---|
| **Nom de l'élément** | Oui | « Ex. Comptabilité 2026 » |
| **Code** | Oui | « Ex. CPTA-2026 » |
| **Élément parent** | Non | « Aucun (dossier racine) » |
| **Localisation** | **Oui** | « Sélectionner une localisation » |
| **Catégorie** | **Oui** | « Sélectionner une catégorie » |

Bouton **Ajouter** (désactivé tant que Nom, Code, Localisation ou Catégorie manque). Suppression : « Supprimer ce dossier et ses sous-éléments ? »

### 9.5 Types de document (`/admin/document-types`)

**Rôle :** liste **plate** des types (ex. Facture, Contrat, Devis).

**Colonnes :** **Libellé** (éditable, obligatoire) · action **Supprimer**.

**Créer (« Nouveau type de document ») :** **Libellé** obligatoire (« Ex. Facture »), bouton **Ajouter**. Suppression : « Supprimer ce type de document ? »

---

## 10. Administration

### 10.1 Utilisateurs (`/admin/users`)

**Rôle :** créer, modifier, supprimer les comptes ; attribuer un rôle ; activer/désactiver.

**Tableau (« Comptes ») :** **Nom d'utilisateur** · **Nom** (complet) · **Rôle** (étiquette, ou —) · actions.

- **Modifier** (crayon) → modale d'édition.
- **Supprimer** (corbeille) → « Supprimer l'utilisateur « … » ? Cette action est définitive. »
- Le compte **admin** est **protégé** (« Compte protégé », ni édition ni suppression).

**Créer (« Nouvel utilisateur ») :**

| Champ | Obligatoire | Détail |
|---|---|---|
| **Nom d'utilisateur** | Oui | « ex. agent.archives » (unique) |
| **Prénom** | Oui | |
| **Nom** | Oui | |
| **Mot de passe (6 caractères min.)** | Oui | Masqué ; **≥ 6 caractères** |
| **Rôle** | Non | « Aucun rôle (accueil uniquement) » — « Le rôle détermine les menus visibles par l'utilisateur. » |

Bouton **Créer** (désactivé tant qu'un champ requis manque ou mot de passe < 6). Succès : « Utilisateur créé ».

**Modale d'édition :** mêmes champs ; le **mot de passe vide = inchangé** (sinon ≥ 6). On peut aussi (ré)assigner le rôle et activer/désactiver le compte. **Enregistrer** → « Utilisateur modifié ».

### 10.2 Rôles (`/admin/roles`)

**Rôle :** définir des rôles qui **déterminent les menus visibles** dans la barre latérale. « Le tableau de bord (accueil) reste toujours visible. Les administrateurs voient tous les menus. »

**Tableau (« Rôles ») :** **Rôle** (nom ; étiquette dorée **Système** pour les rôles système) · actions.

- Rôle personnalisé : **Permissions** (éditer) · **Supprimer**.
- Rôle système : **Voir** (lecture seule) — non modifiable, non supprimable (« Rôle système : accès complet, non modifiable et non supprimable. »).
- Suppression d'un rôle utilisé : « **N** utilisateur(s) perdront ce rôle (ils ne verront plus que l'accueil). »

**Créer / éditer un rôle :**

| Élément | Détail |
|---|---|
| **Nom du rôle** | Obligatoire (« ex. Agent de saisie »). |
| **Menus accessibles** | Accordéons par **section** (Gestion, Recherche…) ; **cases à cocher** des menus. Chaque section affiche « cochés/total ». Cocher/décocher n'affecte que la section concernée. |

Bouton **Créer le rôle** / **Enregistrer** (désactivé si le nom est vide). Succès : « Rôle créé » / « Rôle mis à jour ». **Annuler** pour quitter l'édition.

---

## Annexe A — Raccourcis clavier

| Raccourci | Contexte | Action |
|---|---|---|
| **Ctrl + K** | Partout | Ouvrir la palette de commandes |
| `↑` / `↓` | Palette | Naviguer entre les commandes |
| `Entrée` | Palette | Ouvrir la commande / (Acquisition) enregistrer |
| `Échap` | Palette / modales | Fermer |
| `↓` `→` / `↑` `←` | Modale d'indexation (P2) | Document suivant / précédent |
| `Entrée` | Champs de saisie (référentiels, connexion) | Valider la saisie |

## Annexe B — Statuts d'un document

| Statut | Couleur | Signification |
|---|---|---|
| **À indexer** | Orange | Produit par l'acquisition, en attente d'indexation/validation. |
| **Validé** | Vert | Indexé et **archivé**. |

## Annexe C — Formats d'export

| Écran | Formats |
|---|---|
| Recherche (P3) | **Excel, CSV, PDF, Word** — reflète filtres + tri courants. |
| Référentiels (Paramétrage) | **Excel, PDF**. |

## Annexe D — Messages fréquents (repères)

**Succès :** « … créé », « Modifié », « … supprimé », « Indexation enregistrée. », « Acquisition finalisée — prêt pour un nouveau lot. », « Indexation commune appliquée à tous les documents. »

**Confirmations :** « Supprimer … ? » (référentiels), « Supprimer ce document ? » (recherche), « Tous les documents seront archivés… Continuer ? » (validation de lot), « Doublon de numéro de pièce détecté… » (validation), « Modifications non enregistrées… Fermer quand même ? »

**Erreurs :** « Erreur de chargement », « Création / Modification / Suppression impossible », « Export impossible — réessayez. », « Seuls les fichiers PDF sont acceptés. », « Le traitement du lot a échoué. »

---

> **Pour construire le guide utilisateur final** à partir de ce référentiel : reprendre les sections 6, 7 et 8 comme **procédures pas-à-pas** (P1 → P2 → P3), illustrer chaque écran par une capture, et renvoyer les référentiels (section 9) et l'administration (section 10) en fin de guide comme chapitres de configuration.
