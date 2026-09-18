# DocuPro V6 — Documentation applicative

> Document de référence unique : vue d'ensemble, inventaire des pages et de leurs éléments
> d'interface, fonctionnalités, stack technologique.
> Établi par lecture du code (`apps/`, `packages/`), des specs (`specs/001-archivage-qr/`) et de `docs/`.
> État : module Archivage QR livré (61/61 tâches), module Docu-Courriers livré (phases A→G).

---

## Sommaire

1. [Vue d'ensemble](#1-vue-densemble)
2. [Inventaire des pages et éléments UI](#2-inventaire-des-pages-et-éléments-ui)
3. [Fonctionnalités](#3-fonctionnalités)
4. [Stack technologique](#4-stack-technologique)
5. [Annexes — concepts métier et pièges connus](#5-annexes--concepts-métier-et-pièges-connus)

---

# 1. Vue d'ensemble

## 1.1 Ce qu'est l'application

DocuPro V6 est la **réimplémentation neuve** d'une GED/SAE legacy (DocuPro Suite V7 —
ASP.NET WebForms VB.NET / SQL Server, ~200 contrôles, ~190 tables). Elle couvre aujourd'hui
**deux domaines applicatifs distincts**, réunis dans une même interface :

| Domaine | Nom dans l'UI | Objet |
|---|---|---|
| **Docu-Archives** | « Archivage par QR » | Chaîne d'archivage par numérisation de masse pilotée par **QR codes** : du papier au document numérique classé et recherchable. |
| **Docu-Courriers** | « Courriers » | **Cycle de vie du courrier** d'une institution (Arrivée / Départ / Interne) : enregistrement, scan, imputation, parapheur, validation, décharge, suivi, archivage. |

Le second est le portage d'un module source ASP.NET Zero/ABP (contexte « DocuPro SENAT »).

## 1.2 Utilisateurs cibles

| Rôle | Usage principal |
|---|---|
| **Agent de numérisation** | Imprimer les intercalaires (P1), téléverser les lots scannés (P2). |
| **Documentaliste / archiviste** | Choix du dossier, contrôle, indexation (P2), recherche et export (P3). |
| **Utilisateur métier** | Recherche et consultation des documents. |
| **Administrateur** | Référentiels, utilisateurs, rôles, habilitations. |
| **Bureau d'ordre** (Courriers) | Enregistrement, contrôle, imputation. |
| **Agents imputés / Direction / DG** (Courriers) | Traitement, validation hiérarchique, décharge. |

## 1.3 Problèmes résolus par rapport au legacy

1. **Chaîne d'archivage fragile** — procédures stockées fragiles, hiérarchies nested-set
   « lock-heavy » (transactions `SERIALIZABLE` renumérotant toute la table), `TINYINT`
   saturable sur `file_type` (plafond 255 + auto-création sur extension inconnue).
   → V6 : **liste d'adjacence + chemin matérialisé**, `INT`, unicité sur l'extension.
2. **Absence quasi totale de clés étrangères** — intégrité gérée par le code applicatif.
   → V6 : FK, CHECK, index uniques partiels.
3. **Faille de sécurité majeure** — l'écran de recherche legacy (`Recherche_MiltiNew`)
   exposait **tous** les documents sans contrôle d'accès.
   → V6 : modèle d'habilitation explicite (voir §1.6 pour l'état réel).
4. **Fonctionnalités bridées** — le découpage par QR legacy n'activait **que** la catégorie
   « type de document ». → V6 : les **4 catégories ouvrantes** sont honorées.

Volumétrie du fonds à reprendre : ~42 000 documents, ~42 000 versions, ~93 400 fichiers,
~10 400 lots, ~285 000 lignes de journal de navigation.

## 1.4 Workflow Docu-Archives (bout en bout)

```
P1  Génération d'intercalaires QR  (/intercalaires)
       ↓  impression + insertion des feuilles dans la liasse papier
    Numérisation au scanner  →  PDF
       ↓
P2  Acquisition par lot  (/acquisition)
       • upload multi-PDF vers un dossier cible (existant ou créé à la volée)
       • création d'un LOT (acquisition_batch, status=0) + job BullMQ
       • worker : tri par nom → rastérisation page → décodage QR → découpage
                  → OCR → stockage disque → rattachement → auto-grant ACL
       • compteurs et statut mis à jour (1 terminé / 2 échec)
       ↓
    Indexation & validation  (modale plein écran)
       • indexation commune appliquée en masse + édition fine par document
       • « À indexer » (orange) → « Validé » (vert, archivé)
       ↓
P3  Recherche, consultation, export  (/search)
       • plein-texte (libellé + cote + texte OCR) + filtres + tri + pagination serveur
       • ouverture → version courante → streaming du binaire
       • export Excel / CSV / PDF / Word reflétant filtre et tri courants
```

**Règles de découpage** (cœur du produit) :

| Élément lu sur la page | Effet |
|---|---|
| QR de catégorie **ouvrante** (`TYPE_DOCUMENT`, `PLAN`, `LOCALISATION`, `DOSSIER`) | Clôt le document courant, **ouvre un nouveau document**, applique l'attribut. **`DOSSIER` prévaut** sur le dossier choisi à l'upload. |
| QR **`BLANK`** | Séparateur pur : clôt le document courant, sans changer d'attribut. |
| Page **sans QR** (ou QR illisible / étranger / ignoré) | Rattachée au document courant ; si aucun document ouvert → création d'un document « sans type ». |

Un lot de N fichiers avec K intercalaires ouvrants produit **K documents** — ou **K+1** si des
pages précèdent le premier intercalaire.

## 1.5 Workflow Docu-Courriers

```
        ┌──────────────── FLUX ARRIVÉE ────────────────┐
[Scan] → Documents scannés → Enregistrement → Contrôle (Courriers arrivés)
                                                   ↓
                              Imputation / Parapheur électronique
                                                   ↓
              Suivi → Validation (Direction / DG) → Décharge / Intégration → Archivage

        ┌──────────────── FLUX DÉPART ─────────────────┐
[Scan] → Documents scannés → Courrier de départ ───────┘

Recherche multicritère = transverse à tout le cycle
```

L'état d'un courrier **n'est pas porté par une seule colonne**. Il résulte de la combinaison :

- **`MailStatus`** : `0 Rédaction`, `1 Rédigé`, `2 Déchargé`, `3 Traité`, `4 Supprimé`
  (ce dernier n'est jamais affecté — le soft-delete passe par `is_deleted`) ;
- **`MailType`** : `0 Arrivée`, `1 Départ`, `2 Interne` ;
- **5 drapeaux booléens** : `valider`, `validation_direction`, `validation_dg`,
  `enregistrement_reponse`, `decharge` — chacun définit une file de travail ;
- **6 dates** : `date_enregistrement_courrier`, `date_follow_up`, `end_date_follow_up`,
  `date_decharge`, `date_traited`, `date_butoire`.

## 1.6 Modèle d'accès — état réel

Trois mécanismes coexistent. **Le contrôle effectif repose aujourd'hui sur le RBAC de menus.**

| Mécanisme | Portée | État |
|---|---|---|
| **JWT global** (`JwtAuthGuard` en `APP_GUARD`) | Toutes les routes sauf `@Public()` (`/auth/login` seul) | ✅ actif |
| **RBAC de menus** (`MenuPermissionGuard`) | Règle « accès au menu ⟹ accès aux données ». `effectiveMenuKeys()` est partagé par `/auth/me` et le guard, pour éviter toute dérive entre ce qui s'affiche et ce qui est accessible. | ✅ actif — **c'est le contrôle réel** |
| **ACL documentaire** (`document_permission` / `document_type_permission`, 5 niveaux) | Par document / par type | ⚠️ **modélisée et alimentée, mais court-circuitée** |

> ⚠️ **Point d'attention.** `documents.service.ts` et `search.service.ts` documentent un
> **override volontaire du deny-by-default** (décision D-17, 2026-06-17) : `canAccess` ne
> vérifie que l'existence, et `buildWhere` n'applique aucun filtre ACL. Tout utilisateur
> connecté accède donc à tous les documents. De même, `analytics.service.ts` retourne
> `aclCond() → null` : les chiffres du tableau de bord Archives sont globaux.
> `mail_permission` (ACL par courrier) existe en base mais est **inactive en v1**.

**Périmètre de visibilité courrier (`MailScope`)** — deux permissions *alternatives* :
`/courriers/suivi` (tous les courriers, `scope = all`) et `/courriers/suivi-dc` (uniquement
mes imputations, `scope = imputed`). `/courriers/suivi-dc` **n'est pas une route** mais une
permission de périmètre : elle ouvre le même écran avec moins de données. Le « suivi
permanent » l'emporte si les deux sont accordées.

> 📌 **Sur « P1 / P2 / P3 »** — ce ne sont **pas** des niveaux de confidentialité, contrairement
> à ce que suggère une lecture rapide du `CLAUDE.md`. Ce sont les **trois phases produit** :
> P1 = intercalaires, P2 = acquisition, P3 = recherche/export (et, dans la spec Spec-Kit, les
> priorités des user stories). La confidentialité est un simple référentiel du module
> Courriers (`mail_confidentialite`), **purement informatif** : aucune règle d'accès ne s'y adosse.

## 1.7 Architecture

**Monorepo TypeScript** (pnpm workspaces + Turborepo), **monolithe modulaire + worker asynchrone** :

```
apps/
  web/      Next.js (App Router) + React 19 + Ant Design v5 (fr_FR) + Tailwind   → :5000
  api/      NestJS REST + zod + guards JWT                                        → :3001/api
            modules : acquisition, analytics, audit, auth, courriers, documents,
                      intercalaires, notifications, prisma, queue, referentials,
                      roles, search, users
  worker/   Node + BullMQ (OCR / décodage QR / découpage PDF / rappels courriers)
packages/
  db  qr  pdf  ocr  exports  storage  types  ui  config  mailer
storage/archives/   binaires hors base, nommés {file_id}{extension}
```

---

# 2. Inventaire des pages et éléments UI

**39 pages** (`page.tsx`), dont 4 dynamiques `[mailId]`, 2 redirections et 2 routes temporaires.

## 2.0 Chrome applicatif (commun à toutes les pages sauf `/login`)

### `RootLayout` → `Providers` → `AuthShell`

- **`Providers`** — `ConfigProvider` Ant Design locale **`fr_FR`**, thème `buildTheme(mode)`,
  `MotionConfig reducedMotion="user"`, `App` (toasts / confirm). Contexte de thème
  **clair/sombre** persisté dans `localStorage['da-theme']`.
- **`AuthShell`** — double garde :
  1. **Authentification** : lit `localStorage.token`. Sur `/login` avec token → `/dashboards` ;
     hors `/login` sans token → `/login`. Sinon `getMe()` puis affichage.
     Écran d'attente : `LogoIcon` + `Spin`.
  2. **Autorisation** : `me.menuKeys` → filtrage des entrées de `NAV`. `/dashboards` reste
     toujours visible ; une section vide est masquée. Si `menuKeys` est absent (backend
     ancien) ⇒ **aucun filtrage**. Le frontend ne fait que masquer — le back applique ses
     propres gardes.
- **Sidebar** — `Sider` clair 264 px (76 px replié), sticky pleine hauteur, état persisté dans
  `localStorage['da-sider-collapsed']`. `Menu mode="inline"`, sections en **accordéon** (une
  seule ouverte, celle de la route courante). Mobile (`< lg`) : `Drawer` gauche 280 px.
- **`TopBar`** — barre sticky 60 px : bouton menu mobile, titre de page dérivé de
  `activeItem`, déclencheur de palette (`Ctrl K`), `NotificationsBell`, bascule de thème,
  `Dropdown` utilisateur (identité + Déconnexion).
- **`CommandPalette`** — `Modal` sans chrome, `⌘K` / `Ctrl+K`. Sources : `NAV` aplati + 3
  actions (« Démarrer un nouveau lot », « Générer des intercalaires », « Rechercher des
  documents »). Filtrée par `allowedKeys`, navigation ↑↓ / Entrée / Échap.
- **`NotificationsBell`** — `Badge` + `Dropdown` : polling 60 s du compteur de non-lus, inbox
  10 lignes, « Tout marquer lu », marquage au clic.
- **Badges de menu** — polling **120 s** de `getBadges()`. 6 entrées portent un compteur
  (`overflowCount=99`). Le cumul **remonte sur le titre de section quand elle est repliée**,
  pour ne jamais masquer une alerte.

### Structure de navigation

Source unique : [`apps/web/app/components/nav.ts`](../apps/web/app/components/nav.ts), consommée
par la sidebar, le drawer mobile **et** la palette de commandes.

```
┌ Docu-Archives
│   • Tableaux de bord          /dashboards                          ← toujours visible
│   • Acquisition par lot       /acquisition
│   • Recherche                 /search
├ Docu-Courriers
│   • Tableau de bord           /courriers/tableau-de-bord
│   • Enregistrement            /courriers/enregistrement
│   • Courriers arrivés         /courriers/controle                  🔔 controle
│   • Documents scannés         /courriers/documents-scannes         🔔 scans
│   • Courriers Imputés         /courriers/parapheur                 🔔 parapheur
│   • Suivi des courriers       /courriers/suivi                     🔔 suivi
│                                 └ alt : /courriers/suivi-dc  (périmètre restreint)
│   • Validation                /courriers/validation                🔔 validation
│   • Recherche courrier        /courriers/recherche
│   • Courrier de départ        /courriers/depart
│   • Intégration décharge      /courriers/integration-decharge      🔔 decharge
├ Paramétrage Archives
│   • Géolocalisation           /admin/geolocalisation
│   • Plan de classement        /admin/classification-plans
│   • Catégories de dossier     /admin/dossier-categories
│   • Dossiers                  /admin/dossiers
│   • Types de document         /admin/document-types
│   • Intercalaires             /intercalaires
├ Paramétrage Courrier
│   • Organigrammes             /admin/courriers/organigrammes
│   • Rôles ↔ organigramme      /admin/courriers/role-organigramme
│   • Types d'entité externe    /admin/courriers/types-entites-externes
│   • Entités externes          /admin/courriers/entites-externes
│   • Types d'imputation        /admin/courriers/types-imputation
│   • Types de courrier départ  /admin/courriers/types-depart
└ Administration
    • Utilisateurs              /admin/users
    • Rôles                     /admin/roles
```

**Résolution de l'item actif** : `activeItem(pathname)` retient la clé la plus longue
correspondant en préfixe — une route `[mailId]` reste donc rattachée à son entrée de menu.

---

## 2.1 Racine et système

| URL | Fichier | Objet |
|---|---|---|
| `/` | `app/page.tsx` | Redirection serveur → `/dashboards` |
| `/login` | `app/login/page.tsx` | Connexion (rendue **hors** du shell) |
| `/design` | `app/design/page.tsx` | Showcase du design system — **route temporaire** |
| `/dev/pdf-viewer` | `app/dev/pdf-viewer/page.tsx` | Banc d'essai de la visionneuse — **temporaire** |

### `/login` — Connexion

- **Ant Design** : `Form` (vertical, `size="large"`), `Input` (préfixe icône), `Input.Password`,
  `Button` (block, primary), `Alert`, `Grid.useBreakpoint`, `Typography`.
- **Mise en page** : panneau de marque à gauche (SVG QR décoratif, dégradé
  `--da-brand-from/to`), formulaire à droite. Bandeau compact en mobile.
- **Actions** : « Se connecter » → `POST /auth/login`, stocke `accessToken` dans
  `localStorage.token`, redirige vers `/dashboards`. **Trim** des identifiants (autofill
  Edge/Chrome).

### `/design` — Showcase design system (temporaire)

Sections `Card` : couleurs (Encre / Ocre / Fond / Bordure / Succès / Avertissement / Danger),
typographie (Bricolage Grotesque, Geist, Geist Mono), boutons, contrôles de formulaire,
badges de statut, tableau, squelette, état vide, mouvement (stagger), et un **pipeline
d'acquisition interactif** (`Segmented` de phase + `BatchPipeline`).

---

## 2.2 Docu-Archives

### `/dashboards` — Tableaux de bord archivage

- **Ant Design** : `Row` / `Col`, `Typography`. Composants maison `ChartCard`, `CardsSkeleton`.
- **En-tête** : `PageHeader` (icône `dashboard`) + KPI « documents archivés » en gros chiffre
  monospace vert.
- **3 cartes graphiques** (type et dossier côte à côte, plan sur toute la largeur) :
  - « Répartition par type de document » — `TypeDonut` (anneau)
  - « Répartition par dossier » — `DistributionBars`
  - « Répartition par plan de classement » — `DistributionBars`
- Chargement indépendant par carte : squelette animé, état vide « Aucune donnée pour cette
  période », toast d'erreur.
- ⚠️ Période **figée à 30 j** : le `useState` n'expose pas de setter, le composant
  `PeriodFilter` est écrit mais **pas branché**. `basis='created_at'`, granularité `day`.

### `/acquisition` — Acquisition par lot (P2)

Page la plus riche (1 097 lignes), structurée en 3 étapes.

**Ant Design** : `Steps`, `Segmented`, `Select`, `TreeSelect`, `Upload.Dragger`, `Card`,
`Alert`, `Tooltip`, `Tag`, `Table`, `Modal`, `Row`/`Col`, `Input`, `Space`.

**Étape 1 — formulaire de lot**
- `Segmented` **mode d'acquisition** : « Sans intercalaire » (fusion de tous les PDF en
  **1 document**, sans OCR ni découpage) / « Avec intercalaires (QR + OCR) ».
- `Select` **Grand dossier** (racines) → filtre le `TreeSelect` **Dossier de destination**
  (les deux obligatoires en mode simple).
- `Upload.Dragger` multiple, PDF uniquement, compteur « N fichier(s) · X Mo ».
- Bouton **« Lancer le traitement »** avec `Tooltip` d'aide s'il est désactivé.

**Étape 2 — traitement**
- Composant **`BatchPipeline`** : barre `Progress` composite (upload 0→30 %, traitement
  30→95 %, « creep » temporel).
- **Polling** `GET /batches/:id` toutes les 2 s, jusqu'à ~30 min (900 tours).
- En cas d'échec : `Alert` erreur + bouton « Relancer le traitement ».

**Étape 3 — récapitulatif**
- `Tag` « N document(s) » + « X/N validé(s) ».
- `Table` — colonnes : **Document** (lien → modale), **N° pièce** (mono), **Type**,
  **Pages**, **Statut** (`StatusBadge`).

**Modale d'indexation** (`width="94%"`, ouverte **automatiquement une fois par lot**)
- **Gauche** : `PdfViewer` du document sélectionné.
- **Droite, carte « Indexation commune »** : *N° pièce*, *Date du document* (`DateMaskInput`),
  *Type de document* (`Select`), *Plan de classement* (`TreeSelect`), *Dossier* (`TreeSelect`),
  *Description* + bouton **« Appliquer à tous »** (un champ vide n'est pas modifié).
- **Droite, `Table` éditable par document** — colonnes : œil (ligne active), **Type de
  document**, **Date document**, **Description**, **N° pièce**, **Classement**, **Dossier**,
  **Statut**.
- **Pied** : compteur validés, mention « modifications non enregistrées », boutons
  **« Valider tout le lot »** / **« Valider le document »**.
- **Contrôle de doublons de cote** avant validation (`POST /documents/cotes/check`) →
  `Modal.confirm` **non bloquant**.
- **Navigation clavier** : ← / ↑ et ↓ / → changent de document, Entrée enregistre.
  Garde-fou « modifications non enregistrées » à la fermeture.

### `/search` — Recherche documentaire et export (P3)

937 lignes.

**Ant Design** : `Input` (size large, préfixe loupe), `Collapse` (« Filtres avancés », ouvert
par défaut), `Select`, `TreeSelect` ×4, `RangePicker`, `Tag` (chips fermables animés via
`AnimatePresence`), `Table`, `Modal`, `Descriptions`, `Popconfirm`, `Alert`, `Space`.

- **Barre plein-texte** — recherche sur libellé + cote + texte OCR, validation par Entrée.
- **Filtres avancés** : *Type de document*, *Dossier*, *Plan de classement*, *Localisation*,
  *Type de fichier*, *Ajouté par*, *Date du document* (plage).
- **Chips de filtres actifs** individuellement fermables + lien « Tout effacer ».
- **Colonnes** : **Libellé** (lien → modale), **Type de document**, **N° pièce** (mono),
  **Date document**, **Dossier**, **Plan de classement** — toutes `sorter: true` (**tri
  serveur**), pagination serveur 10/20/50/100 avec total.
- **Exports** : **Excel**, **CSV**, **PDF**, **Word** (`POST /documents/export`) — désactivés
  si 0 résultat.
- **Modale de détail** (`width="88%"`) : `PdfViewer` à gauche ; à droite, indexation en
  `Descriptions` (Libellé, Type, N° pièce, Date, Dossier, Plan, **Fichier (ARCHIVES)**)
  commutable en **mode édition** (Input / Select / TreeSelect / DatePicker) →
  `PATCH /documents/:id/indexation`. Pied : **« Supprimer »** (`Popconfirm`, **admin
  uniquement**, garde via `/auth/me`), « Ouvrir dans un nouvel onglet », « Fermer ».
- **Distinction brouillon / critères appliqués** : la recherche ne part qu'au clic
  « Rechercher », sur Entrée, ou à la suppression d'une puce.

### `/intercalaires` — Génération d'intercalaires QR (P1)

**Ant Design** : `Card` ×3, `Space`, `Badge`, `Checkbox`, `Input` (filtre), `Button`.

Layout **3 colonnes** :
1. **Catégorie** — boutons custom avec icône dérivée du code (Type de document, Plan de
   classement, Localisation, Dossier, Séparateur vierge).
2. **Éléments** — liste à cases à cocher, **indentée par `depth`**, filtre texte,
   « Tout sélectionner / désélectionner », `Badge` du nombre sélectionné.
3. **Aperçu de la feuille** — vignette A4 (ratio 1/1.414) avec QR mock SVG.

- Cas « séparateur vierge » (`isBlank`) : pas de sélection, une feuille unique.
- **Barre d'action collante** en bas : compteur + « Tout désélectionner » +
  **« Générer le PDF »** → `POST /intercalaires/generate`, blob ouvert dans un nouvel onglet.

---

## 2.3 Docu-Courriers — écrans opérationnels

### `/courriers/tableau-de-bord` — Tableau de bord personnalisable

**Ant Design** : `Alert`, `Button`, `Skeleton`, `Space`, `Tooltip`, `Modal` (via
`ModaleAjoutWidget`).

- **Grille personnalisable** : `react-grid-layout` v2 (`ResponsiveGridLayout`, breakpoints
  lg/md/sm/xs à 1200/996/768/480, cols 12/12/6/4, `rowHeight` 30). Chargée en
  `dynamic({ ssr: false })`.
- **Mode édition** : « Personnaliser » → « Ajouter un widget » / « Réinitialiser » /
  « Annuler » / « Enregistrer ». Poignée de glissement dédiée `.tdb-poignee` + bouton de
  retrait par widget. L'agencement est persisté **côté serveur** dans `user_setting`
  (clé `dashboard.courriers.layout`) — aucune table ne modélise les widgets.
- **`PeriodFilter`** : `Segmented` (Aujourd'hui / 7 j / 30 j / Mois / Trim. / Année / Perso.)
  + `RangePicker`.

**9 widgets** (registre `widget-registry.tsx`) :

| Widget | Contenu |
|---|---|
| `alertes` | `KpiCard` : courriers en retard, imputations en retard, courriers sans imputation (masqués si 0 → `Alert` success) |
| `files` | `KpiCard` : à contrôler, parapheur, validation Direction, décharges en attente, en cours (+ « plus ancien : N j ») |
| `synthese` | 4 `KpiCard` (enregistrés, archivés, en cours, délai médian) + `Table` « Détail par type de courrier » |
| `flux` | « Entrées et sorties » + « Encours cumulé », `Segmented` de granularité |
| `repartition` | « Répartition » + « Détail », sélecteur de dimension (statut, type, correspondant, type_entite, nature, objet, confidentialite, type_depart, service) |
| `retards` | « Échéances des courriers en cours », « Ancienneté du backlog », `Table` « Retards les plus anciens » (clic → ouvre le courrier) |
| `delais` | « Délais de traitement » (médiane / P90) + « Respect des délais (SLA) » avec `Progress` |
| `charge` | `Table` « Charge par agent » + « Charge par service » (403 absorbé hors périmètre global) |
| `hygiene` | `Card` d'indicateurs de qualité de données avec liens correctifs |

- **Périmètre** (`MailScope`) résolu **côté serveur** ; `scope = 'none'` → `Alert`
  d'explication, écran vide.

### `/courriers/enregistrement` — Enregistrement d'un courrier arrivée

**Ant Design** : `Form` (vertical, `requiredMark`), `Row`/`Col` (md=12), `Input`, `DatePicker`,
`Select`, `Space.Compact`, `Upload` / `Upload.Dragger`, `Checkbox`, `Alert`, `Card`, `Spin`,
`Tooltip`. Enveloppée dans `<Suspense>` (usage de `useSearchParams`).

- **Bloc IA** (affiché seulement si `aiExtractionAvailability().enabled`, c.-à-d. si une clé
  Anthropic est configurée) : `Checkbox` « Saisie automatique par IA » → `Upload.Dragger`
  (PDF / JPG / PNG / GIF / WebP, 10 Mo) → pré-remplit titre, date, référence, expéditeur,
  rôle destinataire, description. `Alert` « Expéditeur non reconnu » si l'entité lue n'existe
  pas. Tous les champs extraits sont nullables — l'IA n'invente jamais de valeur.
- **Champs** : *Objet du courrier**, *Date du courrier**, *Date d'enregistrement** (heure
  posée à la soumission), *N° d'enregistrement** (pré-rempli par `nextArriveeReference()`),
  *Référence expéditeur**, *Expéditeur (entité externe)** avec bouton **« + »** →
  `NewExternalEntityModal`, *Destinataire** (rôle ; « (aucun utilisateur) » si le rôle est
  vide), *En copie* (multi), *Courrier numérisé (PDF)** (facultatif si l'on arrive via
  `?scanId=`), *Résumé / description*.
- **Actions** : « Enregistrer le courrier » (reste sur l'écran, réinitialise et régénère le
  numéro), « Annuler ».

### Files de travail — `/courriers/controle`, `/parapheur`, `/suivi`, `/validation`

Toutes bâties sur **`MailWorklist`** (`Card` + `Table` + `EmptyState` + `TableSkeleton`),
pagination serveur (25 par défaut ; 10/25/50/100), **sans tri d'en-tête**.

**Colonnes communes** : **N° enregistrement** (mono, 150 px), **Objet** (lien, ellipsis),
**Sens** (`MailTypeTag`), **Correspondant** (190 px), **Destinataire** (190 px),
*[Statut* (`MailStatusTag`)]*, *[Date butoir]*.

| Page | Spécificités |
|---|---|
| `/courriers/controle` | Statut + Date butoir masqués. Aucune action manuelle — la validation est automatique à l'imputation. |
| `/courriers/parapheur` | Statut + Date butoir masqués. |
| `/courriers/suivi` | Colonne supplémentaire « fiche » (bouton `download` → `FicheImputationModal`). Statut masqué. |
| `/courriers/validation` | **`rowSelection`** (cases à cocher) + bouton d'en-tête **« Marquer comme traité (N) »** (traitement par lot). Ouvre le **`MailViewer`** en **modale**, pas de page dédiée. |

### Pages de détail `[mailId]` — composant `MailDetailPage`

Un composant unique (582 lignes) paramétré par interrupteurs.

**Ant Design** : `Tabs`, `Descriptions` (2 colonnes, bordered), `List` + `Timeline`, `Drawer`
(aperçu PDF, `width="min(1100px, 96vw)"`), `Select`, `DatePicker`, `Input.TextArea`,
`Popconfirm`, `Tag`, `Empty`, `Alert`, `Space`, `Card`, `Spin`.

- **En-tête** : `PageHeader` avec fil d'Ariane + « Retour à la liste » ; **`DeadlineAlert`**
  (paliers J-7 / J-3 / J-1 / J0 / retard) ; barre de boutons (« Visualiser le courrier »,
  actions de workflow).
- **Onglet « Courrier »** : N° enregistrement, Date du courrier, Enregistré le, Correspondant,
  Destinataire, Description.
- **Onglet « Imputations (N) »** : formulaire *Rôle* → *Imputer à…* (multi, filtré par les
  porteurs du rôle) → *Type d'imputation* → *Échéance* (jour, calée `endOf('day')`) →
  *Instructions*. Liste des imputations avec `Timeline` d'historique, `Tag` Traitée / En
  attente, boutons « Traiter » et « Supprimer » (auteur seul).
- **Onglet « Fichiers (N) »** (recherche uniquement) : pièces avec `Tag` Courrier / Décharge
  signée + « Visualiser » / « Télécharger ».

Matrice de configuration :

| Route | `allowArchive` | `showWorkflowActions` | `canDeleteOwnImputations` | `canAddImputations` | `showFilesTab` | `onlyMyImputations` | `autoTreatOnOpen` |
|---|---|---|---|---|---|---|---|
| `/courriers/controle/[mailId]` | ✗ | ✗ | ✓ | ✓ | ✗ | ✗ | ✗ |
| `/courriers/parapheur/[mailId]` | ✓ | ✗ | ✗ | ✓ | ✗ | ✓ | ✓ |
| `/courriers/suivi/[mailId]` | ✗ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ |
| `/courriers/recherche/[mailId]` | ✗ | ✗ | ✗ | ✗ | ✓ | ✗ | ✗ |

**Actions de workflow** (`useMailWorkflow`, conditionnées aux drapeaux du courrier) :
*Marquer traité* (primary), *Validation DG*, *Décharger*, *Enregistrer la réponse*, *Archiver*.

### `/courriers/documents-scannes` — File des dépôts scannés

- **Ant Design** : `Upload` (bouton d'en-tête « Déposer un document », accepte
  `.pdf,.jpg,.jpeg,.png,.tiff,.tif`), `Card` (extra « Rafraîchir »), `Table`, `Modal`
  (aperçu 80 %), `Typography`.
- **Colonnes** : **Fichier** (mono, ellipsis), **Poste** (`machineName`), **Scanné le**
  (`DD/MM/YYYY HH:mm`), actions **« Consulter »** (modale `PdfViewer`, blob révoqué à la
  fermeture) et **« Enregistrer »** → `/courriers/enregistrement?scanId=…`.

### `/courriers/recherche` — Recherche dans le fonds courrier archivé

- **Ant Design** : `Input` size large, `Select` ×4, `RangePicker`, `Table`, `Card`.
- **Filtres** : plein-texte, *Sens*, *Statut*, *Correspondant*, *Nature*, *Date du courrier*
  (plage). Boutons « Rechercher » / « Réinitialiser ».
- **Colonnes** (tri serveur sur `nReference`, `title`, `mailType`, `date`) :
  **N° enregistrement** (190 px, mono), **Objet** (lien → détail), **Sens** (`MailTypeTag`),
  **Correspondant**, **Destinataire**, **Date**.
- `EmptyState` explicite : seuls les courriers **traités et archivés** figurent ici.
- ⚠️ Pas d'export sur cet écran (contrairement à `/search`).

### `/courriers/depart` — Création d'un courrier de départ

- **Ant Design** : `Form` vertical dans une `Card` « Nouveau courrier de départ »,
  `Upload.Dragger` (PDF, tenu **hors** du store du Form).
- **Champs** : *Objet du courrier**, *Date du courrier**, *Type de courrier départ*
  (déclenche `nextDepartReference` → **numérotation par type**), *N° de référence* (mono,
  « Généré si vide »), *Destinataire externe*, *Lié au courrier* (dépendant du correspondant,
  rechargé avec **garde anti-course**).
- **Actions** : « Créer le courrier de départ », « Réinitialiser ».

### `/courriers/integration-decharge` — Intégration d'une décharge signée

- **Ant Design** : `Form`, `Select` (courriers de départ sans décharge, libellé
  `Objet — Correspondant — Date — n° Réf`), `Upload.Dragger` (PDF seul, `LIST_IGNORE`), `Space`.
- **Actions** : « Intégrer la décharge » (upload scan → `integrateDecharge` → courrier
  Déchargé puis archivé), « Réinitialiser ».

---

## 2.4 Paramétrage Archives (`/admin/…`)

**Patron commun (`RefLayout`)** : `PageHeader` + boutons **Excel** / **PDF** ; `Table` à
gauche (span 15–16) ; `Card` « Nouvel élément » à droite en desktop, `Drawer` en mobile.
Édition **inline** via `EditableText` / `EditableSelect` / `EditableLocation` (validation à
Entrée/blur, champ requis restauré si vidé). Suppression avec `Popconfirm`. Pagination 10
(options 10/20/50/100). Flash de ligne (`da-row-flash`) après création. Les 3 arbres
(`locations`, `plans`, `dossiers`) sont **entièrement dépliés par défaut** (vue « organigramme »).

| Page | Colonnes | Formulaire | Export |
|---|---|---|---|
| `/admin/geolocalisation` | Nom de l'élément (éditable), Code (éditable mono), suppression | Nom\*, Parent (`TreeSelect`, vide = racine), Code\* | `/referentials/locations/export` |
| `/admin/classification-plans` | Nom de l'élément, Code (**optionnel**, peut être vidé), suppression | Nom\*, **Parent\*** (obligatoire), Code | `/referentials/plans/export` |
| `/admin/dossier-categories` | Libellé, suppression | Libellé\* | `/referentials/dossier-categories/export` |
| `/admin/dossiers` | Nom, Code, **Localisation** (`EditableLocation`), **Catégorie** (`EditableSelect`), suppression | Nom\*, Code\*, Parent, **Localisation\***, **Catégorie\*** | `/referentials/dossiers/export` |
| `/admin/document-types` | Libellé, suppression | Libellé\* | `/referentials/document-types/export` |

`/admin` redirige vers `/admin/geolocalisation`.

---

## 2.5 Paramétrage Courrier (`/admin/courriers/…`)

| Page | Colonnes | Formulaire | Particularités |
|---|---|---|---|
| `/admin/courriers/organigrammes` | **Nœud** (indenté `depth × 20`, éditable), **Parent** (`EditableLocation`), désactivation | Nom du nœud\*, Parent (`TreeSelect`) | Pas d'export ; **désactivation en cascade** du sous-arbre |
| `/admin/courriers/role-organigramme` | **Rôle**, **Organigramme assigné** (`EditableLocation`) | — (pas de création) | `Alert` explicative ; n'utilise pas `RefLayout` |
| `/admin/courriers/entites-externes` | **Nom**, **Type** (`EditableSelect`), **E-mail**, **Téléphone**, désactivation | Nom\*, Type (+ bouton « + » → `NewExternalEntityTypeModal`), E-mail, Téléphone | Correspondants |
| `/admin/courriers/types-imputation` | **Libellé** (+ `Tag` « système » verrouillé), **Suivi** (`Switch`), désactivation | Libellé\*, `Switch` « Traitement automatique à la lecture » | Types système non supprimables |
| `/admin/courriers/objets` | **Libellé**, **Suivi externe (j)** (`InputNumber` au blur), **Suivi interne (j)**, désactivation | Libellé\*, 2 × `InputNumber` | ⚠️ **masqué du menu** |
| `/admin/courriers/types-depart` | **Libellé** (éditable), désactivation | Libellé\* | Généré par `MailRefPage` |
| `/admin/courriers/types-entites-externes` | idem | Libellé\* | Généré par `MailRefPage` |
| `/admin/courriers/natures` | idem | Libellé\* | ⚠️ **masqué du menu** |
| `/admin/courriers/confidentialites` | idem | Libellé\* | ⚠️ **masqué du menu** |

> Les 3 écrans masqués sont exclus de `nav.ts` via `HIDDEN_MENU_KEYS`
> (`apps/api/src/modules/roles/menu-catalog.ts`) mais restent **atteignables par URL directe**,
> et leurs `@RequireMenu` restent fonctionnels.

---

## 2.6 Administration

### `/admin/users` — Utilisateurs

- **Ant Design** : `Row`/`Col` (15/9), `Card` « Comptes » + `Card` « Nouvel utilisateur »,
  `Table`, `Modal` d'édition, `Select`, `Input.Password`, `Tag`.
- **Colonnes** : **Nom d'utilisateur** (mono), **Nom** (`fullName`), **Adresse e-mail**
  (`Tag` warning « Aucune — pas de notification » si vide), **Rôle** (`Tag`), actions
  **Modifier** / **Supprimer** — ou mention **« Compte protégé »** pour le compte `admin`.
- **Formulaire de création** : Nom d'utilisateur\*, Prénom\*, Nom\*, Adresse e-mail\* (regex),
  Mot de passe\* (≥ 6), Rôle (rôles système exclus).
- **Modale d'édition** : mêmes champs + mot de passe optionnel (« laisser vide pour ne pas
  changer »).

### `/admin/roles` — Rôles et permissions de menu

- **Ant Design** : `Row`/`Col` (14/10), `Table` « Rôles », `Card` formulaire, **`Collapse`**
  (une section par groupe de menus, tout déplié) contenant des **`Checkbox.Group`**,
  `Tag` « Système ».
- **Colonnes** : **Rôle** (nom + `Tag` Système), actions **« Permissions »** / **« Voir »**
  (rôle système, lecture seule) + suppression.
- Compteur `sélectionnés / total` par section dans l'`extra` du panneau.
- Confirmation de suppression indiquant le **nombre d'utilisateurs impactés**.
- Le catalogue vient de `GET /roles/menus` — miroir serveur de `nav.ts`.

---

## 2.7 Composants partagés

### Transverses

| Composant | Rôle |
|---|---|
| `PdfViewer.tsx` (817 l.) + `pdfjs.ts` | Visionneuse maison : vignettes, zoom ±, ajuster largeur/page, rotation G/D, recherche texte, imprimer, télécharger, plein écran |
| `PageHeader.tsx` | En-tête standard : `Breadcrumb` optionnel, pastille d'icône 44 px, titre `da-display` 26 px, description, zone d'actions (empilée < `sm`), animation `fadeUp` |
| `RefLayout.tsx` / `NewItemForm` | Patron des pages de référentiel (header + exports, table + formulaire, `Drawer` en mobile) |
| `BatchPipeline.tsx` | Barre de progression composite d'un lot (4 phases) |
| `StatusBadge.tsx` | `validated` / `pending` / `processing` / `failed` |
| `EmptyState.tsx` | État vide illustré, porteur d'action |
| `KpiCard.tsx` | Tuile KPI (valeur, variation, hint, lien, tone, `hausseDefavorable`) |
| `skeletons.tsx` | `TableSkeleton`, `CardsSkeleton` |
| `editable.tsx` | `EditableText`, `EditableSelect`, `EditableLocation`, type `TreeOption` |
| `DateMaskInput.tsx` | Saisie de date masquée JJ/MM/AAAA |
| `feedback.ts` | `useFeedback()` → `message` + `confirm` (vocabulaire Confirmer / Annuler) |
| `BrandMark.tsx` | `Logo` / `LogoIcon` |

### Métier « courrier » (`app/components/mail/`)

| Composant | Rôle |
|---|---|
| `MailWorklist.tsx` | Grille de file réutilisable (Contrôle / Parapheur / Suivi / Validation) |
| `MailDetailPage.tsx` | Page complète de consultation d'un courrier (onglets + Drawer PDF) — 582 l. |
| `MailViewer.tsx` | Popup équivalente (utilisée seulement par `/courriers/validation`) — 381 l. |
| `MailRefPage.tsx` | Générateur de page de référentiel « libellé seul » |
| `useMailWorkflow.ts` | **Hook central** : chargement du courrier, aperçu PDF, lookups, formulaire d'imputation, actions de workflow, identité courante |
| `FicheImputationModal.tsx` | Fiche d'imputation : aperçu PDF + Imprimer + Télécharger DOCX |
| `MailMetadataPanel.tsx` | Métadonnées EAV de l'entité externe |
| `DeadlineAlert.tsx` | Bandeau d'échéance aligné sur les paliers de relance (`@archivage/types`) |
| `NewExternalEntityModal.tsx` / `NewExternalEntityTypeModal.tsx` | Création à la volée d'un correspondant / d'un type |
| `tags.tsx` | `MailStatusTag`, `MailTypeTag` |
| `mailFormat.tsx` | `fmt`, `fmtDt`, `personName`, `imputationHistory` |

### Thème (`app/theme/`)

- `antdTheme.ts` — `buildTheme(mode)` (tokens Ant Design clair / sombre).
- `tokens.ts` — palette « Atelier d'archives » : primary **Encre**, accent **Ocre**,
  bgLayout, border, success / warning / danger.
- `icons.tsx` — **map sémantique** de 60+ icônes lucide (`icons.dashboard`, `icons.mail`,
  `icons.validated`…), `iconDefaults = { size: 18, strokeWidth: 1.75 }`, type `IconName`.
  **Jamais d'import lucide direct ailleurs.**
- `motion.ts` — variants `fade`, `fadeUp`, `chip`, `staggerContainer`, `staggerItem`.
- `charts.ts` — `fmtInt` et palette de graphiques.

### Couche API (`app/lib/`)

- `api.ts` — `API_BASE` (`NEXT_PUBLIC_API_URL` ?? `http://localhost:3001/api`), `apiJson`
  (Bearer + **redirection auto sur 401**), `apiUpload`, **`apiUploadChunked`** (paquets de 10
  + `finalize=true`), `downloadExport`.
- `courriers.ts` (600 l.) — tout le domaine courrier : files de travail, `searchMails`,
  `getMail`, `createArrivee` / `createDepart`, imputations, actions de workflow, `getBadges`,
  notifications, `uploadScannedDocument`, `integrateDecharge`, `extractMailWithAi`, APIs de
  référentiel, `MAIL_STATUS_LABELS`, `MAIL_TYPE_LABELS`, `destinataireLabel`.
- `auth.ts` — `getMe()` → `{ username, fullName, isAdmin, userGroupId?, menuKeys?, role? }`.
- `filters.ts` — `filterByLabel`, `filterByTitle`.

> Note : le package `packages/ui` est **vide** (`src/index.ts` seul). Tous les composants
> partagés vivent dans `apps/web/app/components/`.

---

# 3. Fonctionnalités

## 3.1 Docu-Archives

### A1 — Génération d'intercalaires QR (P1)

| # | Fonctionnalité | Description |
|---|---|---|
| A1.1 | Sélecteur de catégorie | 5 catégories : Type de document, Plan de classement, Localisation, Dossier, Séparateur vierge |
| A1.2 | Chargement dynamique | Liste rechargée à chaque changement de catégorie |
| A1.3 | Rendu en arbre indenté | Indentation `depth × 20 px`, racine virtuelle exclue, ordre `ORDER BY path` |
| A1.4 | Sélection multiple | Cases à cocher, filtre texte, tout (dé)sélectionner |
| A1.5 | Génération PDF imprimable | Une page **A4 par élément** : libellé de catégorie + libellé de l'élément + QR unique. Blob inline, nouvel onglet |
| A1.6 | Garde anti-génération vide | Bouton désactivé si aucune sélection (hors catégorie vierge) |
| A1.7 | Séparateur vierge | Feuille « blank » sans cible (`DOCUPRO\|1\|INTERCALAIRE\|BLANK\|0`) |
| A1.8 | Paramétrage QR robuste | ECC niveau **Q (25 %)**, zone de silence ≥ 4 modules, module ≥ ~0,5 mm à l'impression, encodage alphanumérique |

### A2 — Acquisition par lot (P2)

| # | Fonctionnalité | Description |
|---|---|---|
| A2.1 | Choix du dossier de destination | Grand dossier (racine) → dossier cible (`TreeSelect`). Peut aussi être défini par un intercalaire `DOSSIER` |
| A2.2 | **Deux modes d'acquisition** | « Sans intercalaire » = fusion de tous les PDF en **1 document**, sans OCR ni découpage. « Avec intercalaires » = découpage QR + OCR (`AcquisitionBatch.useIntercalaires`) |
| A2.3 | Anti-doublon de dossier | HTTP **409** si le libellé existe déjà parmi les dossiers **actifs** (index unique partiel `WHERE is_active`) |
| A2.4 | Upload multi-PDF chunké | `apiUploadChunked` : paquets de 10, seule la dernière tranche (`finalize`) enfile le job |
| A2.5 | Matérialisation du lot | Chaque session = un `acquisition_batch` (`batch_guid` UUID, opérateur, date de scan, dossier cible, compteurs, statut) |
| A2.6 | Traitement asynchrone | Job **BullMQ/Redis** consommé par `apps/worker` ; l'API ne bloque jamais. Polling `GET /batches/:id` toutes les 2 s (jusqu'à ~30 min) |
| A2.7 | Ordre de traitement | Fichiers traités **dans l'ordre de numérisation** (tri par nom) |
| A2.8 | Rastérisation de page | `pdfjs-dist` rend la page de séparation en image |
| A2.9 | Décodage QR | `zxing-wasm` (primaire), `jsQR` en repli |
| A2.10 | Découpage en documents | `pdf-lib` : extraction de plages de pages selon les règles ouvrant / BLANK / sans-QR |
| A2.11 | Validation stricte du contrat QR | Namespace `DOCUPRO` (QR étrangers ignorés), version reconnue (sinon rejet), type `INTERCALAIRE`, catégorie validée contre le référentiel, existence et activité de l'id cible vérifiées |
| A2.12 | Extraction de texte / OCR | Couche texte native du PDF d'abord ; sinon **Tesseract.js** (`fra`+`eng`), chemin CLI optionnel. Alimente `document_file.ocr_text` |
| A2.13 | Résolution du type de fichier | Par extension, création si inconnue, **sans doublon** |
| A2.14 | Stockage hors base | `FileStore` sur disque sous `ARCHIVES_PATH`, nommage déterministe `{file_id}{extension}`. **Aucun blob en base** |
| A2.15 | Auto-grant d'habilitation | Le groupe créateur reçoit un droit de Consultation sur chaque document produit |
| A2.16 | Compteurs et statut | `file_count` / `document_count` / `status` (0 ouvert → 1 terminé / 2 échec) |
| A2.17 | Idempotence / rejeu | `POST /batches/:id/reprocess` — `clearBatchOutputs()` garantit l'absence de doublons |
| A2.18 | **Indexation & validation** | Modale plein écran : visionneuse + indexation commune (« Appliquer à tous ») + tableau éditable ligne à ligne + compteur `x/N validé(s)` |
| A2.19 | Contrôle de doublons de cote | `POST /documents/cotes/check` avant validation, avertissement **non bloquant** |
| A2.20 | Navigation clavier | ← / ↑ et ↓ / → changent de document, Entrée enregistre |

### A3 — Recherche multi-critères et export (P3)

| # | Fonctionnalité | Description |
|---|---|---|
| A3.1 | Recherche plein-texte | Sur libellé + cote + **texte OCR**. PostgreSQL FTS : index **GIN d'expression** `to_tsvector('french', coalesce(ocr_text,''))` + `websearch_to_tsquery`, complété d'`ILIKE` sur libellé/cote |
| A3.2 | Filtres avancés | Type de document, Dossier, Plan de classement, Localisation, Type de fichier, Ajouté par, Date du document (plage) |
| A3.3 | Puces de filtres actifs | `Tag` fermables individuellement + « Tout effacer » |
| A3.4 | Brouillon vs critères appliqués | La recherche ne part qu'au clic, sur Entrée, ou à la suppression d'une puce |
| A3.5 | Tri et pagination serveur | Toutes les colonnes triables, pagination 10/20/50/100 avec total ; whitelist de colonnes (`SORT_COLUMNS`) côté SQL |
| A3.6 | Ouverture d'un document | Résolution de la **version courante** → fichiers → streaming du binaire |
| A3.7 | Édition de l'indexation | Modale commutable en mode édition → `PATCH /documents/:id/indexation` |
| A3.8 | Suppression | `DELETE /documents/:id` — **admin uniquement** (`AdminGuard`), supprime base **et** binaire disque |
| A3.9 | Export multi-formats | **Excel** (ExcelJS), **CSV** (fast-csv), **PDF** (PDFKit), **Word** (docx). Réutilise **la même requête sans pagination** → reflète exactement filtre et tri. Une grille vide donne un fichier valide mais vide |
| A3.10 | Filtre d'archivage | La recherche ne remonte que `d.is_archived = true` |

### A4 — Administration des référentiels et de la sécurité

| # | Écran / fonction | Description |
|---|---|---|
| A4.1 | Géolocalisation | Référentiel **hiérarchique** des localisations (Nom\*, Code\*, parent optionnel) |
| A4.2 | Plan de classement | **Hiérarchique**. Nom\*, Code **optionnel**, **Parent obligatoire** à la création |
| A4.3 | Catégories de dossier | Référentiel **plat** |
| A4.4 | Dossiers | **Hiérarchique**, croise trois référentiels : Nom\*, Code\*, **Localisation\***, **Catégorie\*** |
| A4.5 | Types de document | Référentiel **plat** |
| A4.6 | Utilisateurs | Liste, création, édition (mot de passe vide = inchangé), suppression, rôle, e-mail. Le compte `admin` est **protégé** (ni désactivable, ni rétrogradable, ni supprimable). Suppression refusée proprement si des documents/lots/audits sont liés |
| A4.7 | Rôles | Déterminent les **menus visibles**. Accordéons par section, compteur « cochés/total ». Rôles **système** en lecture seule. Suppression avertit du nombre d'utilisateurs impactés |
| A4.8 | Exports référentiels | **Excel** et **PDF** sur chaque écran (sauf organigrammes) |
| A4.9 | Hiérarchies | **Materialized-path** : `parent_id` + `path` + `depth`. Sous-arbre = `path LIKE ancêtre || '%'` ; recalcul de `path` après déplacement |

### A5 — Tableaux de bord Docu-Archives

| # | Fonctionnalité | Description |
|---|---|---|
| A5.1 | KPI principal | Nombre de documents archivés |
| A5.2 | Répartition par type | Anneau (donut) |
| A5.3 | Répartition par dossier | Barres — documents rangés dans chaque dossier |
| A5.4 | Répartition | Par plan de classement (barres) |
| A5.6 | Chargement indépendant | Squelette par carte, état vide, toast d'erreur |
| A5.7 | Bloc KPI complet côté API | Documents totaux/archivés/en attente/gelés, pages, octets, taux d'indexation, anomalies (`sansType`, `sansDossier`, `sansDate`, `sansCote`), objectif vs réalisé (`AnalyticsTarget`) |
| ⚠️ A5.8 | Filtre de période **non branché** | Le composant `PeriodFilter` existe ; la page fige 30 j |
| ⚠️ A5.9 | **Aucune ACL** | `aclCond() → null` : chiffres globaux pour tout utilisateur connecté |

## 3.2 Docu-Courriers

### B1 — Écrans métier

| # | Écran | Description |
|---|---|---|
| B1.1 | **Enregistrement** | Saisie d'un courrier entrant + rattachement du scan + création automatique des imputations « En copie ». **Saisie automatique par IA** optionnelle |
| B1.2 | **Courriers arrivés / Contrôle** | File de contrôle du bureau d'ordre ; validation (`valider = true`) ; file **personnelle** (destinataire nommé ou rôle) |
| B1.3 | **Documents scannés** | File des fichiers déposés par la chaîne de numérisation (`is_traite`) ; rattachement à un courrier |
| B1.4 | **Parapheur électronique** | Courriers imputés : routage vers agents/unités, instructions, échéance |
| B1.5 | **Suivi des courriers** | Avancement, imputations en cours, **fiche d'imputation** (PDF / DOCX) |
| B1.6 | **Validation** | Validation hiérarchique Direction et DG, **y compris en lot** |
| B1.7 | **Intégration décharge** | Rattachement de la décharge signée → courrier Déchargé puis archivé |
| B1.8 | **Courrier de départ** | Émission ; **numérotation par type de départ** (pas globale) |
| B1.9 | **Recherche multicritère** | Recherche transverse (full-text GIN) sur le fonds archivé |
| B1.10 | **Tableau de bord** | Écran neuf (sans équivalent legacy) : grille personnalisable de 9 widgets, agencement persisté serveur |
| B1.11 | **Cloche de notifications** | Inbox in-app avec compteur de non-lus |

### B2 — Traitements de fond (worker BullMQ)

| # | Fonctionnalité | Description |
|---|---|---|
| B2.1 | Rappels **date butoir** | Cron `10 13 * * *`. Paliers à **valeurs exactes** (pas des seuils) : `7 → PREMIÈRE_ALERTE`, `3 → RAPPEL`, `1 → DERNIÈRE_CHANCE`, `0 → URGENCE`, `-1/-2/-3 → RETARD`. ⚠️ **À J-6, J-5, J-4, J-2 : aucune alerte** |
| B2.2 | Rappels **échéance d'imputation** | Cron `* * * * *`. Fenêtre d'alerte `DELAIS_ALERTE_HOURS` (48 h), anti-spam `last_reminder_sent` / `DELAIS_ALERTE_INTERVAL_HOURS` (6 h). ⚠️ Une imputation **déjà en retard cesse d'être relancée** (`if (deadline < now) return false`) |
| B2.3 | Auto-traitement à la lecture | Les imputations dont le type porte `suivi = true` sont marquées traitées **automatiquement à l'ouverture** du courrier |
| B2.4 | Livraison double canal | Notification **in-app** + **e-mail** (`@archivage/mailer`). Une notification ne bloque jamais l'action métier |
| B2.5 | Planification idempotente | Le worker enregistre lui-même ses crons via `queue.upsertJobScheduler()` — un redémarrage ne duplique pas les jobs |

### B3 — Règles métier notables

- **Numérotation `NReference`** sérialisée par `pg_advisory_xact_lock` (verrous
  `918470001` arrivée / namespace `918470002` départ) — pas de collision en concurrence.
- **Destinataire exclusif** : soit un acteur nommé (`destinataire_expediteur`, flux Départ),
  soit un rôle (`destinataire_role_id`, flux Arrivée) — **exactement l'un des deux**
  (CHECK `ck_mail_destinataire`).
- **Types d'imputation système** (ids figés) : **5** Validation DG, **10** Pour Suivi (créée
  automatiquement après validation DG, +48 h), **14** Validation Direction, **17** En copie.
- **Journal d'actions** `mail_action_log` : 1014 Déliaison, 1015 Décharge, 1017 Validation DG,
  1018 Soumission validation, 1019 Contrôle, 1021 Enregistrement réponse.

## 3.3 Transverse

| # | Fonctionnalité | Description |
|---|---|---|
| C1 | Authentification JWT | `POST /auth/login`, token en `localStorage`, garde globale `AuthShell`, `/auth/me`, déconnexion. **Redirection automatique sur 401** |
| C2 | Changement de mot de passe | `POST /auth/change-password` (vérifie le mot de passe courant), `must_change_pwd` honoré |
| C3 | Hachage bcrypt | Coût 12, jamais de mot de passe en clair |
| C4 | Deny-by-default au transport | `JwtAuthGuard` global : toute route exige un JWT sauf `@Public()` |
| C5 | RBAC de menus | `MenuPermissionGuard` + `effectiveMenuKeys()` partagé entre `/auth/me` et le guard |
| C6 | Journal de navigation | `navigation_audit` — consultation/ouverture, URL, acteur, IP, machine (gros volume, indexé) |
| C7 | Journal de modification | `data_change_audit` — qui a changé quoi, `object_ref` (ex. `document:12345`), ancienne / nouvelle valeur |
| C8 | Logs structurés | Pino / `nestjs-pino` + filtre d'erreur global `AllExceptionsFilter` |
| C9 | Horodatages UTC | Stockage `timestamptz` en UTC, conversion locale à l'affichage. `document_date` reste une **date civile** non convertie |
| C10 | Palette de commandes | `Ctrl + K`, navigation clavier, filtrée par les menus autorisés |
| C11 | Localisation et thème | Ant Design `fr_FR`, dates `JJ/MM/AAAA`, thème clair/sombre persisté, sidebar repliable (état mémorisé), responsive mobile |
| C12 | Dégradation gracieuse | Sans `SMTP_HOST` → e-mail désactivé, in-app seul. Sans `ANTHROPIC_API_KEY` → la case « Saisie automatique » disparaît. L'application démarre normalement dans les deux cas |
| C13 | Fail fast | L'environnement est validé par **zod au boot**, côté API **et** worker |

---

# 4. Stack technologique

## 4.1 Socle

| Élément | Version / valeur |
|---|---|
| Gestionnaire de paquets | **pnpm 9.15.0** (workspaces : `apps/*`, `packages/*`) |
| Orchestrateur de tâches | **Turborepo ^2.3.0** |
| Runtime | **Node ≥ 20** |
| Langage | **TypeScript ^5.7.2** |
| Qualité | ESLint ^9.17.0, typescript-eslint ^8.18.0, Prettier ^3.4.2 |
| Base de données | **PostgreSQL 16** (docker) / 18 (local) |
| File de messages | **Redis 7** |
| ORM | **Prisma ^6.1.0** (schéma multi-fichiers) |

**Scripts racine** : `dev`, `build`, `lint`, `test` (tous `turbo run …`), `format`, `format:check`.

**`turbo.json`** — `globalEnv` : `NODE_ENV`, `DATABASE_URL`, `REDIS_URL`, `ARCHIVES_PATH`,
`JWT_SECRET`, `JWT_EXPIRES_IN`, `TESSERACT_LANG`, `TESSERACT_DATA_PATH`, `PORT`.
Tâches : `build` (`dependsOn: ^build`, outputs `dist/**`, `.next/**`), `dev` (persistent,
non caché), `lint`, `test`.

## 4.2 `apps/web` — Frontend (`@archivage/web`)

| Dépendance | Version |
|---|---|
| `next` | **^15.1.0** (App Router) |
| `react` / `react-dom` | **^19.0.0** |
| `antd` | **^5.22.0** |
| `@ant-design/icons` | ^5.5.2 |
| `@ant-design/plots` | ^2.6.8 |
| `@ant-design/nextjs-registry` | ^1.0.2 |
| `@ant-design/v5-patch-for-react-19` | ^1.0.3 |
| `react-grid-layout` | ^2.2.3 |
| `pdfjs-dist` | ^4.10.38 |
| `motion` | ^12.40.0 |
| `lucide-react` | ^1.18.0 |
| `geist` | ^1.7.2 |
| `tailwindcss` (dev) | ^3.4.17 (+ postcss ^8.4.49, autoprefixer ^10.4.20) |

**Scripts** : `dev` = `node scripts/ensure-single-dev.mjs`, `build` = `ensure-no-dev.mjs &&
next build`, `start` = `next start -p 5000`.

> Le garde `ensure-single-dev.mjs` empêche deux serveurs `next dev` de partager le même
> `.next` (source de `ChunkLoadError` récurrents).

## 4.3 `apps/api` — Backend (`@archivage/api`)

| Dépendance | Version |
|---|---|
| `@nestjs/common` / `core` / `platform-express` | **^11.0.0** |
| `@nestjs/config` | ^4.0.0 |
| `@nestjs/jwt` / `@nestjs/passport` | ^11.0.0 |
| `@prisma/client` | ^6.1.0 |
| `@anthropic-ai/sdk` | ^0.112.5 |
| `bullmq` | ^5.34.0 |
| `ioredis` | ^5.4.2 |
| `bcrypt` | ^5.1.1 |
| `jsonwebtoken` | ^9.0.2 |
| `passport` / `passport-jwt` | ^0.7.0 / ^4.0.1 |
| `multer` | ^1.4.5-lts.1 |
| `nestjs-pino` / `pino` / `pino-http` | ^4.3.0 / ^9.5.0 / ^10.3.0 |
| `nodemailer` | ^9.0.3 |
| `zod` | ^3.24.1 |
| `rxjs` / `reflect-metadata` | ^7.8.1 / ^0.2.2 |

Dev : `@nestjs/cli`/`schematics`/`testing` ^11, `jest ^29.7.0`, `ts-jest ^29.2.5`,
`supertest ^7.0.0`, `pino-pretty ^13.0.0`.

**Bootstrap** (`main.ts`) : préfixe global `/api`, CORS (`CORS_ORIGIN` ou reflect-any), filtre
global `AllExceptionsFilter`, `enableShutdownHooks()`, patch `BigInt.prototype.toJSON`
(colonnes `BigInt` comme `DocumentFile.byteLength`), création de `ARCHIVES_PATH` au démarrage,
port `PORT ?? 3001`.

**14 modules** : `acquisition`, `analytics`, `audit`, `auth`, `courriers`, `documents`,
`intercalaires`, `notifications`, `prisma`, `queue`, `referentials`, `roles`, `search`, `users`.
Modules `@Global` : `prisma`, `audit`, `queue`, `common` (`HierarchyService`).

> Le module `courriers` est le plus gros : 6 contrôleurs, 11 services, et un dossier
> `domain/` **pur** (sans Nest ni Prisma), entièrement testé — `mail-status`, `auto-treatment`,
> `queues`, `nreference`, `organigramme`, `label-normalisation`, `fiche-imputation`,
> `mail-scope`, `dashboard-archivage`, `dashboard-buckets`, `dashboard-sla`, `dashboard-delta`,
> `top-n`.
>
> ⚠️ L'**ordre d'enregistrement des contrôleurs est significatif** : `MailsController` porte
> la route greedy `courriers/:id`, donc les contrôleurs à sous-chemins littéraux sont déclarés
> avant lui.

## 4.4 `apps/worker` — Traitements asynchrones (`@archivage/worker`)

`bullmq ^5.34.0`, `ioredis ^5.4.2`, `@prisma/client ^6.1.0`, `pdf-lib ^1.17.1`,
`pdfjs-dist ^4.9.155`, `tesseract.js ^5.1.1`, `zxing-wasm ^2.0.0`, `pino ^9.5.0`,
`zod ^3.24.1`, `dotenv ^16.4.5`. Dev : `tsx ^4.19.2`, `jest`, `ts-jest`.

**Deux files BullMQ** :

| File | Producteur | Rôle |
|---|---|---|
| `acquisition` | `AcquisitionService` (API, via `ACQUISITION_QUEUE_TOKEN`) | Pipeline `page-source` → `segment` → `ingestion` → `grant-permission`. Échec → `status = 2` avant de relancer l'erreur |
| `courriers-reminders` | **aucun** — le worker planifie lui-même via `upsertJobScheduler()` | Rappels date butoir (13h10) et échéance d'imputation (chaque minute) |

Aucun `@nestjs/schedule` côté API : **toute la planification vit dans le worker**.

## 4.5 Packages partagés

| Package | Rôle | Dépendances clés |
|---|---|---|
| `@archivage/db` | Schéma Prisma multi-fichiers, migrations, seeds, client typé | `@prisma/client ^6.1.0` |
| `@archivage/qr` | Contrat QR `DOCUPRO\|1\|INTERCALAIRE\|cat\|id` : génération + parsing | `qrcode ^1.5.4`, `zxing-wasm ^2.0.0` |
| `@archivage/pdf` | Composition A4 d'intercalaires, rastérisation, découpage | `pdf-lib ^1.17.1`, `pdfjs-dist ^4.9.155`, `@napi-rs/canvas ^0.1.65` |
| `@archivage/ocr` | Couche texte PDF d'abord, Tesseract en repli (fra/eng) | `tesseract.js ^5.1.1` |
| `@archivage/exports` | Exports P3 | `exceljs ^4.4.0`, `docx ^9.1.0`, `pdfkit ^0.15.1`, `fast-csv ^5.0.2`, `jszip ^3.10.1`, `dejavu-fonts-ttf ^2.37.3` |
| `@archivage/mailer` | SMTP + gabarit HTML, partagé API / worker | `nodemailer ^7.0.9` |
| `@archivage/storage` | `FileStore` + `DiskFileStore` (`{file_id}{extension}` sous ARCHIVES) | aucune (Node natif) |
| `@archivage/types` | DTO et enums partagés (MailStatus, MailType, codes d'action…) | `zod ^3.24.1` |
| `@archivage/ui` | ⚠️ **vide** — `src/index.ts` seul | peer `antd ^5.22.0`, `react ^19` |
| `@archivage/config` | tsconfig.base, eslint.base, prettier | `@eslint/js`, `typescript-eslint` |

> ⚠️ **Écart de version** : `nodemailer ^9.0.3` dans `apps/api` contre `^7.0.9` dans
> `@archivage/mailer`, alors que l'API délègue tout son envoi au package.

## 4.6 Modèle de données

`packages/db/prisma/schema.prisma` ne porte que le `generator` et le `datasource` ; les modèles
sont éclatés sous `prisma/models/*.prisma` (multi-file GA en Prisma 6).

**Conventions** : PK auto-incrémentées, `@map` snake_case, `Timestamptz(0)`, `is_active`
plutôt que soft-delete. Les contraintes non exprimables par Prisma sont ajoutées en **SQL brut**
dans les migrations : index uniques partiels (`WHERE is_active`, version courante), CHECK
(statut de lot, bénéficiaire ACL exclusif, destinataire courrier exclusif), colonne générée
`app_user.full_name` (STORED), colonne et index **tsvector + GIN**, index couvrants.

| Fichier | Modèles | Contenu |
|---|---|---|
| `core.prisma` | 4 | `AcquisitionBatch`, `Document`, `DocumentVersion`, `DocumentFile` |
| `referentials.prisma` | 8 | `DocumentType`, `ClassificationPlan`, `Location`, `DossierCategory`, `Dossier`, `DossierExitMotive`, `FileType`, `IntercalaireCategory` |
| `security.prisma` | 8 | `AppUser`, `Role`, `RoleMenuPermission`, `AppGroup`, `AppUserGroup`, `PermissionLevel`, `DocumentTypePermission`, `DocumentPermission`, `UserSetting` |
| `courriers.prisma` | 17 | `Mail`, `MailInputation`, `MailComment`, `MailDocument`, `MailScannedDocument`, `MailActionLog`, `MailPermission`, `Organigramme`, + 9 référentiels |
| `audit.prisma` | 3 | `AuditAction`, `NavigationAudit` (BigInt PK), `DataChangeAudit` |
| `analytics.prisma` | 1 | `AnalyticsTarget` (scope × période × métrique) |
| `notifications.prisma` | 1 | `Notification` |

**7 migrations** : `init`, `add_roles_and_analytics`, `add_docu_courriers`,
`normalise_referential_labels`, `mail_destinataire_role`, `drop_types_entite_externe_menu`,
`add_user_setting`.

**Scripts `packages/db`** : `prisma:generate`, `prisma:migrate`, `prisma:deploy`, `db:seed`,
`db:seed:demo`, `db:seed:correspondants`, `db:seed:dashboard`, `db:grant:dashboard`.

## 4.7 Infrastructure

**`docker-compose.yml`** — deux services seulement, avec healthchecks :

| Service | Image | Port | Volume |
|---|---|---|---|
| `archivage_postgres` | `postgres:16-alpine` (user `archivage`, base `DocuPro`) | 5432 | `pgdata` |
| `archivage_redis` | `redis:7-alpine` | 6379 | `redisdata` |

`api` / `worker` / `web` n'ont **pas de Dockerfile** : en dev on lance `pnpm dev` contre ces
deux conteneurs.

> ⚠️ **Sécurité** : le mot de passe PostgreSQL est **en clair** dans `docker-compose.yml`
> et dans `.env.example`. À traiter avant toute publication du dépôt.

## 4.8 Variables d'environnement

Validées par **zod au boot** (`apps/api/src/config/env.ts`), fichiers `.env` / `.env.example`.

| Variable | Contrainte / défaut |
|---|---|
| `NODE_ENV` | `development` \| `test` \| `production` — défaut `development` |
| `PORT` | entier positif — défaut 3001 |
| `DATABASE_URL` | URL, **requis** |
| `REDIS_URL` | URL, **requis** — utiliser `127.0.0.1`, pas `localhost` (Redis n'écoute qu'en IPv4) |
| `ARCHIVES_PATH` | non vide, **requis** |
| `JWT_SECRET` | **≥ 16 caractères** |
| `JWT_EXPIRES_IN` | défaut `1d` |
| `TESSERACT_LANG` / `TESSERACT_DATA_PATH` | défaut `fra+eng` / optionnel |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` | optionnel / défaut `claude-opus-4-8` |
| `SMTP_HOST` / `_PORT` / `_USER` / `_PASSWORD` / `_FROM` | tout optionnel, port défaut 465 |
| `APP_BASE_URL` | URL — défaut `http://localhost:5000` |
| `MAIL_ORG_NAME` / `MAIL_ORG_TAGLINE` / `MAIL_LOGO_URL` | optionnels (logo : URL **absolue** obligatoire) |
| `CORS_ORIGIN` | ⚠️ lu directement dans `main.ts`, **absent du schéma zod et du `.env.example`** |
| `DELAIS_ALERTE_HOURS` (48) / `DELAIS_ALERTE_INTERVAL_HOURS` (6) / `REMINDERS_TZ` (`UTC`) | **worker uniquement** — ⚠️ absents du `.env.example` |

## 4.9 Démarrage (dev)

```bash
pnpm install
cp .env.example .env
docker compose up -d postgres redis
pnpm --filter @archivage/db prisma migrate deploy
pnpm --filter @archivage/db run db:seed      # admin / admin1234
pnpm dev                                      # web :5000 + api :3001/api + worker
```

> En local, PostgreSQL et Redis peuvent tourner en services Windows plutôt qu'en conteneurs —
> dans ce cas, ignorer `docker compose`.

---

# 5. Annexes — concepts métier et pièges connus

## 5.1 Concepts Docu-Archives

| Concept | Définition |
|---|---|
| **Intercalaire** | Feuille séparatrice imprimée **mono-page** portant **un seul** QR, insérée dans la liasse papier avant numérisation pour piloter le découpage |
| **Catégorie d'intercalaire** | 5 valeurs figées : `TYPE_DOCUMENT`, `PLAN`, `LOCALISATION`, `DOSSIER` (ouvrantes) et `BLANK` (séparateur pur) |
| **Contrat QR** | Format **ASCII délimité versionné** : `DOCUPRO\|1\|INTERCALAIRE\|{categorie}\|{id}`. Segment 1 = namespace (QR étrangers ignorés), segment 2 = version (inconnue → rejet). Délimiteur `\|` (0x7C) — remplace le `¦` U+00A6 legacy fragile. `id = 0` pour BLANK |
| **Lot (batch)** | Session de numérisation, **entité de 1er rang** — matérialise le `StrGuid` legacy répété sur chaque ligne |
| **Document / Version / Fichier** | Un document a N versions dont **une seule courante** (index unique partiel `WHERE is_current`) ; une version porte N fichiers. Binaires **hors base** |
| **Dossier** | Conteneur hiérarchique de classement (« chemise »), avec catégorie et localisation. **Libellé unique parmi les actifs** |
| **Cote / N° de pièce** | Référence d'archivage d'un document |
| **Date métier vs système** | `document.document_date` (**affichée en P3**) ≠ `created_at`. `archive_year` conservé |
| **Statut d'un document** | *À indexer* (`is_archived = false`) → *Validé* (`is_archived = true`, avec `validated_by`/`validated_at`). `is_frozen` (gel / legal hold) est **orthogonal** |
| **Identité applicative** | `app_user_group.user_group_id` — **acteur effectif** de toutes les FK créateur/validateur/audit. Distinct de `app_user` et `app_group` |
| **Niveaux de permission** | `1 Consultation`, `2 Création`, `3 Modification`, `4 Validation/Publication`, `5 Prêts/Communication` |

## 5.2 Pièges sémantiques Docu-Courriers

Comportements **réels et vérifiés** qui fausseraient tout indicateur — à connaître impérativement.

1. **`date_decharge` est polluée sur les Départs** — elle est aussi écrite au passage à
   *Rédigé* d'un Départ, où elle sert de **date d'archivage**.
   `date_decharge IS NOT NULL` ≠ « déchargé ».
2. **`end_date_follow_up` n'est jamais écrite** — aucun KPI « suivi clôturé » n'est calculable ;
   la file Départ ne se vide jamais par ce biais.
3. **Le statut `Supprimé (4)` n'est jamais affecté** — toujours filtrer `is_deleted = false`.
4. **Règle de visibilité générale** : `!isDeleted && (status !== Rédaction || mailType === Arrivée)`
   — une Arrivée reste visible en Rédaction, pas les autres types.
5. **L'auto-traitement à la lecture écrase les délais** — un délai médian anormalement bas est
   un **artefact**, pas une performance.
6. **Deux dates d'archivage différentes** : Arrivée/Interne → `date_traited` ;
   Départ → `date_decharge`.
7. **Le SLA est configuré mais dormant** — `duree_suivi_externe` / `duree_suivi_interne` ne sont
   lues/écrites que par le CRUD ; **aucun calcul métier ne les utilise**.
8. **`organigramme_id` n'existe que sur les Arrivées** — `createDepart` ne le dérive jamais ;
   tout KPI « par service » ne porte donc que sur les Arrivées et exige un bucket
   « Non rattaché ».
9. **`destinataire_expediteur` et `destinataire_role_id` sont exclusifs** — une agrégation
   « par destinataire » qui ignore l'un des deux perd la moitié des courriers.
10. **`n_reference` est unique par type de départ**, pas globalement.

## 5.3 Écarts, réserves et éléments hors périmètre

**Livré au-delà de la spec v1** (déclaré « hors périmètre v1 » dans la spec) :
- L'**indexation et validation qualité** est en réalité implémentée (modale P2 complète).
- Le **tableau de bord Docu-Archives** et le module **Docu-Courriers** entier ne figurent dans
  aucune spec Spec-Kit — ils ne sont documentés que dans `docs/`.
  `specs/` ne contient qu'une seule feature : `001-archivage-qr`.

**Explicitement hors périmètre / non exploité** :
- **Métadonnées d'indexation** (champs personnalisés, EAV, listes de valeurs) — écartées.
- **Sous-systèmes réservés** : workflow, prêts de dossiers, signature électronique, sécurité
  PDF (mot de passe / redaction), motif de sortie de dossier — colonnes et FK conservées en
  réserve, **sans fonctionnalité**.
- **Reprise de données legacy** — chantier séparé (`migration-reprise-donnees.md`) : ETL en
  4 temps via schéma de transit `legacy.*`, conservation des identifiants d'origine + recalage
  `setval`, extraction des ~93 000 binaires `VARBINARY(MAX)` sur disque, idempotence.
- `mail_permission` (ACL par courrier) — **modélisée mais inactive en v1**.
- 3 écrans de paramétrage courrier restent **masqués** dans la barre latérale.
- 2 routes de développement à supprimer : `/design` et `/dev/pdf-viewer`.

**Points de vigilance ouverts** :
- Le deny-by-default documentaire est **court-circuité** (D-17) — voir §1.6.
- Le dashboard Archives n'applique **aucune ACL**, ce qui n'est **pas transposable** à
  Docu-Courriers qui a un périmètre explicite (`MailScope`).
- Le portage V6 n'implémente que **3 badges de menu sur 6** côté données.
- Le filtre de période de `/dashboards` est **écrit mais non branché**.
- Volumétrie courriers actuellement très faible : les KPI de délai seront pauvres au départ —
  recommandation de ne pas pré-agréger et de soigner les états vides.
- `.specify/memory/constitution.md` est un **gabarit non ratifié** (placeholders) : aucun
  principe constitutionnel contraignant n'est appliqué.

---

## Documents liés

| Document | Contenu |
|---|---|
| [`README.md`](../README.md) | Démarrage rapide |
| [`specs/001-archivage-qr/`](../specs/001-archivage-qr/) | Spec, plan, research (décisions D-01→D-20), data-model, contrats, quickstart, tasks |
| [`docs/PRD-Reprise-Archivage-QR.md`](PRD-Reprise-Archivage-QR.md) | PRD v1.1 — personas, décisions D1→D14, DDL, glossaire |
| [`docs/DOCUMENTATION_MODULE_DOCU-COURRIERS.md`](DOCUMENTATION_MODULE_DOCU-COURRIERS.md) | 4 275 l. — le module **source legacy**, écran par écran |
| [`docs/TABLEAU-DE-BORD-DOCU-COURRIERS.md`](TABLEAU-DE-BORD-DOCU-COURRIERS.md) | Conception KPI + pièges sémantiques |
| [`docs/PLAN-IMPLEMENTATION-TABLEAU-DE-BORD-COURRIERS.md`](PLAN-IMPLEMENTATION-TABLEAU-DE-BORD-COURRIERS.md) | Plan et correctifs post-livraison |
| [`docs/schema-base-de-donnees.md`](schema-base-de-donnees.md) | Schéma détaillé de la base |
| [`docs/guide-utilisateur-actions.md`](guide-utilisateur-actions.md) | Référentiel des actions utilisateur |
| [`docs/operations.md`](operations.md) | Ports, FTS, OCR, sécurité, tests |
| [`docs/deploiement-windows.md`](deploiement-windows.md) | Déploiement Windows |
| [`docs/pages-ui-fonctionnalites.md`](pages-ui-fonctionnalites.md) | ⚠️ Inventaire UI **antérieur au module Courriers** — superseded par le présent document |
