# Feature Specification: Reprise « Archivage par QR »

**Feature Branch**: `001-archivage-qr`

**Created**: 2026-06-11

**Status**: Draft

**Input**: User description: "D:\Docu-Archives-V6\docs\PRD-Reprise-Archivage-QR.md"

## Résumé

Réimplémenter, dans une application neuve et isolée, **trois fonctionnalités** d'une GED/SAE legacy qui forment ensemble une **chaîne d'archivage par numérisation de masse pilotée par QR codes** :

1. **Génération d'intercalaires QR** — produire des feuilles séparatrices imprimables, chacune portant un QR code, à insérer dans les liasses papier avant numérisation.
2. **Acquisition par lot** — téléverser des PDF numérisés, les découper en documents d'après les QR, en extraire le texte (OCR), stocker les fichiers et rattacher l'ensemble à un dossier.
3. **Recherche multi-critères & export** — consulter les documents dans une grille filtrable / triable / regroupable, ouvrir un document et exporter le résultat (Excel / PDF / Word / CSV).

L'objectif métier est de remplacer une chaîne d'archivage fragile par une chaîne moderne, fiable et sécurisée, avec un contrôle d'accès appliqué à la consultation (corrige une faille du legacy qui exposait tous les documents sans restriction).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Acquisition par lot pilotée par QR (Priority: P1)

En tant qu'**agent de numérisation / documentaliste**, je choisis un dossier de destination (existant ou nouveau), je téléverse un lot de PDF scannés ; le système les découpe en documents distincts d'après les feuilles d'intercalaires QR, extrait le texte des pages (OCR), stocke les fichiers et rattache chaque document au bon dossier, à son type/plan/localisation, et au lot d'acquisition.

**Why this priority**: C'est le cœur de la chaîne — l'étape où le papier devient un fonds documentaire numérique organisé et recherchable. Sans elle, rien n'est archivé. Elle délivre à elle seule la valeur centrale du produit (numérisation → classement → stockage → texte recherchable).

**Independent Test**: Peut être testée en téléversant un lot de PDF contenant des pages d'intercalaires (générées par le Story 2 ou préparées manuellement) et en vérifiant que le système produit le bon nombre de documents, chacun rattaché au bon dossier et au bon attribut de classement, avec le texte OCR disponible et les fichiers stockés.

**Acceptance Scenarios**:

1. **Given** un lot de N fichiers PDF contenant K intercalaires « ouvrants » (type document, plan, localisation ou dossier), **When** je téléverse le lot vers un dossier cible, **Then** le système crée K documents (ou K+1 si des pages précèdent le premier intercalaire), chacun portant l'attribut de classement encodé par son intercalaire.
2. **Given** un intercalaire de catégorie « dossier » dans le lot, **When** le découpage l'atteint, **Then** les documents suivants sont rattachés au dossier encodé par ce QR, qui prévaut sur le dossier choisi à l'ouverture.
3. **Given** une page sans QR, **When** elle est traitée, **Then** elle est rattachée au document courant ; si aucun document n'est ouvert, un document « sans type » est créé pour l'accueillir.
4. **Given** un intercalaire « vierge » (blank), **When** il est rencontré, **Then** il clôt le document courant sans changer d'attribut (simple séparateur).
5. **Given** que je choisis « Nouveau dossier » avec un libellé déjà utilisé par un dossier actif, **When** je valide, **Then** le système refuse la création pour cause de doublon.
6. **Given** un lot téléversé en une fois, **When** le traitement se termine, **Then** tous les documents et fichiers issus de ce lot partagent le même identifiant de lot, et les compteurs et le statut du lot sont mis à jour.
7. **Given** un fichier dont l'extension n'est pas encore connue, **When** il est ingéré, **Then** un type de fichier est créé pour cette extension sans dupliquer un type existant.

---

### User Story 2 - Génération des feuilles d'intercalaires QR (Priority: P2)

En tant qu'**agent de numérisation**, je sélectionne une catégorie d'éléments (type de document, plan de classement, localisation, dossier, ou séparateur vierge), puis un ou plusieurs éléments, et j'obtiens un document imprimable contenant une feuille séparatrice par élément — chacune portant son libellé, le libellé de la catégorie, et un QR code unique — pour intercaler la liasse papier avant numérisation.

**Why this priority**: C'est le prérequis qui pilote le découpage automatique de l'acquisition. Elle est simple, en lecture seule, et démontrable indépendamment (produire et imprimer des feuilles). L'acquisition (Story 1) peut fonctionner en mode dégradé sans elle (« documents sans type »), d'où une priorité juste en dessous.

**Independent Test**: Peut être testée en sélectionnant une catégorie et plusieurs éléments, puis en vérifiant que le document imprimable produit comporte exactement une page par élément, chacune avec le bon libellé, la bonne catégorie et un QR lisible et unique.

**Acceptance Scenarios**:

1. **Given** la catégorie « Plan de classement », **When** je l'ouvre, **Then** la liste des éléments est présentée sous forme d'arbre indenté (hiérarchie respectée, racine virtuelle exclue).
2. **Given** une sélection multiple d'éléments, **When** je lance la génération, **Then** le document produit contient exactement une page par élément sélectionné, chaque page comportant le libellé de catégorie, le libellé de l'élément et un QR unique.
3. **Given** aucune sélection, **When** je tente de générer, **Then** l'action est bloquée (bouton désactivé ou message), aucun document vide n'est produit.
4. **Given** un QR généré pour un élément, **When** il est relu par l'acquisition (Story 1), **Then** la catégorie, la cible de classement et l'identifiant sont retrouvés sans ambiguïté.
5. **Given** la catégorie « Séparateur vierge », **When** je génère, **Then** une page séparatrice sans cible de classement est produite (QR « blank »).

---

### User Story 3 - Recherche multi-critères & export (Priority: P3)

En tant qu'**utilisateur métier / documentaliste**, je consulte la liste des documents dans une grille que je filtre, regroupe et trie ; je recherche en plein texte (libellé, cote, texte OCR), j'ouvre un document, et j'exporte le résultat affiché en Excel, PDF, Word ou CSV. Je ne vois que les documents auxquels j'ai au moins un droit de consultation.

**Why this priority**: Délivre la valeur de restitution / consultation. Elle peut s'appuyer sur des données déjà présentes (acquises ou reprises), mais arrive après la capacité à archiver. Elle introduit aussi le contrôle d'accès, une exigence de sécurité nouvelle.

**Independent Test**: Peut être testée avec un jeu de documents pré-chargés en vérifiant le filtrage / tri / regroupement, la recherche plein-texte sur le contenu OCR, l'ouverture d'un document, la conformité de l'export au filtre courant, et l'invisibilité des documents non autorisés.

**Acceptance Scenarios**:

1. **Given** une grille de documents, **When** j'applique un filtre, un tri et un regroupement, **Then** la grille reflète ces réglages avec pagination.
2. **Given** un terme présent uniquement dans le texte OCR d'un fichier, **When** je le recherche en plein texte, **Then** le document correspondant apparaît dans les résultats.
3. **Given** un filtre et un tri appliqués, **When** j'exporte (Excel / PDF / Word / CSV), **Then** l'export reflète exactement le filtre et le tri courants.
4. **Given** un document sur lequel je n'ai aucun droit, **When** je consulte la grille, **Then** ce document n'apparaît pas et je ne peux pas l'ouvrir.
5. **Given** un document visible, **When** je clique sur son libellé, **Then** sa fiche/visionneuse s'ouvre en résolvant la version courante et ses fichiers.

---

### Edge Cases

- **Lot sans aucun intercalaire** : toutes les pages sont rattachées à un unique document « sans type » du dossier choisi.
- **Pages avant le premier intercalaire** : forment un document distinct (« K+1 »).
- **QR illisible / abîmé** : la page est traitée comme une page sans QR (rattachée au document courant) ; le niveau de correction d'erreur du QR doit limiter ce cas.
- **QR étranger sur la feuille** (autre QR non issu de l'application) : ignoré grâce à la validation de l'espace de noms et de la version du contrat QR.
- **QR de version ou d'espace de noms inconnus** : rejeté au scan.
- **Extension de fichier inconnue** : crée un type de fichier sans doublon.
- **Création de dossier en doublon** (libellé déjà actif) : refusée.
- **Reprise/rejeu d'un lot** : le traitement d'un lot doit pouvoir être relancé sans créer de doublons (idempotence par lot).
- **Export d'une grille vide / filtre sans résultat** : export valide mais vide, sans erreur.
- **Document gelé (legal hold)** : marqué comme tel ; comportement de modification réservé (hors périmètre v1).

## Requirements *(mandatory)*

### Functional Requirements

#### Génération d'intercalaires (Story 2)

- **FR-001**: Le système MUST permettre de choisir une catégorie d'élément parmi : type de document, plan de classement, localisation, dossier, séparateur vierge.
- **FR-002**: Le système MUST charger la liste des éléments correspondant à la catégorie choisie ; les catégories hiérarchiques (plan, localisation) MUST être présentées en arbre indenté respectant la hiérarchie, racine virtuelle exclue.
- **FR-003**: Le système MUST permettre la sélection multiple d'éléments.
- **FR-004**: Le système MUST produire un document imprimable contenant exactement une page par élément sélectionné, chaque page portant le libellé de la catégorie, le libellé de l'élément et un QR code unique.
- **FR-005**: Le système MUST encoder dans chaque QR un contrat permettant de retrouver sans ambiguïté la catégorie, la cible de classement et l'identifiant de l'élément. Le contrat MUST inclure un espace de noms et une version validables à la lecture, et rester en caractères ASCII pour la fiabilité d'encodage/lecture.
- **FR-006**: Le système MUST empêcher la génération lorsqu'aucun élément n'est sélectionné (aucun document vide produit).
- **FR-007**: Le système MUST produire une feuille « séparateur vierge » sans cible de classement lorsque la catégorie « vierge » est choisie.

#### Acquisition par lot (Story 1)

- **FR-008**: Le système MUST permettre de choisir un dossier de destination, existant (sélection en cascade parent → enfant) ou nouveau (créé à la volée).
- **FR-009**: Le système MUST refuser la création d'un nouveau dossier dont le libellé est déjà utilisé par un dossier actif (règle anti-doublon).
- **FR-010**: Le système MUST permettre le téléversement de plusieurs fichiers PDF avec indication de progression.
- **FR-011**: Le système MUST matérialiser chaque session d'acquisition comme un **lot** distinct (opérateur, date de numérisation, dossier cible), auquel tous les documents et fichiers produits sont rattachés.
- **FR-012**: Le système MUST traiter les fichiers dans l'ordre de numérisation (tri par nom de fichier).
- **FR-013**: Le système MUST découper le lot en documents d'après les feuilles d'intercalaires, en lisant le QR de la page de séparation (intercalaire mono-page). Il MUST gérer les quatre catégories ouvrantes — type de document, plan de classement, localisation, dossier — en appliquant l'attribut correspondant au(x) document(s) suivant(s).
- **FR-014**: Un intercalaire « vierge » MUST agir comme séparateur (clôt le document courant sans changer d'attribut).
- **FR-015**: Une page sans QR MUST être rattachée au document courant ; si aucun document n'est ouvert, le système MUST ouvrir un document « sans type ».
- **FR-016**: Un intercalaire de catégorie « dossier » MUST rattacher les documents suivants au dossier encodé, qui prévaut sur le dossier choisi à l'ouverture pour ces documents.
- **FR-017**: Pour chaque fichier réel, le système MUST extraire le texte (OCR), résoudre ou créer le type de fichier d'après l'extension (sans doublon), et stocker le binaire (le contenu n'est pas conservé en base).
- **FR-018**: Chaque document créé MUST être marqué « en attente de validation qualité », rattaché à son dossier et à son lot, et porter l'opérateur comme créateur.
- **FR-019**: À la fin du traitement, le système MUST mettre à jour les compteurs et le statut du lot, et orienter vers l'étape de validation/indexation (hors périmètre v1 ; lien et données prévus).
- **FR-020**: Le traitement d'un lot SHOULD être idempotent (re-jouable sans créer de doublons).

#### Recherche & export (Story 3)

- **FR-021**: Le système MUST présenter les documents dans une grille avec au minimum les colonnes : libellé (lien d'ouverture), type de document, référence (cote), date document, dossier, plan de classement, localisation.
- **FR-022**: Le système MUST offrir filtrage, recherche, regroupement, tri et pagination sur la grille.
- **FR-023**: Le système MUST offrir une recherche plein-texte portant sur le libellé, la cote et le texte OCR des fichiers.
- **FR-024**: Le système MUST permettre d'ouvrir un document (fiche/visionneuse) en résolvant la version courante et ses fichiers.
- **FR-025**: Le système MUST permettre d'exporter le contenu affiché de la grille en Excel, PDF, Word et CSV, l'export reflétant exactement le filtre et le tri courants.
- **FR-026**: Le système MUST n'afficher (et n'autoriser à l'ouverture) que les documents pour lesquels l'utilisateur dispose d'au moins un droit de consultation, via une habilitation par document ou par type de document.
- **FR-027**: Le système MUST appliquer une politique d'habilitation **« refus par défaut »** (deny-by-default) : un document n'est visible et ouvrable que si l'utilisateur dispose d'un droit explicite, par document ou par type de document. En l'absence de tout droit, le document est invisible.
- **FR-028**: Les **administrateurs** MUST disposer d'un accès complet (voient et ouvrent tous les documents), indépendamment des droits par document/type.
- **FR-029**: À l'acquisition, le **groupe créateur** (opérateur/profil ayant produit le lot) MUST recevoir automatiquement au moins un droit de consultation sur les documents créés, afin qu'ils restent accessibles à leur producteur sous le régime « refus par défaut ».

#### Référentiels, sécurité & audit (transverse)

- **FR-030**: Le système MUST gérer les référentiels nécessaires : types de document, plan de classement (hiérarchique), localisation (hiérarchique), dossiers (hiérarchiques, avec catégories et motifs de sortie), types de fichiers, et le référentiel des catégories d'intercalaire (contrat QR).
- **FR-031**: Les référentiels hiérarchiques MUST permettre de représenter et de restituer des sous-arbres et un rendu indenté reflétant la profondeur.
- **FR-032**: Le système MUST garantir l'intégrité référentielle entre documents, versions, fichiers, lots et référentiels (relations réellement contraintes), ainsi que l'unicité métier sur le libellé de dossier actif, le libellé de type de document actif et l'extension de type de fichier.
- **FR-033**: Le système MUST gérer utilisateurs, profils/groupes et l'identité applicative effective servant d'acteur à toutes les actions tracées.
- **FR-034**: Le système MUST authentifier les utilisateurs et stocker les secrets d'authentification sous forme non réversible (hachage), sans conserver de mot de passe en clair.
- **FR-035**: Le système MUST journaliser les actions : trace de navigation/consultation et trace de modification des données (qui a changé quoi, ancienne/nouvelle valeur).
- **FR-036**: Le système MUST distinguer la **date métier** d'un document (affichée à la recherche) de la **date système** de création, et conserver l'année d'archivage.
- **FR-037**: Le système MUST valider tout QR lu : espace de noms et version reconnus, et catégorie validée contre le référentiel des catégories d'intercalaire ; tout QR non conforme MUST être rejeté.

### Key Entities *(include if feature involves data)*

- **Document** : unité documentaire archivée ; porte libellé, cote, date métier, année d'archivage, statut d'archivage (en attente / validé), indicateur de gel ; rattaché à un type, un plan, une localisation, un dossier, un lot, et un créateur.
- **Version de document** : version d'un document ; une seule version « courante » à la fois ; regroupe les fichiers.
- **Fichier de document** : fichier physique d'une version ; porte nom d'origine, extension, type de fichier, nombre de pages, ordre dans le lot, et **texte OCR** alimentant la recherche plein-texte ; binaire stocké hors base.
- **Lot d'acquisition** : session de numérisation ; porte opérateur, date de scan, dossier cible, compteurs et statut ; regroupe les documents et fichiers d'un même téléversement.
- **Type de document** : référentiel plat de classification des documents.
- **Plan de classement** : référentiel hiérarchique (thématique) d'indexation.
- **Localisation** : référentiel hiérarchique (physique) d'indexation.
- **Dossier** : conteneur hiérarchique de classement des documents ; porte une catégorie et une localisation ; libellé unique parmi les actifs.
- **Catégorie de dossier** / **Motif de sortie de dossier** : référentiels associés au dossier (motif de sortie réservé, sous-système prêt hors périmètre).
- **Type de fichier** : référentiel des extensions et de leurs caractéristiques ; une extension unique par type.
- **Catégorie d'intercalaire** : contrat QR ; mappe la catégorie encodée (type document / plan / localisation / dossier / vierge) vers la cible de classement.
- **Utilisateur**, **Groupe/Profil**, **Identité applicative (utilisateur-groupe)** : sécurité et acteur des actions.
- **Niveau de permission**, **Habilitation par type de document**, **Habilitation par document** : contrôle d'accès à la consultation.
- **Action d'audit**, **Journal de navigation**, **Journal de modification de données** : audit et traçabilité.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Un lot de N fichiers comportant K intercalaires « ouvrants » produit le nombre de documents attendu (K, ou K+1 si des pages précèdent le premier intercalaire), chacun avec le bon attribut de classement, dans 100 % des cas testés.
- **SC-002**: Au moins 99 % des QR conformes générés par l'application sont relus et interprétés correctement à l'acquisition (catégorie, cible, identifiant) sur des liasses imprimées puis numérisées.
- **SC-003**: 100 % des QR non conformes (espace de noms, version ou catégorie invalides, QR étrangers) sont rejetés sans corrompre le découpage.
- **SC-004**: Un utilisateur ne voit et n'ouvre jamais un document sur lequel il n'a aucun droit de consultation (0 fuite, vérifié sur jeu de tests d'habilitation).
- **SC-005**: Un export reproduit fidèlement le filtre et le tri affichés (100 % de concordance lignes/colonnes/ordre) dans les quatre formats (Excel, PDF, Word, CSV).
- **SC-006**: La recherche plein-texte retrouve un document à partir d'un terme présent uniquement dans son texte OCR.
- **SC-007**: La grille de recherche reste utilisable (réponse perçue rapide, sans dégradation visible) à l'échelle observée du fonds (≈ 42 000 documents, ≈ 93 400 fichiers).
- **SC-008**: La génération d'intercalaires ne produit jamais de document vide (sélection vide systématiquement bloquée).
- **SC-009**: La création d'un dossier en doublon de libellé actif est refusée dans 100 % des cas.
- **SC-010**: Tous les documents et fichiers d'un même téléversement partagent le même identifiant de lot dans 100 % des cas.

## Assumptions

- **Périmètre — métadonnées d'indexation** : explicitement hors périmètre ; la recherche s'appuie uniquement sur les attributs natifs du document et le texte OCR (décision R3/D11 du PRD).
- **Périmètre — validation qualité (QA) / indexation fine** : hors périmètre v1 ; les données nécessaires (statut d'archivage, validateur, date, date métier) sont prévues pour un ajout ultérieur.
- **Périmètre — sous-systèmes réservés** : workflow, courrier, prêts de dossiers, signature électronique, sécurité PDF : non exploités ; liaisons conservées en réserve, sans fonctionnalité.
- **Intercalaire mono-page** : chaque intercalaire est une feuille unique portant un seul QR ; la lecture se fait sur cette page de séparation (décision R5/D13).
- **Contrat QR** : nouveau format ASCII versionné, sans compatibilité avec le format legacy ; le choix de représentation exacte (délimité compact vs JSON extensible) est laissé à l'implémentation et n'affecte pas le périmètre fonctionnel (points R8/D12). Niveau de correction d'erreur élevé recommandé pour la robustesse à l'impression/photocopie.
- **Stockage des binaires** : sur disque (hors base), nommage déterministe par identifiant de fichier ; la base ne conserve pas le contenu binaire (décision D1).
- **Horodatages** : par défaut en temps universel (UTC) ; à confirmer si l'usage suppose l'heure locale (point R7/D10 — défaut retenu : UTC).
- **Traitement de l'acquisition** : OCR et lecture QR étant coûteux, le traitement est idéalement asynchrone avec progression ; l'exigence fonctionnelle ne dépend pas du mode (synchrone/asynchrone).
- **Reprise de données legacy** : possible mais traitée comme un chantier de migration séparé (nettoyage des références orphelines, conversion des hiérarchies, regroupement des lots, report des dates et du texte OCR) ; non couvert par cette spécification fonctionnelle.
- **Authentification** : un mécanisme d'authentification standard est supposé disponible ; les secrets sont stockés hachés.
- **Volumétrie cible** : le système doit tenir l'échelle observée (≈ 42 000 documents, ≈ 42 000 versions, ≈ 93 400 fichiers, ≈ 10 400 lots, ≈ 285 000 lignes de journal) et croître au-delà.
