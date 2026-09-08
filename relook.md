# PRD — « Relook » : refonte visuelle et UX de DocuPro V6 sur le design Plus Admin

> **Version** 1.1 — 2026-08-06 (v1.0 relue et corrigée par revue croisée : fidélité aux tokens,
> couverture applicative, solidité du prompt, faisabilité Ant Design)
> **Statut au 2026-08-07** : plan validé, **phases 2, 3 et 4 implémentées**.
> Recette : `tsc --noEmit` propre, `next lint` propre, 462 tests verts, build de production
> webpack OK. **Les 19 points d'arbitrage du §10 de `specs/002-relook/plan.md` sont tranchés**
> et les composants orphelins de la fiche document ont été supprimés.
> **Référence design** : template **Plus Admin** (BootstrapDash, Bootstrap 5) —
> démos `https://demo.bootstrapdash.com/plus-admin/themes/vertical-light/` et `vertical-dark/`.
> **Application cible** : DocuPro V6 (GED/SAE) — voir `docs/OVERVIEW-APPLICATION.md` pour la
> cartographie complète des pages, composants et du design system actuel.

---

## 1. Résumé exécutif

DocuPro V6 utilise aujourd'hui l'identité « Atelier d'archives » (bleu roi `#1668C5` + ocre
manille, rayons doux, ombres légères, Geist/Bricolage Grotesque). Ce PRD décrit le **relook
complet** de l'application sur l'identité visuelle du template **Plus Admin** — et, au-delà du
restylage, une **passe UX** pour rendre l'expérience plus conviviale, sans changer aucune
fonctionnalité ni aucun contrat d'API.

Trois principes non négociables :

1. **Fidélité au design Plus Admin, sauf dérogations listées** — toutes les caractéristiques du
   template sont respectées, **en particulier la rondeur des bordures** (§4.2, règle d'or du
   projet). Les seuls écarts admis sont les **dérogations assumées du §4.6** (accessibilité,
   langue française, densité de production) : tout autre écart est un défaut.
2. **Réinterprétation, pas d'import** — Plus Admin est un template Bootstrap 5 ; DocuPro reste
   sur **Ant Design 5 + Tailwind**. On ne charge **aucun CSS/JS Bootstrap** : on transpose les
   tokens Plus Admin dans `tokens.ts` → `antdTheme.ts` → `globals.css`, la chaîne de theming
   existante de l'application.
3. **Accessibilité au moins égale** — le relook ne peut pas dégrader les contrastes ni les
   comportements d'accessibilité existants ; les couleurs vives de Plus Admin sont encadrées
   par les règles du §4.1.

---

## 2. Périmètre

### 2.1 Inclus

- **Relook UI de 100 % des éléments d'interface** :
  - le chrome applicatif (sidebar, top bar, palette de commandes, écran d'attente
    d'authentification, drawer mobile) ;
  - les ~50 pages des six sections, **y compris les écrans masqués du menu** (accessibles par
    URL directe : `/admin/geolocalisation`, `/admin/courriers/natures`, `/admin/courriers/objets`,
    `/admin/courriers/confidentialites`) et la galerie interne `/design` ;
  - la bibliothèque de composants maison (`PageHeader`, `KpiCard`, `StatTile`, `StatusTile`,
    `CountBadge`, `StatusBadge`, `InfoCard`, `FormSection`, `AiFilledTag`, `EmptyState`,
    squelettes, `editable.tsx`, `RefLayout`/`BulkRefPage`/`MailRefPage`, `BatchPipeline`,
    `MetaDataFields`, `MetaDataDisplay`, `PdfViewer`, `NotificationsBell`, `BrandMark`… —
    l'exhaustivité sera vérifiée contre `apps/web/app/components/` en phase 1) ;
  - ~~les primitives partagées de `packages/ui`~~ — **retiré du périmètre** (arbitrage n°1
    validé le 2026-08-07 : le package ne contient que `export {};`, aucune primitive n'existe) ;
  - tous les composants Ant Design consommés (tables, forms, modales, drawers, tabs, steps,
    tags, tooltips, dropdowns, messages…), les graphiques `@ant-design/plots`, l'écran de
    connexion, les états vides, chargements et erreurs.
- **Thèmes clair ET sombre**, mappés sur les variantes `vertical-light` / `vertical-dark` de
  Plus Admin, via le mécanisme existant (`data-theme`, `darkAlgorithm`, SSR toujours clair).
- **Passe UX transverse** (§6) : hiérarchie visuelle, densité, feedback, navigation, cohérence
  inter-écrans, micro-interactions — à iso-fonctionnalités.
- **Documents générés à identité de marque** (best-effort, phase 4) : gabarit HTML des e-mails
  (`packages/mailer`), exports Excel/CSV/PDF/Word de la recherche et fiche d'imputation PDF
  (`packages/exports`) — en-têtes, couleurs et tableaux alignés sur la nouvelle identité, dans
  les limites des clients mail et des générateurs de documents.

### 2.2 Exclus (interdits pendant tout le projet)

- Toute modification **fonctionnelle** : endpoints, schéma Prisma, workflows métier, permissions,
  navigation (routes), textes métier, comportement du worker/scan-agent.
- Tout changement de **stack** : pas de Bootstrap, pas de nouveau framework CSS, pas de
  remplacement d'Ant Design.
- La refonte du **logo** / de la marque DocuPro (le logo existant est conservé, posé sur les
  nouveaux fonds).
- Les **feuilles d'intercalaires A4 générées** (`packages/pdf`) : artefact technique noir et
  blanc destiné à l'impression et à la lecture QR — aucune modification (risque sur la chaîne
  de numérisation, aucun bénéfice utilisateur).
- Les écrans masqués **restent masqués du menu** (mais sont bien relookés, cf. §2.1 — ils
  héritent pour l'essentiel de `RefLayout`) ; les gardes d'accès (`menuKeys`) restent inchangées.

---

## 3. Contexte technique (état actuel — à lire avant de planifier)

| Élément | Où | Rôle |
|---|---|---|
| Tokens design | `apps/web/app/theme/tokens.ts` | **Source de vérité unique** des couleurs/rayons/ombres |
| Thème AntD | `apps/web/app/theme/antdTheme.ts` | Tokens globaux + par composant, `cssVar: true`, `darkAlgorithm` |
| CSS global | `apps/web/app/globals.css` | Variables `--da-*`, styles `.da-*`, focus ring, reduced motion |
| Graphiques | `apps/web/app/theme/charts.ts` | Palette et défauts des graphiques `@ant-design/plots` |
| Mouvement | `apps/web/app/theme/motion.ts` | Variantes Framer Motion tokenisées |
| Icônes | `apps/web/app/theme/icons.tsx` | Indirection lucide-react |
| Chrome | `AuthShell`, `TopBar`, `CommandPalette` (apps/web/app/components/) | Sidebar 264/76 px, top bar, palette ⌘K |
| Navigation | `apps/web/app/components/nav.ts` | Source unique sidebar/drawer/palette |
| Typo | Geist Sans/Mono + Bricolage Grotesque (`--font-display`) | À remplacer (§4.3) |

Contraintes héritées à ne pas casser : SSR clair sans mismatch d'hydratation, persistance
`da-theme`/`da-sider-collapsed`, filtrage par `menuKeys`, badges de menu 120 s, accordéon à une
seule section, drawer mobile < `lg`, **redirections d'AuthShell en navigation *document* en dev**
(contournement des transitions avalées par le rebuild HMR), filet anti-`ChunkLoadError`,
`MotionConfig reducedMotion="user"`, focus ring `:focus-visible`, patch React 19 d'AntD, port
web 5000, `next dev --turbopack` (garde `ensure-single-dev.mjs` — ne jamais lancer deux serveurs
dev).

---

## 4. Spécification design — les caractéristiques Plus Admin à respecter

Tokens extraits du CSS compilé de la démo officielle (`vertical-light/style.css` et
`vertical-dark/style.css`, relevé du 2026-08-06). **Ces valeurs sont normatives.** Quand la
cible DocuPro s'écarte volontairement du relevé, l'écart est signalé ici et récapitulé au §4.6.

### 4.1 Palette

#### Thème clair

| Rôle | Valeur | Usage |
|---|---|---|
| **Primaire** | `#0033c4` | Bleu roi profond : top bar, boutons primaires, liens, états actifs |
| Primaire actif (menu) | `#1a55e3` | Fond de l'item de menu actif dans la sidebar |
| Secondaire | `#a0a0a0` | Boutons/badges secondaires (jamais en texte sur blanc : ≈ 2,3:1) |
| Succès | `#00d284` | Vert menthe |
| Info | `#00cff4` | Cyan |
| Alerte (warning) | `#ff5730` | Orange vif |
| Danger | `#ff0854` | Rose/rouge vif — erreurs et surfaces de danger. (La languette de repli qui l'utilisait aussi a été retirée : §4.6 n°8) |
| Dégradé signature | `linear-gradient(to right, #00cff4, #0033c4)` | Relevé sur l'encart d'appel à l'action de la sidebar de la démo ; **étendu volontairement** (§4.6) aux bandeaux héros et au panneau de marque du login |
| Fond de contenu | `#f8f9fb` | Fond de la zone de travail |
| Fond de carte / sidebar | `#ffffff` | Cartes et barre latérale blanches |
| Bordure | `#e4e9f0` | Bordures de cartes, séparateur sidebar/contenu |
| Texte principal | `#030303` | Corps de texte, titres h1-h6 (héritent du corps) |
| Titre de carte / texte fort | `#313131` | `card-title`, `.text-dark` |
| Texte secondaire | `#76838f` | Descriptions, sous-titres |
| Palette étendue | bleu `#5e50f9`, indigo `#6610f2`, violet `#6a008a`, rose `#e91e63`, rouge `#f96868`, orange `#f2a654`, jaune `#f6e84e`, vert `#46c35f`, sarcelle `#58d8a3`, cyan `#57c7d4` | Séries de graphiques, avatars, accents |

#### Thème sombre

| Rôle | Valeur |
|---|---|
| Fond de contenu | `#111115` |
| Fond de carte / sidebar | `#252529` |
| Bordure de carte | `#111115` (effet « carte fondue » du template — réservé aux cartes, cf. règle des bordures ci-dessous) |
| Bordure de contrôles (champs, tables) | **dérivé à calculer** ≈ `#3a3a42` ou plus clair — cible ≥ 3:1 sur `#252529` (adaptation §4.6 : `#111115` sur `#252529` ≈ 1,2:1, invisible) |
| Fond élevé (popups, dropdowns) | **dérivé à calculer** ≈ `#2d2d32` (`colorBgElevated`) — l'ombre de popover est quasi invisible sur fonds sombres, la surface élevée doit se distinguer |
| **Top bar** | **reste `#0033c4`** (la barre supérieure ne change pas de couleur en sombre) |
| Texte navbar non interactif | `#8e94a9` (les liens/icônes de nav restent blancs, cf. §4.4) |
| **Primaire sombre** | **dérivé éclairci à calculer** pour `colorPrimary`/`colorLink` du thème sombre — cible ≥ 4,5:1 sur `#111115` (`#0033c4` n'y contraste qu'à ≈ 2,0:1 ; il est réservé à la surface de la top bar). L'item actif sidebar garde `#1a55e3` avec texte blanc (≈ 6,1:1, conforme) |
| Sémantiques | inchangées (`#00d284`, `#00cff4`, `#ff5730`, `#ff0854`) pour les surfaces et icônes ; texte : dérivés AA (règle ci-dessous) |

#### Règles de contraste (normatives — adaptation §4.6)

Les sémantiques Plus Admin sont vives : sur fond blanc, du blanc posé dessus contraste à
≈ 2,0:1 (`#00d284`), 1,9:1 (`#00cff4`), 3,2:1 (`#ff5730`), 3,9:1 (`#ff0854`) — toutes sous le
seuil AA texte de 4,5:1. Règles transposées de l'actuelle « règle de l'ocre » :

1. Les valeurs vives brutes sont réservées aux **surfaces sans texte** : pastilles, points de
   statut, icônes, remplissages, bordures, barres de progression. (Une icône blanche posée sur
   `#ff0854` passe le seuil non-texte de 3:1.)
2. Tout **texte** porté par une sémantique — badges à texte, messages d'erreur/alerte de
   formulaire (`colorError`, `colorWarning`), liens d'état — utilise des **dérivés assombris**
   (clair) ou **éclaircis** (sombre) à calculer en phase 1, cible ≥ 4,5:1, teinte préservée.
   Les badges pleins gardent leur texte blanc **sur fond dérivé assombri AA**.
3. Chaque dérivé est documenté avec son ratio calculé (phase 1 : dans `design-tokens.md` ;
   phase 2 : reporté en commentaire dans `tokens.ts`).

### 4.2 ⭐ Rondeur des bordures — règle d'or du projet

Plus Admin est un design **aux angles nets et discrets** : de **petits rayons (2 à 5 px)** sur
tous les blocs, contrastés par des **pilules pleines et des cercles** sur les éléments compacts.
C'est l'ADN visuel du template — la grille **cible** ci-dessous est exhaustive et
**aucun composant ne doit s'en écarter**. Là où le relevé du template diffère (colonne
« Relevé »), la cible est une harmonisation assumée dans l'esprit « petits rayons nets » (§4.6).

> **Assouplissement du 2026-09-08 (dérogation §4.6 n°9)** : sur décision du propriétaire du
> produit, les **champs et boutons passent à 8 px** et les **cartes, tuiles, bandeaux
> d'alerte, modales et popups (infobulles comprises) à 12 px** — le 2/3/4/5 px était jugé trop
> sec sur des champs de 46 px. Ne bougent pas : badges/tags (4 px), en-têtes de table (3 px),
> pilules et cercles. Les lignes concernées ci-dessous portent l'ancienne valeur barrée.

| Élément | Rayon cible | Relevé template | Token AntD cible |
|---|---|---|---|
| Champs de saisie (Input, Select, InputNumber, DatePicker, TextArea, upload) | ~~2 px~~ → **8 px** (`radii.field`) | 2 px | `Input/Select/DatePicker…` : `borderRadius`, `borderRadiusLG` **et** `borderRadiusSM` à `radii.field` (le rayon doit tenir à toutes les tailles, y compris `size="large"`) |
| Cartes (`Card`, conteneurs), tuiles KPI, bandeaux héros, panneaux encartés | ~~3 px~~ → **12 px** (`radii.card`) | 3 px (rounded 5 px) | `Card.borderRadiusLG: radii.card` ; les surfaces dessinées à la main (`StatTile`, `HeroBanner`, `BatchPipeline`, squelettes…) consomment le même token |
| Modales | ~~5 px~~ → **12 px** (`radii.card`) | 8 px (`--bs-border-radius-lg`) | `Modal.borderRadiusLG: radii.card` — une modale est une carte flottante |
| Boutons | ~~4 px~~ → **8 px** (`radii.field`) | 4 px | `Button.borderRadius/LG/SM: radii.field` — les boutons suivent les champs, un bouton à 4 px collé à un champ à 8 px se voit |
| Badges / Tags | **4 px** (pilule : `10rem`) | 4 px (pill 10rem) | `Tag.borderRadiusSM: 4` |
| Menus déroulants, popovers, toasts, notifications, zone de dépôt | ~~5 px~~ → **12 px** (`radii.card`) | navbar-dropdown 5 px ; dropdown générique 6 px ; popover 8 px | `Dropdown/Popover/Message/Notification/Upload` : `borderRadiusLG: radii.card` |
| Infobulles (`Tooltip`) | ~~5 px~~ → **12 px** (`radii.card`) | 6 px | **`Tooltip.borderRadius: radii.card`** — `Tooltip` consomme le rayon de BASE, pas `borderRadiusLG` : d'où une clé différente des autres popups |
| Bandeaux d'alerte (`Alert`) | ~~4 px~~ → **12 px** (`radii.card`) | — | `Alert.borderRadiusLG: radii.card` — un bandeau encadre un bloc de page comme une carte |
| Boutons « pilule » | **50 px** | 50 px | classe utilitaire dédiée |
| Avatars, pastilles de statut, points | **100 % / cercle** | 100 % | `Avatar` shape circle |
| Base globale AntD | **4 px** | base Bootstrap 6 px | `token.borderRadius: 4`, `borderRadiusSM: 2`, `borderRadiusLG: 5` |

Restent à la valeur d'origine : badges/tags (4 px), en-têtes de table (3 px), pilules et
cercles. Restent aussi à 3 px deux marques qui ne sont pas des surfaces : les barres des
graphiques et l'aperçu de feuille A4 des intercalaires.

Interdictions explicites : **aucun rayon hors de la grille cible ci-dessus** — pas de coins
« doux » génériques, pas de mélange d'échelles. (Le template contient ponctuellement du 8 px
(modales/popovers), 15 px (encart sidebar) et 20 px (images) : ces valeurs ne sont **pas**
reprises, harmonisation §4.6.)

### 4.3 Typographie

| Caractéristique | Valeur Plus Admin | Transposition DocuPro |
|---|---|---|
| Famille unique | **Open Sans** (300/400/600/700) | Chargée via `next/font/google` (subset latin, `display: swap`, variable `--font-sans`) ; remplace Geist Sans et **Bricolage Grotesque**. Sort des variables existantes : `fonts.sans` et `fonts.display` de `tokens.ts` pointent vers Open Sans, `--font-display` est **conservée comme alias** vers Open Sans (aucun consommateur à modifier, la distinction titres se fait par graisse) ; seule `--font-geist-mono` subsiste pour les n° d'enregistrement et données monospace |
| Corps | body 16 px ; **paragraphes, tables et la plupart des composants 14 px** (`0.875rem`, dominante du template) | `token.fontSize: 14` (transposition de la dominante) |
| Champs de saisie | 13 px (`0.8125rem`) | `Input.inputFontSize: 13` (token AntD explicite ; équivalents Select/DatePicker si besoin) |
| Boutons | **12 px, graisse 600** | `Button.contentFontSize: 12` (+ `contentFontSizeSM/LG` si utilisées), `Button.fontWeight: 600` |
| Titres h1-h6 | Open Sans **600**, couleur héritée du corps (`#030303`) | Titres d'écran (`PageHeader`…) en 600 |
| Titre de carte | **16 px, graisse 700, `#313131`**, `text-transform: capitalize` | `card-title` 16/700/`#313131` ; la capitalisation automatique est **abandonnée** (§4.6 — le français s'en accommode mal) |
| Badges | 11 px, 600 | `Tag` |
| Labels de formulaire | 14 px, `margin-bottom: 0.5rem` | `Form` |
| Navbar | Open Sans 300 | TopBar |

### 4.4 Structure du chrome (layout Plus Admin)

| Élément | Spécification Plus Admin | Transposition |
|---|---|---|
| **Top bar** | **60 px de haut, fond primaire plein `#0033c4`**, à droite de la sidebar (`left: 260px`), Open Sans 300. Contenu : **liens et icônes blancs dans les deux thèmes** ; texte non interactif blanc en clair, `#8e94a9` en sombre | `TopBar` : passe de « barre neutre » à **barre bleu roi pleine**, y compris en thème sombre. Application par élément : cloche, bascule de thème, déclencheur mobile, avatar = blancs (deux thèmes) ; titre/fil d'Ariane = blanc (clair) / `#8e94a9` (sombre). **Mécanisme imposé** (garde-fou §7 n°2 : pas de valeurs en dur) : îlot de thème dédié — tokens `topbarBg` / `onTopbar` / `onTopbarMuted` dans `tokens.ts` exposés en variables `--da-topbar-*`, ou `ConfigProvider` imbriqué avec sa propre clé `cssVar` ; focus ring blanc/cyan sur fond bleu (§6.9) ; les popovers portalés (notifications, menu utilisateur) restent rendus sous le thème ambiant, sur fond de surface |
| **Déclencheur de repli** | *(Relevé du template : languette 48×60 px, fond danger `#ff0854`, icône blanche, accrochée au bord gauche de la top bar, pilule côté gauche.)* **Non repris — dérogation §4.6 n°8.** | **Bouton texte discret** dans la top bar, aligné sur les autres actions (cloche, bascule de thème) : fond transparent, icône blanche, survol `rgba(255,255,255,.14)`, rayon 4 px. Le glyphe dit le sens de l'action — `PanelLeftClose` / `PanelLeftOpen` en desktop, hamburger en mobile (ouverture du drawer). La top bar retrouve un padding gauche normal de 16 px |
| **Sidebar** | **260 px, fond blanc, bordure droite `#e4e9f0`** (sombre : `#252529`, sans bordure) ; **libellés de niveau 1 `#141212`** (sombre `#6a6b83`) ; **item actif : fond plein `#1a55e3` pleine largeur, texte et icône blancs, graisse 600** ; sous-menu au repos `#3e4b5b` (sombre `#6a6b83`), sous l'item actif : liens `#dfe2e8`, lien actif blanc ; mode replié « icône seule » | Adapter la sidebar 264→260 px (le **drawer mobile passe de 280 à 260 px**, aligné) ; l'état actif « rempli pleine largeur » remplace le style actif actuel ; conserver accordéon, badges de compteurs, filtrage `menuKeys`, persistance du repli. **Le mode replié impose une icône par SECTION** (`NavSection.icon`) : AntD ne masque le libellé d'une entrée repliée que s'il suit une icône (`.ant-menu-item-icon + span`) — sans elle les titres de section débordent du rail de 76 px, tronqués en « Docu-A », « Paramé »… Le libellé masqué emportant le cumul de compteurs de la section, celui-ci repasse en **pastille sur l'icône** quand la barre est repliée |
| **Écran d'attente d'authentification** | — | Logo + spinner pendant `/auth/me` : fond `#f8f9fb` / `#111115`, spinner primaire — première surface vue à chaque session |
| **Zone de contenu** | Fond `#f8f9fb` (sombre `#111115`), padding `25px 27px` | `.da-page` |
| **Cartes** | **Plates et bordées** : fond blanc, `border: 1px solid #e4e9f0`, **pas d'ombre portée** (ombre douce `0 1px 15px 1px rgba(230,234,236,0.35)` réservée à de rares éléments flottants) ; `card-body` padding `30px 28px` ; titre 16/700 `#313131`, description `#76838f` | **Mécanisme imposé** : la platitude s'obtient en retirant les usages CSS de `--da-shadow-card`/`-raised` dans `globals.css` et l'ombre du composant `Card` — **pas en zéroïsant les tokens globaux `boxShadow*`**, dont dépendent Modal, Drawer et les popups. Mapping : `boxShadowSecondary` (popups Select/Dropdown/Popover) → `0 3px 21px rgba(0,0,0,0.2)` ; Modal/Drawer conservent une ombre ; en sombre, la distinction des surfaces élevées passe par `colorBgElevated` (§4.1) |
| **Champs** | Hauts et aérés : padding `0.94rem 1.375rem`, `line-height: 1` (~46-48 px de haut), fond blanc, bordure neutre, rayon 2 px | **Densité UNIQUE à 36 px** (dérogation §4.6 n°10, décidée le 2026-09-08) : `token.controlHeight` à 36 pilote *tous* les champs et boutons de l'application, **sans aucune exception** ; `controlHeightSM: 28` repinné. `controlHeightLG: 46` reste défini mais **n'est plus consommé nulle part** — plus un seul `componentSize="large"` ni `size="large"` sur un champ ou un bouton |
| **Tables** | Rendu visible des pages démo (`custom-table`) : en-tête **700**, fond `#f8f9fb` (sombre **`#1e1e20`**), sans bordure haute ; cellules 14 px, `vertical-align: middle` | **Deux densités explicites** (§4.6) : tables de **production** (files courriers, recherche) en `size="small"`, `Table.cellPaddingBlockSM` ≈ 6-8 px → lignes 32-36 px ; tables de **consultation** aérées, `Table.cellPaddingBlock: 15` (le padding `0.9375rem` du template). Le plan de phase 1 liste quels écrans utilisent quelle densité |
| **Dropdowns** | Navbar-dropdown : sans bordure, rayon 5 px, ombre `0 3px 21px rgba(0,0,0,0.2)` ; dropdown générique : rayon 6 px, bordure `#e4e9f0`, ombre douce `0 1px 15px 1px rgba(230,234,236,0.35)` | Unification cible : rayon 5 px (§4.2), ombre `0 3px 21px rgba(0,0,0,0.2)` via `boxShadowSecondary` |
| **Boutons** | 12 px/600 ; padding généreux ; variantes pleines, **outline (bordure 1 px)**, sociales, pilule, icône seule | Boutons AntD mappés ; boutons d'action de tables en `small` |

### 4.5 Éléments signatures à reproduire

1. **Top bar bleu roi pleine largeur** — le marqueur visuel n° 1 du template.
2. ~~**Languette rose de repli** arrondie côté gauche — le marqueur n° 2.~~ **Retirée**
   (dérogation §4.6 n°8) : le repli passe par un bouton texte discret de la top bar (§4.4).
3. **Item de menu actif rempli `#1a55e3`** pleine largeur, texte blanc.
4. **Dégradé cyan→bleu** — relevé sur l'encart sidebar de la démo, **étendu volontairement**
   aux éléments héros de DocuPro (bandeau d'accueil des tableaux de bord, panneau de marque du
   login) : décision produit assumée, pas un relevé (§4.6).
5. **Cartes plates bordées** — l'interface « respire » par la couleur de fond `#f8f9fb` et les
   bordures fines, pas par les ombres.
6. **Petits rayons nets** (§4.2) contrastés par pilules et cercles.
7. **Badges pleins saturés à texte blanc** (11 px/600) pour les statuts — transposés sur les
   **fonds dérivés AA** du §4.1 (les valeurs vives brutes échouent au contraste avec du texte).

### 4.6 Dérogations assumées (liste exhaustive — référencée par les critères §9)

Écarts volontaires au relevé du template, chacun motivé. Tout écart **hors de cette liste** est
un défaut :

1. **Contraste AA** : dérivés assombris/éclaircis pour tout texte sur sémantiques (badges,
   erreurs/alertes de formulaire), primaire sombre éclairci, bordure de contrôles sombre,
   `colorBgElevated` sombre, dérivés par thème pour les teintes de graphiques trop claires
   (§4.1, §5).
2. **Rayons harmonisés** : modales 5 px (relevé 8), dropdown générique/tooltip/popover unifiés
   à 5 px (relevés 6/6/8), abandon des 15 px et 20 px ponctuels du template (§4.2).
3. **`text-transform: capitalize` abandonné** sur les titres de carte (langue française, §4.3).
4. **Deux densités de tables** : production 32-36 px (le padding 15 px du template est réservé
   aux tables de consultation) (§4.4, §6.6).
5. **Boutons et contrôles compacts (`small`) dans les toolbars** de tables (§4.4).
6. **Dégradé signature étendu** aux bandeaux héros et au login (§4.5.4).
7. ~~**Champs hauts limités aux formulaires pleine page** via `componentSize="large"` — les
   commandes `middle` restent à 36 px (§4.4).~~ **Supprimée** par la dérogation n°10.
8. **Languette de repli rose abandonnée** (signature §4.5 n°2) : le bloc `#ff0854` de 48×60 px
   accroché au bord gauche de la top bar a été **refusé par le propriétaire du produit**
   (2026-09-08, motif : couleur jugée disgracieuse). Remplacée par un bouton texte discret
   aligné sur les autres actions de la top bar (§4.4). Conséquences : le token
   `topbarToggler` / `--da-topbar-toggler` est supprimé de `tokens.ts` et de `globals.css`,
   `#ff0854` ne sert plus qu'aux surfaces de danger, et §4.5 ne compte plus que
   **6 signatures**.
9. **Rayons assouplis** (§4.2) : champs et boutons → **8 px** (`radii.field`) ; cartes,
   tuiles, bandeaux d'alerte, modales, menus déroulants, popovers, infobulles, toasts et zones
   de dépôt → **12 px** (`radii.card`). Décidé par le propriétaire du produit le 2026-09-08, en
   deux temps (champs et cartes d'abord, surfaces flottantes ensuite). Motif : sur des champs
   de 46 px, le 2 px du template paraissait sec, les cartes trop dures autour d'eux, puis une
   modale à 5 px détonnait autour d'un formulaire à 8 px. `card` est volontairement au-dessus
   de `field` pour que le conteneur enveloppe visuellement ses champs. Appliqué
   **globalement** dans `antdTheme.ts` ; badges/tags, en-têtes de table, pilules et cercles ne
   bougent pas — et `radii.lg` (5 px) n'est plus consommé par aucune surface. Contrainte
   technique : les rayons passent par les **tokens de composants AntD**, jamais par du CSS — `Space.Compact` calcule ses angles intérieurs plats à partir du token, une
   règle CSS les aurait écrasés.
10. **Densité de champs unique — le gabarit 46 px abandonné** (supprime la dérogation n°7).
   Sur décision du propriétaire du produit (2026-09-08), **tous les champs et boutons de
   l'application sont à 36 px** : la fiche document (écran de consultation, resté en `middle`)
   servait de référence, et les formulaires pleine page qui la doublaient en 46 px juraient à
   côté. Concrètement : plus aucun `componentSize="large"` (9 emplacements retirés, dont
   `RefLayout`, `MailRefPage`, `FormAbovePanel`, `NewExternalEntityModal`) ni `size="large"`
   sur un champ ou un bouton. Les épinglages `size="middle"` et les hauteurs forcées
   `var(--ant-control-height-lg)` qui n'existaient QUE pour recoller un bouton à un champ haut
   disparaissent avec — un `Space.Compact` n'aligne son bouton sur son champ que si aucun des
   deux n'est épinglé. **Aucune exception** : `/login` et l'invite de la palette ⌘K, d'abord
   conservées en 46 px, y sont passées aussi. `controlHeightLG: 46` reste défini dans le thème
   mais n'est plus consommé par aucune surface.
   Conséquence sur §6.6 : la « densité différenciée » ne concerne plus que les tables.
11. **Sous-titres supprimés** : sur décision du propriétaire du produit (2026-09-08), les
   descriptions grises sous les titres n'existent plus dans l'application. Deux props ont été
   retirées des composants eux-mêmes, pas seulement de leurs appels — `PageHeader.description`
   (58 sous-titres d'écran) et `EmptyState.description` — pour qu'aucune ne puisse revenir par
   inadvertance ; les patrons qui les relayaient (`RefLayout`, `BulkRefPage`, `MailRefPage`,
   `LendingListPage` avec son `emptyHint`, `MailWorklist` avec son `emptyDescription`) ont
   perdu les leurs dans la foulée. **Ne sont PAS concernés** : les `Alert` (ce sont des
   messages contextuels) et surtout les `description` de `Popconfirm`, qui portent la
   conséquence d'une action et restent exigées par §6.3.

---

## 5. Inventaire des surfaces à relooker

Chaque écran listé dans `docs/OVERVIEW-APPLICATION.md` §5 est dans le périmètre — écrans
masqués inclus (§2.1). Points d'attention par famille :

| Famille | Écrans | Prescriptions spécifiques |
|---|---|---|
| Connexion | `/login` | Panneau de marque : dégradé signature cyan→bleu (remplace le dégradé actuel) ; formulaire : champs au gabarit commun 36 px (§4.6 n°10), bouton primaire `#0033c4` pleine largeur |
| Tableaux de bord | `/dashboards`, `/courriers/tableau-de-bord` | Bandeau d'accueil sur dégradé signature ; `KpiCard`/`StatTile`/`StatusTile` en cartes plates bordées ; palette de séries `@ant-design/plots` (`charts.ts`) re-mappée sur la palette étendue Plus Admin avec **audit de lisibilité dans les deux thèmes** — le jaune `#f6e84e` est à ≈ 1,3:1 sur carte blanche, sarcelle et cyan faibles en lignes fines : dérivés par thème pour ces teintes (§4.6.1) ; poignées de drag/resize discrètes |
| Assistant d'acquisition | `/acquisition` | `Steps` recoloré primaire ; cartes-radio de mode : bordure 2 px primaire à l'état choisi (choix propre, le template est à 1 px), rayon 3 px ; `BatchPipeline` sur les sémantiques Plus Admin ; modale d'indexation plein écran : panneau droit sur fond `#f8f9fb`, visionneuse inchangée fonctionnellement |
| Recherche & listes | `/search`, `/courriers/recherche`, toutes les files courriers (`controle`, `parapheur`, `suivi`, `validation`, `documents-scannes`) | Barre de recherche 36 px (§4.6 n°10) au rayon des champs, ses boutons à la même hauteur ; puces de filtres actifs en badges pilule ; `CountBadge` plein primaire ; tables **densité production** (§4.4) |
| Cycle de vie & communication | `/archives/dua-expirees`, `/archives/documents-epures`, `/archives/communiquer`, `/archives/documents-communiques`, `/archives/mes-documents-communiques`, `/archives/historique-communications` | Encart pédagogique de l'épuration en `Alert` sur les sémantiques dérivées AA ; barre d'action de sélection multiple (déclarer épuré, retours) collante ; parcours arbre → liste → formulaire de prêt en cartes plates ; badges d'état de prêt en badges pleins AA ; vues « consultation seule » avec état vide guidant |
| Formulaires courrier | `/courriers/enregistrement`, `/courriers/depart`, `/courriers/integration-decharge`, modale « Créer un expéditeur » | `FormSection` en blocs sur cartes plates ; **n° d'enregistrement en Geist Mono conservée** ; champs pré-remplis IA : `AiFilledTag` recoloré sur la nouvelle palette (dérivé AA) ; bouton d'extraction IA en bouton secondaire |
| Détail document / courrier | `/documents/[id]`, `MailDetailPage` | `Tabs` : encre primaire (dérivé éclairci en sombre) ; badge de niveau de droit en badge plein AA ; tiroir d'aperçu : en-tête sur fond `#f8f9fb` |
| Référentiels CRUD | `RefLayout`, `BulkRefPage`, `MailRefPage`, arbres | Édition en place : le crayon au survol passe en primaire ; lignes d'arbre : sélection `#1a55e3` à 8-10 % d'opacité en fond, texte primaire |
| Intercalaires | `/intercalaires` (l'écran, pas les PDF générés — §2.2) | Trois colonnes en cartes plates ; catégorie active : fond plein `#1a55e3` texte blanc (miroir de la sidebar) ; barre d'action collante : fond de surface + bordure haute `#e4e9f0` |
| Sécurité / admin | §5.6–5.7 de l'overview | Tables groupées : ligne de groupe sur fond `#f8f9fb` ; `Popconfirm` de retrait en danger (dérivé AA pour le texte) |
| Galerie design | `/design` | **Mise à jour intégrale** sur les tokens Plus Admin — sert de surface de vérification de la grille §4.2 et des signatures §4.5 (sinon elle documenterait la fausse identité) |
| Composants transverses | `PageHeader`, `EmptyState`, squelettes, `message`/`notification`, `Popconfirm`, `Tooltip`, `NotificationsBell`, `StatusBadge`, `editable.tsx` | Recolorés via tokens ; illustrations d'`EmptyState` re-teintées (primaire + gris Plus Admin) ; skeletons sur `#e4e9f0` |
| PdfViewer | partout | Barre d'outils sur fond de surface, boutons icône 4 px ; vignette active bordée/surlignée `#1a55e3` ; **couleur de surlignage des occurrences de recherche vérifiée AA sur les deux thèmes** ; zone de rendu neutre inchangée ; états vides et mode plein écran vérifiés en clair et en sombre |
| Documents générés | `packages/mailer`, `packages/exports` (exports recherche + fiche d'imputation) | E-mails : en-tête bleu roi, bouton `#0033c4` rayon 4 px, tableaux bordés `#e4e9f0` ; exports PDF/Word et fiche d'imputation : en-têtes et accents alignés (best-effort, §2.1) |

---

## 6. Passe UX — rendre l'expérience conviviale

À iso-fonctionnalités et iso-navigation. Chaque proposition ci-dessous est **auditée écran par
écran dans `ux-audit.md`** (constat → proposition applicable → coût) ; `plan.md` n'agrège que
les arbitrages (§8.1) :

1. **Hiérarchie de page systématique** — un seul motif : `PageHeader` (titre 600, fil
   d'Ariane, actions à droite — **sans sous-titre**, cf. §4.6 n°11) → contenu en cartes plates → barre
   d'action collante si nécessaire. Éliminer les variations d'espacement entre écrans
   (échelle unique : 8/16/24/28 px).
2. **Lisibilité des formulaires** — champs 36 px partout (§4.6 n°10), labels 14 px
   au-dessus, groupement en `FormSection` uniformisé ;
   largeur maximale de colonne de formulaire (~640 px) pour éviter les lignes trop longues.
3. **Feedback immédiat et cohérent** — conserver `message.success/error` systématiques, flash de
   ligne après création, gardes « modifications non enregistrées » ; harmoniser le wording des
   confirmations (`Popconfirm` toujours : verbe + objet + conséquence).
4. **Navigation plus claire** — sidebar : sections avec libellés 11 px/600 en capitales grises ;
   item actif rempli (repère fort) ; badges de compteurs en pilules danger/primaire selon
   l'urgence ; le bouton de repli de la top bar, dont le glyphe indique le sens de l'action
   (replier / déplier), rend le repli découvrable (l'affordance actuelle est faible).
5. **États vides guidants** — `EmptyState` : illustration re-teintée + titre court + bouton
   primaire (déjà le motif, à généraliser aux écrans qui affichent encore un vide brut). Le
   paragraphe explicatif a été retiré (§4.6 n°11) : le titre et le bouton portent le message.
6. **Densité différenciée** — la différenciation ne porte plus que sur les **tables** : les
   champs sont à 36 px partout (§4.6 n°10), et les **tables de production sont denses**
   (32-36 px de hauteur de ligne, mécanisme §4.4) : les écrans de production (files courriers,
   recherche) montrent plus de lignes à l'écran qu'aujourd'hui.
7. **Constance clair/sombre** — la top bar bleu roi constante donne un repère stable entre
   thèmes ; vérifier chaque écran dans les deux thèmes (le sombre Plus Admin est très sombre :
   `#111115`).
8. **Micro-interactions sobres** — conserver `motion.ts` (fade/fadeUp/stagger), transitions
   0.25 s sur sidebar/hover comme le template ; aucun mouvement décoratif nouveau ;
   `prefers-reduced-motion` inchangé.
9. **Accessibilité maintenue ou améliorée** — focus ring visible sur fond bleu roi (anneau
   blanc/cyan sur la top bar, via l'îlot de thème §4.4), `aria-*` existants conservés,
   contrastes AA vérifiés pour chaque token dérivé (§4.1), taille de cible ≥ 40 px sur les
   boutons icône.
10. **Raccourcis et palette** — ⌘K conservé ; ajouter l'apparence Plus Admin à la palette
    (rayon 5 px, ombre de popover) ; aucune nouvelle fonctionnalité.

---

## 7. Contraintes et garde-fous

1. **Aucune régression fonctionnelle** — critère d'acceptation bloquant. Les tests existants
   passent ; les parcours critiques (login → acquisition → indexation → recherche → export ;
   enregistrement courrier → imputation → validation → archivage) sont revérifiés visuellement.
2. **Theming par tokens uniquement** — toute couleur/rayon/ombre passe par `tokens.ts` →
   `antdTheme.ts` / `globals.css` (y compris l'îlot top bar, §4.4). Aucune valeur en dur dans
   les composants ; les classes Tailwind arbitraires (`bg-[#...]`) sont proscrites — dans
   `apps/web` **et `packages/ui`**.
3. **Pas de Bootstrap** — aucune dépendance ajoutée depuis le template ; les extraits CSS de la
   démo servent de **spécification**, jamais de code copié.
4. **SSR clair** — le mécanisme anti-mismatch d'hydratation est intouchable.
5. **Performance** — Open Sans en `next/font` (subset latin, `display: swap`) ; pas de
   régression Lighthouse/CLS mesurable ; les 4 graisses seulement (300/400/600/700).
6. **Contrastes** — audit AA de tous les couples texte/fond introduits (§4.1). En phase 1, les
   dérivés et leurs ratios sont consignés **exclusivement dans `design-tokens.md`** ; ils ne
   seront reportés en commentaire dans `tokens.ts` qu'en phase 2.
7. **Rondeur** — tout écart à la grille cible §4.2 non couvert par une dérogation §4.6 est un
   défaut à corriger, pas une licence créative.

---

## 8. Phasage imposé

### 8.1 Phase 1 — PLAN UNIQUEMENT (le présent mandat)

**Ne modifier aucun fichier de l'application.** Livrables attendus, consignés dans
`specs/002-relook/` :

1. `plan.md` — le plan d'exécution détaillé :
   - **Approches comparées** (au moins deux : p. ex. « bascule des tokens en un lot puis
     retouches par écran » vs « refonte progressive par section avec double thème temporaire »),
     avec recommandation argumentée (risque, réversibilité, durée) ;
   - Cartographie exhaustive des fichiers à toucher (theming, chrome, composants maison,
     `packages/ui`, écrans, documents générés), estimée par lot ;
   - Table de correspondance **token par token** : valeur actuelle → valeur Plus Admin →
     token AntD/variable CSS cible. **Périmètre de complétude : toutes les clés exportées de
     `tokens.ts` + tous les tokens par composant cités aux §4.2-4.4** (couleurs, rayons, typo,
     ombres, dimensions, îlot top bar, sort des variables de police §4.3) ;
   - Calcul des **dérivés de contraste** (§4.1) avec ratios : sémantiques texte clair/sombre,
     primaire sombre, bordure de contrôles sombre, `colorBgElevated`, teintes de graphiques ;
   - **Stratégie de densité** : valeur des `controlHeight`/`controlHeightSM`/`controlHeightLG`,
     inventaire des usages `size`/`componentSize`, liste des écrans par densité de table (§4.4) ;
   - Séquencement en lots livrables indépendamment, chacun avec critères d'acceptation et
     plan de vérification (deux thèmes, breakpoints `lg`/768/1600, reduced motion) ;
   - Matrice de risques et parades — au minimum : hydratation SSR, `cssVar` AntD (dont l'îlot
     top bar), dérive de densité via `controlHeight`, ombres/`colorBgElevated` en sombre,
     graphiques en sombre, e-mails/exports ;
   - Estimation de charge par lot, **exprimée en jours-homme** ;
   - **Dernière section : les points d'arbitrage** nécessitant une décision produit avant la
     phase 2.
2. `ux-audit.md` — audit UX écran par écran : **100 % des routes listées dans
   `docs/OVERVIEW-APPLICATION.md` §5, écrans masqués et `/design` inclus** ; pour chaque écran :
   constat → proposition §6 applicable → coût.
3. `design-tokens.md` — la spéc §4 recopiée et complétée des valeurs dérivées calculées avec
   leurs ratios.

**Critère de sortie de phase 1** : validation explicite du plan par le propriétaire du produit.

### 8.2 Phases suivantes (aperçu — hors mandat actuel)

- **Phase 2** : socle de theming (tokens, antdTheme, globals, fonts) + chrome (TopBar avec îlot
  de thème, sidebar, bouton de repli) — l'application entière change d'ambiance en un lot.
- **Phase 3** : composants maison + `packages/ui` + écrans par section (Docu-Archives →
  Docu-Courriers → paramétrages → admin), lot par lot.
- **Phase 4** : graphiques, documents générés (e-mails, exports, fiche d'imputation), états
  vides illustrés, galerie `/design`, audit final contrastes/rondeur, revue croisée et recette.

**Porte de validation entre chaque phase** : une phase se clôt par la vérification navigateur
double thème de ses critères d'acceptation et une validation du propriétaire du produit avant
d'ouvrir la suivante — la phase 2 (bascule du socle) est le moment le plus risqué du projet et
ne démarre qu'après validation du plan.

---

## 9. Critères d'acceptation globaux

1. Chaque valeur du §4 est retrouvable dans `tokens.ts`/`antdTheme.ts`/`globals.css` (revue par
   diff) ; aucune couleur/rayon hors tokens dans `apps/web` (`packages/ui` retiré du périmètre,
   arbitrage n°1 validé).
2. La grille de rondeur cible §4.2 est vérifiée visuellement sur : un formulaire, une table, une
   modale, un dropdown, un tooltip, un badge, un avatar, une pilule — et sur la galerie
   `/design` mise à jour.
3. Les éléments signatures (§4.5) sont présents et conformes en clair **et** en sombre —
   **6 depuis le retrait de la languette rose** (§4.6 n°8).
4. Aucun changement de route, d'endpoint, de texte métier, de comportement.
5. Parcours critiques revérifiés (§7, garde-fou n°1) ; tests existants au vert.
6. Audit AA : aucun texte sous 4,5:1 (texte normal) / 3:1 (grand texte et éléments non-texte,
   dont bordures de champs en sombre) ; focus visible partout, y compris sur la top bar.
7. Tout écart au template correspond à une dérogation listée en §4.6 — la revue distingue
   « écart voulu » et « défaut » sur cette seule base.
8. Le mode réduit de mouvement et le SSR clair fonctionnent comme avant.

---

## 10. Prompt à donner à Claude Code

> Copier-coller tel quel pour lancer la phase 1.
>
> **Archive** : la phase 1 est exécutée. Ce prompt est conservé tel qu'il a été donné et cite
> encore la languette `#ff0854`, retirée depuis (§4.6 n°8) — le §4 fait foi, pas ce bloc.

```text
Lis d'abord intégralement le PRD `relook.md` à la racine du projet, puis
`docs/OVERVIEW-APPLICATION.md` (cartographie de l'application) et les fichiers de theming
actuels : `apps/web/app/theme/tokens.ts`, `antdTheme.ts`, `charts.ts`, `motion.ts`,
`icons.tsx`, `apps/web/app/globals.css`, `apps/web/app/components/AuthShell.tsx`,
`TopBar`, `nav.ts`.

Mission de cette session : produire le PLAN de la refonte visuelle (« relook ») et UX de
DocuPro V6 sur le design du template Plus Admin de BootstrapDash, selon les spécifications
normatives du PRD — en particulier la grille de rondeur des bordures (§4.2 : champs 2 px,
cartes 3 px, modales 5 px, boutons/badges 4 px, dropdowns/tooltips 5 px, pilules 50 px,
avatars cercle), la palette et ses règles de contraste (§4.1, primaire #0033c4, top bar bleu
roi constante, dérivés AA à calculer), la typographie Open Sans (§4.3), le chrome (§4.4 :
sidebar blanche à item actif rempli #1a55e3, languette de repli #ff0854 de 48×60 px en pilule
gauche, cartes plates bordées #e4e9f0 sans ombre, mécanismes imposés pour la top bar, les
ombres et les densités), les dérogations assumées (§4.6) et la passe UX (§6).

PHASE ACTUELLE : PLAN UNIQUEMENT — AUCUNE IMPLÉMENTATION.
- Seules écritures autorisées : la création du dossier `specs/002-relook/` et des trois
  fichiers listés ci-dessous. Toute autre écriture est interdite — y compris `CLAUDE.md`,
  `docs/`, `package.json`, et tout fichier sous `apps/` ou `packages/`.
- N'utilise PAS le workflow speckit (speckit-plan/specify/tasks) : écris directement les
  trois fichiers demandés, sans créer de branche ni mettre à jour CLAUDE.md.
- En phase 1, les ratios de contraste calculés vont exclusivement dans `design-tokens.md` ;
  `tokens.ts` ne sera annoté qu'en phase 2.

Livrables (contenus détaillés au §8.1 du PRD) :
  1. `specs/002-relook/plan.md` : approches comparées (≥ 2) avec recommandation argumentée,
     cartographie des fichiers à toucher (dont packages/ui et les documents générés), table
     de correspondance token par token couvrant TOUTES les clés exportées de tokens.ts plus
     les tokens par composant des §4.2-4.4, dérivés de contraste AA calculés avec ratios,
     stratégie de densité (controlHeight/tailles/écrans par densité), séquencement en lots
     avec critères d'acceptation et plan de vérification (clair/sombre, breakpoints, reduced
     motion), matrice de risques, charges en jours-homme — et, en dernière section, les
     points d'arbitrage nécessitant une décision produit (rappelés aussi en fin de réponse) ;
  2. `specs/002-relook/ux-audit.md` : audit UX de 100 % des routes listées dans
     docs/OVERVIEW-APPLICATION.md §5, écrans masqués et /design inclus (constat →
     proposition §6 applicable → coût) ;
  3. `specs/002-relook/design-tokens.md` : la spéc design complète (§4) avec les valeurs
     dérivées calculées et leurs ratios.

Respecte les garde-fous du §7 : réinterprétation en Ant Design 5 + Tailwind (jamais d'import
Bootstrap), theming par tokens uniquement, SSR clair intouchable, aucune régression
fonctionnelle envisagée dans le plan.

Ton mandat s'arrête à la remise des trois livrables et de la liste d'arbitrages. La phase 2
fera l'objet d'un nouveau prompt après validation par le propriétaire du produit — ne
commence AUCUNE implémentation dans cette session, même si l'on t'indique que le plan est
validé.
```

---

## Annexe A — Relevé brut des tokens Plus Admin (source : CSS de la démo)

Valeurs **relevées** dans le CSS compilé ; les cibles DocuPro qui s'en écartent sont au §4.2
(colonne « Relevé ») et au §4.6. Ce relevé décrit le **template**, pas la cible : la languette
`#ff0854` de 48×60 px qui y figure n'est pas reprise par DocuPro (§4.6 n°8).

```text
Primaire            #0033c4      | Actif sidebar        #1a55e3
Secondaire          #a0a0a0      | Succès               #00d284
Info                #00cff4      | Warning              #ff5730
Danger              #ff0854      | Dégradé (sidebar-cta) #00cff4 → #0033c4 (to right)
Fond contenu clair  #f8f9fb      | Fond contenu sombre  #111115
Carte/sidebar clair #ffffff      | Carte/sidebar sombre #252529
Bordure clair       #e4e9f0      | Bordure carte sombre #111115
Texte corps         #030303      | Titre de carte       #313131
Texte secondaire    #76838f      | Texte navbar sombre  #8e94a9 (liens/icônes restent blancs)
Sidebar libellés N1 #141212 (clair) / #6a6b83 (sombre)
Sous-menu repos     #3e4b5b (clair) / #6a6b83 (sombre)
Sous-menu (item actif) #dfe2e8 · lien actif #ffffff
Thead custom-table  fond #f8f9fb (clair) / #1e1e20 (sombre), graisse 700

Rayons relevés : input 2px · carte 3px (rounded 5px) · bouton 4px · badge 4px (pill 10rem)
         · navbar-dropdown 5px · dropdown générique 6px · tooltip 6px · popover 8px
         · modale 8px · pilule 50px · avatar 100% · (ponctuels non repris : 15px, 20px)
Ombres : cartes AUCUNE (bordure 1px #e4e9f0) · douce 0 1px 15px 1px rgba(230,234,236,.35)
         · navbar-dropdown 0 3px 21px rgba(0,0,0,.2)
Typo   : Open Sans 300/400/600/700 · body 16px · paragraphes/tables 14px · inputs 13px
         · boutons 12px/600 · h1-h6 600 · card-title 16px/700 · badges 11px/600 · navbar 300
Layout : navbar 60px #0033c4 · toggler 48px de large × 60px de haut, #ff0854, pilule gauche
         · sidebar 260px · contenu padding 25px 27px · card-body 30px 28px
         · inputs padding 0.94rem 1.375rem (≈46px) · cellules table 14px padding 0.9375rem
         · boutons outline bordure 1px
```
