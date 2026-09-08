# DocuPro V6 — Vue d'ensemble de l'application

> Document de synthèse : stack technique, architecture, modules, pages, fonctionnalités et
> éléments UI/UX. Établi le 2026-08-06 par lecture du code (`apps/`, `packages/`).
>
> Documents connexes : [`documentation-application.md`](documentation-application.md),
> [`schema-base-de-donnees.md`](schema-base-de-donnees.md),
> [`DOCUMENTATION_MODULE_DOCU-COURRIERS.md`](DOCUMENTATION_MODULE_DOCU-COURRIERS.md),
> [`operations.md`](operations.md), [`deploiement-windows.md`](deploiement-windows.md).

---

## 1. Ce que fait l'application

DocuPro est une **GED / SAE** (gestion électronique de documents + système d'archivage
électronique) composée de deux domaines métier réunis dans une seule interface :

| Domaine | Objet |
|---|---|
| **Docu-Archives** | Numérisation de masse par intercalaires QR, indexation, recherche plein-texte, export, cycle de vie documentaire (DUA, sorts finaux, épuration), prêt/communication de documents. |
| **Docu-Courriers** | Bureau d'ordre : enregistrement du courrier arrivée/départ, imputation, parapheur, suivi des échéances, validation, décharges, archivage et recherche du fonds courrier. |

Trois briques historiques structurent Docu-Archives :

- **P1 — Intercalaires** : produire des feuilles A4 à QR code servant de séparateurs papier.
- **P2 — Acquisition par lot** : téléverser des PDF scannés, découper par QR, OCR, indexer, valider.
- **P3 — Recherche & export** : recherche multicritère + plein texte, export Excel / CSV / PDF / Word.

---

## 2. Stack technique

### 2.1 Monorepo

TypeScript de bout en bout, **pnpm workspaces + Turborepo** (`turbo.json`), Node ≥ 20,
Prettier + ESLint 9 (flat config), Jest / ts-jest.

```text
apps/
  web         Next.js 15 (App Router) + React 19 + Ant Design 5 + Tailwind 3
  api         NestJS 11 (REST, préfixe /api, port 3001)
  worker      BullMQ 5 (traitement des lots + rappels planifiés)
  scan-agent  Service autonome installé sur le poste de scan (surveillance de dossier)
packages/
  db          Prisma 6 (schéma multi-fichiers + SQL brut) — 59 modèles
  qr          Génération (qrcode) et lecture (zxing-wasm) des QR, contrat de payload
  pdf         Intercalaires, découpage (pdf-lib), rastérisation (pdfjs-dist)
  ocr         Tesseract (CLI / tesseract.js)
  exports     ExcelJS, fast-csv, PDFKit, docx — exports et fiche d'imputation
  storage     Accès au coffre disque (ARCHIVES_PATH)
  mailer      Gabarit HTML des e-mails, identité de marque, logo
  types       Énumérations métier partagées (miroir TS des smallint + CHECK en base)
  ui          Primitives partagées
  config      Configs TS / ESLint communes
storage/archives/   binaires hors base
```

### 2.2 Frontend (`apps/web`)

| Brique | Choix |
|---|---|
| Framework | Next.js 15 App Router, React 19, `next dev --turbopack` en dev |
| UI kit | Ant Design 5 (`cssVar: true`), locale `fr_FR`, patch React 19 |
| Style | Tailwind 3 + `globals.css` (variables CSS `--da-*`) |
| Graphiques | `@ant-design/plots` (G2) |
| Icônes | `lucide-react`, indirection via `app/theme/icons.tsx` |
| Typo | Geist Sans / Geist Mono + **Bricolage Grotesque** (titres, `--font-display`) |
| Animation | `motion` (Framer Motion) avec `MotionConfig reducedMotion="user"` |
| Grille tableau de bord | `react-grid-layout` (drag & resize) |
| Visionneuse | `pdfjs-dist` (assets copiés au `predev`/`prebuild`) |
| Port | **5000** (`next start -p 5000`), garde `ensure-single-dev.mjs` contre le double serveur |

### 2.3 Backend (`apps/api`)

NestJS 11 · Passport JWT + `bcrypt` · `zod` (pipe de validation maison) · Prisma 6 ·
`nestjs-pino` / Pino (logs structurés) · `multer` (upload) · `bullmq` + `ioredis` (production de
jobs) · `nodemailer` (SMTP, canal désactivé si `SMTP_HOST` vide) · `openai` (extraction IA
optionnelle du courrier).

Transverses : `all-exceptions.filter.ts`, `zod-validation.pipe.ts`, `hierarchy.service.ts`
(arbres : dossiers, plan de classement, organigramme, géolocalisation), `agencement.service.ts`
(agencement des tableaux de bord).

### 2.4 Asynchrone (`apps/worker`)

Deux files BullMQ :

- `acquisition` — traitement d'un lot : rastérisation → lecture QR (zxing-wasm) → segmentation →
  découpage (pdf-lib) → OCR (Tesseract) → création des documents + droits.
- `courriers-reminders` — jobs **répétables** planifiés par le worker lui-même au démarrage
  (`upsertJobScheduler`, idempotent) : rappel « date butoir » et rappel d'échéance d'imputation.

### 2.5 Agent de numérisation (`apps/scan-agent`)

Service à installer sur le poste de scan (NSSM sous Windows). Surveille un dossier, attend la
stabilité du fichier, puis pousse vers `POST /courriers/documents-scannes` avec une clé de
service. Aucun accès base ni disque serveur. Répertoires `SENT_DIR` / `FAILED_DIR`, réessais
bornés, vérification d'accès explicite au démarrage (401 et 403 distingués dans les logs, car ils
se corrigent à des endroits différents).

### 2.6 Données & infrastructure

- **PostgreSQL 16** — Prisma multi-fichiers (`packages/db/prisma/models/*.prisma` :
  `core`, `archives`, `courriers`, `referentials`, `security`, `analytics`, `audit`,
  `notifications`) + **SQL brut** pour les uniques partiels, les `CHECK` et le **plein texte
  `tsvector` + index GIN**.
- **Redis 7** — BullMQ.
- **Docker Compose** — `postgres` + `redis` uniquement ; api/worker/web tournent hors conteneur en dev.
- Binaires **hors base**, sur disque sous `ARCHIVES_PATH`. Horodatages **UTC**.
- Clé de scellement Ed25519 sous `<ARCHIVES_PATH>/.keys/`, générée au premier scellement.

---

## 3. Architecture applicative

```text
Navigateur ──HTTP/JSON (JWT Bearer)──► NestJS /api ──Prisma──► PostgreSQL
     ▲                                    │  │
     │                                    │  └──► disque ARCHIVES (binaires, logo, clés)
     │                                    └──► Redis/BullMQ ──► worker ──► OCR / QR / pdf-lib
     │
  scan-agent (poste de scan) ──POST /courriers/documents-scannes──►
```

- **Authentification** : `POST /auth/login` → JWT stocké en `localStorage` sous `token`,
  envoyé en `Authorization: Bearer`. `GET /auth/me` renvoie l'identité **et la liste des menus
  autorisés** (`menuKeys`), qui pilote la barre latérale.
- **Autorisation** : RBAC par menu (`role_menu_permission` + `MENU_CATALOG` côté serveur),
  droits par type de document (utilisateur ou rôle), droits par document, et niveaux de
  confidentialité ordonnés. Détail en §7.
- **Uploads volumineux** : `apiUploadChunked` côté web (découpage en tronçons).

---

## 4. Design system & UX transverses

### 4.1 Identité visuelle — « Atelier d'archives »

Source de vérité unique : `apps/web/app/theme/tokens.ts`, consommé par `antdTheme.ts` (tokens
globaux + tokens par composant) et par `globals.css` (variables `--da-*`).

| Rôle | Clair | Sombre |
|---|---|---|
| Primaire « Bleu roi » | `#1668C5` | `#4F9BE8` |
| Accent « Ocre manille » | `#9A5A23` / fort `#B26B2E` | `#D89A5E` |
| Fond de page / conteneur | `#F6F7F6` / `#FFFFFF` | `#0A0E16` / `#121823` |
| Succès / Alerte / Danger | `#2F7A4F` / `#B7791F` / `#C0392B` | variantes désaturées |

Règle d'or documentée dans le code : **l'ocre ne sert jamais à du petit texte sur fond clair**
(contraste insuffisant) — uniquement remplissages, bordures et badges.

Autres partis pris : `controlHeight` 36 px, rayons doux, ombres légères à trois niveaux
(`--da-shadow-card / -raised / -popover`), en-têtes de tableau sur fond `bgLayout`, **bordure
primaire sur tous les champs de saisie** (Input/Select/InputNumber) et non seulement au survol.

### 4.2 Mode clair / sombre

`Providers.tsx` : SSR toujours en clair (aucun mismatch d'hydratation), relecture du choix
persistant (`localStorage` `da-theme`) au montage, `data-theme` posé sur `<html>`,
`darkAlgorithm` d'AntD en sombre. Bascule depuis la barre supérieure.

### 4.3 Mouvement

`theme/motion.ts` — variantes réutilisables (`fade`, `fadeUp`, `staggerContainer`,
`staggerItem`, `chip`) et durées tokenisées. Philosophie affichée : le mouvement sert la
compréhension, jamais la décoration. `prefers-reduced-motion` est respecté globalement via
`MotionConfig reducedMotion="user"` et par une règle CSS dédiée.

### 4.4 Accessibilité

- Anneau de focus net sur `:focus-visible` pour tous les éléments interactifs.
- `aria-label` sur les boutons-icônes, `role="radio"` / `aria-checked` sur les cartes-radio,
  `aria-pressed` sur les sélecteurs de catégorie, `aria-hidden` sur les décors SVG.
- Navigation clavier : `Enter` / `Espace` sur les cartes cliquables, raccourci global **⌘K / Ctrl+K**.
- Contrastes vérifiés (accent assombri pour rester AA en texte).

### 4.5 Chrome applicatif (`AuthShell`)

Enveloppe toutes les routes sauf `/login`.

- **Garde d'authentification** : pas de jeton → `/login` ; jeton présent sur `/login` →
  `/dashboards` ; écran d'attente logo + spinner pendant `/auth/me`. En dev, la redirection est
  une navigation *document* (contourne les transitions avalées par le rebuild HMR).
- **Barre latérale** 264 px (repliée 76 px), état persistant (`da-sider-collapsed`),
  **accordéon à une seule section ouverte**, ouverte automatiquement sur la section de la route
  courante. Filtrée par `menuKeys` ; les sections vides disparaissent ; « Tableaux de bord »
  reste toujours visible.
- **Badges de menu** : compteurs sur *Courriers arrivés, Documents scannés, Courriers imputés,
  Suivi, Validation, Intégration décharge*, rafraîchis toutes les **120 s** via
  `GET /courriers/badges`. Quand une section est repliée, son **cumul** s'affiche sur le titre de
  section — sinon replier masquerait l'alerte.
- **Barre supérieure (`TopBar`)** : déclencheur du menu mobile, titre / fil d'Ariane déduit de la
  route, bouton de recherche globale (palette), **cloche de notifications** (badge non lus),
  bascule de thème, menu utilisateur (nom, `· admin`, déconnexion) avec avatar à initiales.
- **Palette de commandes** (`CommandPalette`, ⌘K/Ctrl+K) : recherche floue sur les libellés et les
  **mots-clés synonymes** déclarés dans `nav.ts`, filtrée par les menus autorisés.
- **Responsive** : sous le point de rupture `lg`, la barre latérale devient un `Drawer` gauche
  de 280 px ; `.da-page` ajuste ses marges à 768 px et 1600 px.
- **Filet anti-`ChunkLoadError`** : script inline exécuté avant l'hydratation, rechargement unique
  avec garde anti-boucle de 15 s (`sessionStorage`).

### 4.6 Bibliothèque de composants maison (`app/components/`)

`PageHeader` (icône + titre + description + fil d'Ariane + actions) · `KpiCard`, `StatTile`,
`StatusTile`, `CountBadge`, `StatusBadge` · `InfoCard`, `FormSection` (+ `AiFilledTag`) ·
`EmptyState` (états vides illustrés, variante `compact`) · `skeletons.tsx` (`TableSkeleton`…) ·
`editable.tsx` (édition en place au clic sur une cellule, classe `.da-editable` avec crayon au
survol) · `RefLayout` / `BulkRefPage` / `MailRefPage` (référentiels CRUD génériques) ·
`BatchPipeline` (progression d'un lot) · `MetaDataFields` / `MetaDataDisplay` (formulaire
d'indexation dynamique) · `PdfViewer` · `NotificationsBell` · `BrandMark` (`Logo` / `LogoIcon`).

Motifs UX récurrents : confirmation `Popconfirm` sur toute suppression/désactivation,
`message.success` / `message.error` systématiques, `Tooltip` explicatif sur les notions métier
(DUA, SLA, suivi…), flash de ligne après création (`.da-row-flash`), barres d'action collantes en
bas d'écran, garde « modifications non enregistrées » avant fermeture de modale.

### 4.7 Visionneuse PDF (`PdfViewer`)

Panneau de vignettes, navigation page précédente/suivante, zoom (+ raccourcis `Ctrl +` / `Ctrl -`),
ajustement largeur/page, rotation gauche/droite, **recherche dans le document** avec navigation
entre occurrences, impression, téléchargement, plein écran. États vides explicites (« Aucun
aperçu », « Document illisible »).

---

## 5. Cartographie des pages

Navigation centralisée dans `apps/web/app/components/nav.ts` (source unique pour la barre
latérale, le drawer et la palette). Six sections.

### 5.1 Hors chrome

| Route | Page |
|---|---|
| `/login` | Connexion |
| `/design` | Galerie interne du design system (référence de développement) |
| `/` | Racine (aiguillage) |

**`/login`** — Écran en deux volets au-delà de `lg` : panneau de marque en dégradé « Bleu roi »
avec motif QR→archive décoratif, logo, accroche « Vos archives, retrouvées en un instant. » et
rappel « Génération d'intercalaires · Acquisition par lot · Recherche & export » ; à droite le
formulaire (nom d'utilisateur, mot de passe, bouton pleine largeur avec état `loading`). Sous
`lg`, le panneau se réduit à un bandeau compact. Nettoyage des espaces d'autofill, messages
d'erreur distincts « identifiants invalides » et « connexion impossible ».

### 5.2 Section « Docu-Archives »

| Route | Page |
|---|---|
| `/dashboards` | Tableaux de bord |
| `/acquisition` | Acquisition par lot (P2) |
| `/search` | Recherche (P3) |
| `/archives/dua-expirees` | DUA expirés |
| `/archives/documents-epures` | Documents épurés |
| `/archives/communiquer` | Communiquer un document |
| `/archives/documents-communiques` | Documents communiqués |
| `/archives/mes-documents-communiques` | Mes documents communiqués |
| `/archives/historique-communications` | Historique des communications |
| `/documents/[documentId]` | Détail d'un document |

#### `/dashboards` — Tableaux de bord

**UI** : `PageHeader` + filtre de période (préréglages, défaut 30 j) ; bandeau d'accueil en
dégradé « Bienvenue sur Docu-Archives » rappelant le volume du fonds et proposant trois raccourcis
(Démarrer une acquisition / Générer des intercalaires / Rechercher) ; grille de widgets
`react-grid-layout`.

**Fonctionnalités** : agencement **personnalisable par utilisateur** — mode édition explicite
(hors édition la grille est figée), glisser l'en-tête pour déplacer, le coin pour redimensionner,
« Ajouter un widget » (modale du catalogue), « Réinitialiser » l'agencement livré, Annuler /
Enregistrer. Le serveur renvoie l'agencement re-filtré selon les droits et c'est **sa** version
qui est adoptée. Tous les widgets se nourrissent d'un **unique** `POST /analytics/overview`.

**Widgets** (catalogue `dashboard-widgets.ts`) : `kpis`, `anomalies`, `type` (par type de
document), `programme` (sous-arbre de dossiers), `localisation`, `plan` (plan de classement),
`evolution` (croissance cumulée du fonds), `objectif` (cible), `pipeline`.

#### `/acquisition` — Acquisition par lot (P2)

**UI** : assistant `Steps` en 4 étapes — **Destination**, **Fichiers**, **Traitement**,
**Indexation** (les deux dernières sont pilotées par le statut du lot, pas par l'utilisateur).

- *Destination* : deux cartes-radio de mode — « Sans intercalaire » / « Avec intercalaires
  (QR + OCR) » ; sélection du **type de document** du lot, puis **Dossier**, **Plan de
  classement** et **Confidentialité** (`TreeSelect` pour les arbres). Les trois valeurs sont
  pré-remplies par le paramétrage du type mais **restent modifiables** (l'override est porté par
  le lot, priorité : override du lot > défaut du type). `Tooltip` explicatif quand le bouton
  « Continuer » est désactivé.
- *Fichiers* : `Upload` multiple avec envoi **par tronçons**, retour arrière possible.
- *Traitement* : `BatchPipeline` — phases de progression du job worker, bouton « Relancer ».
- *Résultat* : carte « Lot #N » avec table des documents produits (Document, N° pièce, Type,
  Pages, Statut) et actions « Indexer » / « Nouveau lot ».

**Modale d'indexation** (plein écran) : visionneuse PDF à gauche, panneau d'indexation à droite —
rappel du classement lu (type, plan, dossier, confidentialité), champs de métadonnées **générés
dynamiquement** selon le type de document, bouton **« Appliquer les champs communs à tous les
documents »**, liste latérale « Documents du lot » pour naviguer, enregistrement puis
**validation du document ou de tout le lot** (confirmation). Garde « Modifications non
enregistrées » à la fermeture. Message final « Acquisition finalisée — prêt pour un nouveau lot ».

#### `/search` — Recherche & export (P3)

**UI** : grande barre de recherche (« Rechercher dans le libellé, la référence et le texte
OCR… ») + boutons **Rechercher** / **Réinitialiser** ; panneau **« Filtres avancés »**
(`Collapse` ouvert par défaut) portant un badge du nombre de filtres appliqués : type de
document, dossier, plan de classement, type de fichier, plage de dates (`RangePicker` « Du / Au ») ;
puces de filtres actifs animées ; carte de résultats titrée par un `CountBadge` (« N résultats »),
table triable et paginée (Libellé, Type de document, Enregistré le, Dossier, Plan de classement),
squelette de chargement et état vide avec action « Tout effacer ».

**Fonctionnalités** : recherche plein texte (tsvector/GIN) + filtres combinés, tri serveur,
pagination, ouverture du détail au clic, **export** via un menu déroulant — **Excel, CSV, PDF,
Word** — désactivé quand il n'y a aucun résultat.

#### `/documents/[documentId]` — Détail d'un document

**UI** : `PageHeader` avec fil d'Ariane (Recherche › #id), badge du niveau de droit effectif
(« Vos droits sur ce document »), `Tabs`, et **tiroir latéral d'aperçu** ouvrant le `PdfViewer`.

**Onglets** :

| Onglet | Contenu |
|---|---|
| Information | Libellé, type, date d'enregistrement, dossier, plan de classement, niveau de confidentialité (`Tag`), métadonnées saisies |
| Indexation | Réédition des champs d'indexation (soumise au niveau de permission) |
| Cycle de vie | Règle de conservation appliquée, DUA, échéances, sort final, mode de destruction |
| Accès par utilisateur | Droits nominatifs (ajout / retrait) |
| Accès par profil | Droits par rôle / groupe |
| Sécurité et conformité | Intégrité (empreinte), **scellement Ed25519**, vérification, clé publique |
| Historique | Journal des actions sur le document |

(`LendingsTab` existe également pour l'historique des prêts d'un document.)

#### Cycle de vie & communication

- **`/archives/dua-expirees`** — Documents dont la durée d'utilité administrative est atteinte.
  Table : Document, Type, Dossier, **Départ** (date du document, à défaut date de création —
  `Tooltip` explicite), **Échéance DUA**, **Échéance conformité**, Sort final, Mode de
  destruction. Sélection multiple → **déclarer épuré**, avec encart pédagogique : l'épuration
  change l'état documentaire, elle **n'est pas** la destruction physique.
- **`/archives/documents-epures`** — Consultation des documents passés à l'état « Épuré ».
- **`/archives/communiquer`** — Sortie d'un document au bénéfice d'un utilisateur : choix du
  dossier (arbre) → liste des documents **communicables** (les documents déjà sortis, épurés ou
  gelés ne sont pas proposés) → bénéficiaire, **motif de prêt**, durée. États vides guidants.
- **`/archives/documents-communiques`** — Tous les documents sortis et non rendus (retour possible).
- **`/archives/mes-documents-communiques`** — Vue personnelle du bénéficiaire.
- **`/archives/historique-communications`** — Communications terminées, **consultation seule**.

### 5.3 Section « Docu-Courriers »

| Route | Page |
|---|---|
| `/courriers/tableau-de-bord` | Tableau de bord courrier |
| `/courriers/enregistrement` | Enregistrement d'un courrier |
| `/courriers/controle` (+ `/[mailId]`) | Courriers arrivés |
| `/courriers/documents-scannes` | Documents scannés |
| `/courriers/parapheur` (+ `/[mailId]`) | Courriers imputés |
| `/courriers/suivi` (+ `/[mailId]`) | Suivi des courriers |
| `/courriers/validation` | Validation |
| `/courriers/recherche` (+ `/[mailId]`) | Recherche courrier |
| `/courriers/depart` | Courrier de départ |
| `/courriers/integration-decharge` | Intégration décharge |

#### `/courriers/tableau-de-bord`

Même architecture personnalisable que `/dashboards` (grille, mode édition, réinitialisation) mais
**chargement à la carte** : un endpoint par zone. Widgets du catalogue serveur :

| Widget | Contenu |
|---|---|
| `alertes` | Retards courriers et imputations, courriers sans imputation |
| `files` | Files de travail (périmètre déduit des permissions de suivi, non modifiable) |
| `synthese` | Chiffres clés : enregistrés, archivés, en cours, délai de traitement ; détail par type |
| `flux` | Entrées / sorties par période + encours cumulé |
| `repartition` | Ventilation par type, statut, correspondant, service ; la tranche « non renseignée » n'est jamais fondue dans « Autres » |
| `retards` | Paliers d'échéance (J-7, J-3, J-1, J0), ancienneté du backlog, retards les plus anciens (ligne cliquable) |
| `delais` | Médiane et 90ᵉ centile, respect du SLA paramétré sur l'objet, exclusion assumée des courriers sans durée de suivi |
| `charge` | Charge par agent (ouvertes / traitées / en retard / délai médian) et par service (sous-arbres inclus) |
| `hygiene` | Défauts de saisie et de paramétrage dégradant les autres indicateurs |

État vide explicite : le tableau reste vide tant qu'aucune permission de suivi n'a été attribuée
au rôle.

#### `/courriers/enregistrement`

Formulaire structuré en `FormSection` :

1. **Identification du courrier** — Objet, date du courrier, date d'enregistrement (`JJ/MM/AAAA`),
   **n° d'enregistrement** (police monospace, pré-calculé par `GET /courriers/next-reference/arrivee`).
2. **Expéditeur et destinataire** — référence correspondant, **entité externe** (avec bouton
   « Créer un expéditeur » ouvrant une modale), **rôle destinataire**, destinataires « en copie ».
3. **Pièce jointe et description** — dépôt du PDF numérisé, description libre.

**Extraction IA optionnelle** : `POST /courriers/extraction-ia` envoie le scan à un modèle
OpenAI en **sortie structurée JSON** (tous les champs nullables : un champ illisible revient
`null` plutôt qu'inventé). Les champs pré-remplis portent un `AiFilledTag`. Disponibilité
vérifiée par `GET /courriers/extraction-ia/disponibilite`; plafond 10 Mo, types PDF/JPEG/PNG/GIF/WebP.

#### Files de travail

- **`/courriers/controle`** — « Courriers qui vous sont adressés en tant que destinataire
  principal, en attente de votre validation. » Liste + fiche détaillée.
- **`/courriers/parapheur`** — « Votre boîte de travail personnelle » : courriers confiés pour
  traitement, réponse ou avis.
- **`/courriers/suivi`** — Courriers en cours avec leurs échéances ; accès à la **fiche
  d'imputation** (icône dédiée, export PDF).
- **`/courriers/validation`** — Courriers validés au contrôle et pas encore traités ; sélection
  multiple → « marquer comme traités » (clôture des imputations, sortie des files actives).
- **`/courriers/documents-scannes`** — File alimentée par le *scan-agent* ou par dépôt manuel.
  Table (Fichier, Scanné le, action), aperçu intégré, bouton **« Enregistrer »** qui ouvre le
  formulaire d'enregistrement **pré-rattaché au scan**. Formats acceptés : PDF, JPG, PNG, TIFF.
  État d'erreur explicite quand le binaire est introuvable sur le coffre disque.
- **`/courriers/depart`** — Création d'un courrier sortant ; le numéro est **numéroté par type**
  de courrier départ.
- **`/courriers/integration-decharge`** — Rattachement du scan de la décharge signée à son
  courrier de départ ; le courrier passe en « Déchargé » puis est archivé.
- **`/courriers/recherche`** — Fonds des courriers traités et archivés. Recherche plein texte sur
  objet, description, référence et n° d'enregistrement. Colonnes : N° enregistrement, Objet,
  **Sens** (Arrivée / Départ / Interne), Correspondant, Destinataire, Date.

#### Fiche d'un courrier (`MailDetailPage`)

`PageHeader` avec fil d'Ariane vers la liste d'origine et bouton « Retour à la liste » ; bandeau
d'alerte d'échéance ; tiroir « Aperçu du courrier ». Trois onglets :

| Onglet | Contenu |
|---|---|
| **Courrier** | Métadonnées, actions du workflow (valider, imputer, traiter, archiver…) |
| **Imputations (n)** | Ajout d'une imputation : rôle, acteur, **type d'imputation** ; actions de traitement, suppression (avec `Popconfirm`), historique daté |
| **Fichiers (n)** | Pièces attachées : aperçu, téléchargement, détachement |

Workflow (miroir des enum partagées) : statut `Rédaction → Rédigé → Déchargé → Traité`
(+ `Supprimé`) ; types d'imputation système figés (Validation DG = 5, Pour suivi = 10, Validation
Direction = 14, En copie = 17) ; journal d'actions codifié (Déliaison, Décharge, Validation DG,
Soumission validation, Contrôle, Enregistrement réponse).

**Rappels automatiques** (worker) : paliers `PREMIERE_ALERTE / RAPPEL / DERNIERE_CHANCE /
URGENCE / RETARD`, fenêtre d'alerte d'imputation 48 h, intervalle anti-spam 6 h. L'interface et le
worker partagent les mêmes paliers pour ne jamais annoncer deux échéances différentes.

### 5.4 Section « Paramétrage Archives »

| Route | Page |
|---|---|
| `/admin/classification-plans` | Plan de classement (arbre) |
| `/admin/dossiers` | Gestion des dossiers (arbre) |
| `/admin/document-types` | Types de document |
| `/intercalaires` | Génération d'intercalaires (P1) |
| `/admin/archives/parametrage-types` | Paramétrage des types de documents |
| `/admin/archives/cycles-de-vie` | Cycles de vie |
| `/admin/archives/modes-destruction` | Modes de destruction |
| `/admin/archives/sorts-finaux` | Sorts finaux |
| `/admin/archives/motifs-pret` | Motifs de prêt |
| `/admin/archives/metadonnees` | Gestion des métadonnées |
| `/admin/archives/metadonnees-types` | Métadonnées par type de document |
| `/admin/archives/elements-listes` | Éléments des listes |
| `/admin/geolocalisation` | Géolocalisation *(écran masqué du menu, route accessible par URL)* |

#### `/intercalaires` — P1

**UI** en trois colonnes : *Catégorie* (liste de boutons à icône, état actif surligné —
type de document, plan de classement, dossier, géolocalisation, séparateur vierge) · *Éléments*
(champ de filtre, liste à cases à cocher **indentée selon la profondeur de l'arbre**, badge du
nombre de sélectionnés, « Tout sélectionner / désélectionner ») · *Aperçu de la feuille*
(vignette A4 au ratio 1:1,414 avec QR simulé et libellé). **Barre d'action collante** en bas :
récapitulatif (« N élément(s) sélectionné(s) ») et bouton **« Générer le PDF »**.

**Fonctionnalités** : une feuille A4 à QR par élément, ou une feuille unique pour le séparateur
vierge (aucune sélection requise) ; le PDF généré s'ouvre dans un nouvel onglet.

#### Référentiels

Les écrans plats (modes de destruction, sorts finaux, motifs de prêt, natures, types de départ,
types d'entité externe, confidentialités) partagent un layout générique : table, **édition en
place au clic sur une cellule**, création en ligne, désactivation avec `Popconfirm`.

Les écrans arborescents (plan de classement, dossiers, géolocalisation, organigrammes) offrent :
arbre déplaçable, colonnes *Nom de l'élément* / *Code*, édition inline, suppression récursive avec
confirmation explicite (« … et ses sous-éléments »).

Écrans spécifiques :

- **`/admin/archives/parametrage-types`** — associe à chaque type de document ses valeurs par
  défaut : dossier, plan de classement, confidentialité, plus les options d'acquisition (OCR,
  cryptage, scanner, routine, compression).
- **`/admin/archives/cycles-de-vie`** — règle de conservation par type : conformité, **DUA**
  (`Tooltip` : « au-delà, le document apparaît dans DUA expirés »), sort final, mode de
  destruction. Chargement d'une règle dans le formulaire pour modification.
- **`/admin/archives/metadonnees`** — champs d'indexation et leur **type de saisie** : Texte,
  Nombre entier, Date, Texte long, Oui/Non, Liste de valeurs.
- **`/admin/archives/metadonnees-types`** — association métadonnée ↔ type de document ; c'est
  elle qui **détermine le formulaire d'indexation** rendu dans l'acquisition et le détail document.
- **`/admin/archives/elements-listes`** — valeurs proposées pour les métadonnées de type Liste ;
  message guidant vers la création préalable d'une métadonnée « Liste ».

### 5.5 Section « Paramétrage Courrier »

| Route | Page |
|---|---|
| `/admin/courriers/organigrammes` | Arborescence des services / directions |
| `/admin/courriers/role-organigramme` | Rattachement rôle ↔ nœud d'organigramme |
| `/admin/courriers/types-entites-externes` | Catégories de correspondants (ministère, société, particulier…) |
| `/admin/courriers/entites-externes` | Correspondants (nom, type, e-mail, téléphone, propriétés personnalisées) |
| `/admin/courriers/types-imputation` | Types d'imputation ; l'option **Suivi** déclenche le traitement automatique à la lecture |
| `/admin/courriers/types-depart` | Types de courrier départ (pilotent la numérotation par type) |
| `/admin/courriers/natures` | Natures de courrier *(masqué du menu)* |
| `/admin/courriers/objets` | Objets types et **durées de suivi externe/interne en jours** *(masqué)* |
| `/admin/courriers/confidentialites` | Confidentialités courrier *(masqué)* |

L'organigramme du courrier est **dérivé du rôle du destinataire** : il n'existe pas de table
dédiée, l'assignation est portée par une colonne du rôle. Un `Alert` l'explique sur la page.
Les types d'imputation système portent un `Tooltip` « à ne pas désactiver ».

### 5.6 Section « Sécurité Documentaire »

| Route | Page |
|---|---|
| `/admin/securite/type-par-utilisateur` | Droits sur les types de document, par utilisateur |
| `/admin/securite/type-par-profil` | Idem, par **rôle** (clé de menu inchangée, axe changé profil → rôle) |
| `/admin/securite/confidentialite-utilisateurs` | Habilitation (niveau de confidentialité) de chaque utilisateur |
| `/admin/securite/confidentialites` | Référentiel des niveaux, **ordonnés du plus ouvert au plus fermé** — c'est l'ordre qui porte la règle d'accès |

Les deux écrans « type par … » partagent `TypeSecurityPage` : formulaire d'octroi (bénéficiaire,
type de document, **niveau de permission**), puis table **groupée par bénéficiaire** avec table
imbriquée des droits, retrait unitaire ou retrait en bloc (« Retirer les N droits de ce
bénéficiaire ? »).

### 5.7 Section « Administration »

- **`/admin/users`** — Comptes : nom d'utilisateur, nom complet, e-mail, **rôle**, statut ;
  création en ligne dans une carte « Nouvel utilisateur », suppression avec confirmation nominative.
- **`/admin/roles`** — Création de rôles et **choix des menus accessibles** (catalogue serveur).
  Le rôle détermine ce que l'utilisateur voit dans la barre latérale.
- **`/admin/parametres/email`** — Identité affichée dans les e-mails de notification : cartes
  *Identité*, *Coordonnées*, *Logo* (téléversement / retrait avec confirmation).

---

## 6. Notifications

- **In-app** : `Notification` en base, cloche dans la barre supérieure avec badge de non-lus,
  liste déroulante, marquage lu / tout lu (`GET /notifications`, `/unread-count`,
  `PATCH /:id/read`, `PATCH /read-all`).
- **E-mail** : `packages/mailer` (gabarit HTML + identité de marque + logo) via `nodemailer`.
  **Sans `SMTP_HOST`, le canal e-mail est désactivé** et seules les notifications in-app partent.
- **Déclencheurs** : imputations, échéances de courrier (worker), décisions d'accès.

---

## 7. Sécurité & permissions

Quatre mécanismes se superposent :

1. **RBAC par menu** — `MENU_CATALOG` (côté API) énumère les écrans ; `role_menu_permission`
   attribue les clés à un rôle. `/auth/me` renvoie `menuKeys`, qui filtre la barre latérale et la
   palette ; les endpoints sont gardés par `@RequireMenu`. `HIDDEN_MENU_KEYS` masque des écrans du
   menu sans supprimer les routes (accessibles par URL directe, endpoints toujours actifs).
2. **Droits par type de document** — `document_type_permission`, par utilisateur **ou** par rôle,
   avec un `PermissionLevel` (1 = Denied, jamais accordable ; puis Consultation, Modification,
   Administration, Archivistique). Le niveau **effectif** est calculé côté serveur et conditionne
   l'indexation, la gestion des accès et le cycle de vie.
3. **Droits par document** — `document_permission` (nominatif ou par groupe), gérés depuis les
   onglets « Accès par utilisateur / par profil ».
4. **Confidentialité** — niveaux ordonnés ; `canAccess` et la recherche filtrent réellement par
   **rang de confidentialité** (bypass pour admin, agent de scan et créateur). Les demandes
   d'accès (`document_access_inquiry`) restent en base et côté API, l'écran ayant été retiré.

Autres éléments : JWT (`@nestjs/jwt` + Passport), mots de passe `bcrypt`, changement de mot de
passe (`POST /auth/change-password`), **scellement Ed25519** et vérification d'intégrité des
documents, journaux `DataChangeAudit` / `NavigationAudit` / `MailActionLog`.

---

## 8. Modèle de données (aperçu)

59 modèles Prisma répartis en huit fichiers. Les états métier sont des `smallint` + `CHECK`
(pas d'enum Prisma), avec un miroir TypeScript dans `packages/types`.

| Fichier | Modèles principaux |
|---|---|
| `core` | `AppUser`, `AppGroup`, `AppUserGroup`, `Role`, `UserSetting`, `Document`, `DocumentFile`, `DocumentVersion`, `AcquisitionBatch` |
| `referentials` | `DocumentType`, `Dossier`, `ClassificationPlan`, `Location`, `FileType`, `IntercalaireCategory`, `Confidentialite` |
| `archives` | `DocumentLifeCycle`, `DocumentTypeLifeCycle`, `DocumentTypeSetting`, `FinalFate`, `DestructionMode`, `LendingMotive`, `LendingDocument(+Detail/Comment)`, `DossierExitMotive`, `MetaData`, `MetaDataDocumentType`, `MetaDataListItem`, `DocumentMetadataValue` |
| `courriers` | `Mail`, `MailDocument`, `MailInputation`, `MailInputationType`, `MailNature`, `MailObjet`, `MailDepartType`, `MailConfidentialite`, `MailComment`, `MailActionLog`, `MailScannedDocument`, `MailPermission`, `Organigramme`, `ExternalEntity(+Type/CustomProperty/CustomValue)` |
| `security` | `PermissionLevel`, `DocumentPermission`, `DocumentTypePermission`, `DocumentAccessInquiry`, `DocumentSeal`, `RoleMenuPermission` |
| `analytics` | `AnalyticsTarget` |
| `audit` | `AuditAction`, `DataChangeAudit`, `NavigationAudit` |
| `notifications` | `Notification`, `EmailTemplateSetting` |

**États documentaires** : `Non archivé (0)`, `Archivé (1)`, `Restreint (2)`, `Épuré (3)`,
`Vidéo-codage (4)` — cohabitent avec `is_archived` / `is_frozen`, qui restent la vérité de
l'acquisition, de la QA et de la recherche ; seule l'épuration écrit `document_state`.

---

## 9. Surface d'API (résumé)

Préfixe `/api`, port 3001.

| Domaine | Endpoints notables |
|---|---|
| `auth` | `POST /login`, `POST /change-password`, `GET /me` |
| `intercalaires` | `GET /categories`, `GET /items`, `POST /generate` |
| `batches` | `POST /`, `POST /:id/files`, `GET /:id`, `GET /:id/documents`, `POST /:id/reprocess` |
| `documents` | `POST /search`, `POST /export`, `POST /cotes/check`, `PATCH /:id/indexation`, `GET/PUT /:id/life-cycle`, `GET/POST/DELETE /:id/permissions`, `GET/PUT /:id/confidentialite`, `GET /:id/lendings`, `GET/POST /:id/integrity`, `GET/POST /:id/seal`, `GET /sealing/public-key`, `GET /:id/scanning`, `GET /:id/history`, `GET /:id/files/:fileId/content` |
| `archives` | `GET /dua-expired`, `POST /dua-expired/purge`, `GET /purged`, `POST /lendings`, `GET /lendings/out|mine|history`, `POST /lendings/details/:id/return`, `POST /lendings/comments` |
| `archives/settings` | CRUD modes de destruction, sorts finaux, motifs de prêt, paramétrage des types, cycles de vie, métadonnées, éléments de liste, associations métadonnée↔type |
| `referentials` | Types de document (+export), types de fichier, auteurs, niveaux de permission, confidentialités, plans (+export) |
| `courriers` | Badges, files (`controle`, `validation-direction`, `parapheur`, `suivi`, `depart`, `decharges-en-attente`), numérotation (`next-reference/...`), acteurs, documents scannés, fiche d'imputation (JSON + PDF), `POST /arrivee|depart|recherche`, actions (`valider`, `decharge`, `enregistrement-reponse`, `validation-dg`, `archiver`, `integration-decharge`), extraction IA |
| `courriers/imputations` | Création, suppression, validation, lecture, traitement (par imputation ou par destinataire) |
| `courriers/referentials` | Natures, objets, types d'imputation, types de départ, confidentialités, entités externes et leurs propriétés personnalisées |
| `courriers/organigramme` | Arbre, assignations de rôle, création / déplacement / renommage / désactivation |
| `courriers/dashboard` | `layout` (GET/PUT/DELETE) + `alertes`, `files`, `synthese`, `flux`, `repartition`, `retards`, `delais`, `charge`, `hygiene` |
| `analytics` | `layout` (GET/PUT/DELETE), `POST /overview`, `POST /targets`, `POST /export` |
| `roles`, `users` | CRUD + catalogue de menus assignables |
| `notifications` | Liste, non-lus, marquage |
| `parametres/email-template` | Gabarit, logo (GET/POST/DELETE) |
| `access-inquiries` | Création, liste, décision *(écran retiré, API conservée)* |

---

## 10. Démarrage & exploitation

```bash
pnpm install
cp .env.example .env
docker compose up -d redis
pnpm --filter @archivage/db prisma migrate deploy
pnpm --filter @archivage/db run db:seed
pnpm dev
```

- **web** `http://localhost:5000` · **api** `http://localhost:3001/api` · **worker** en tâche de fond.
- Variables clés : `DATABASE_URL`, `REDIS_URL`, `ARCHIVES_PATH`, `JWT_SECRET`, `TESSERACT_LANG`,
  `SMTP_*`, `OPENAI_API_KEY` / `OPENAI_MODEL`.
- Ne jamais lancer deux serveurs de dev sur le même `.next` (garde `ensure-single-dev.mjs`).
- Détails : [`operations.md`](operations.md), [`deploiement-windows.md`](deploiement-windows.md),
  [`agent-scan-poste.md`](agent-scan-poste.md).
