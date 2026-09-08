# Relook Plus Admin — Plan d'exécution (phase 1, livrable 1/3)

> Généré depuis le PRD `relook.md` (v1.1), l'audit du code réel (57 routes, 52 composants,
> chaîne de theming complète) et les calculs de contraste consignés dans
> [`design-tokens.md`](design-tokens.md). L'audit UX écran par écran est dans
> [`ux-audit.md`](ux-audit.md). **Aucun fichier de l'application n'a été modifié.**

---

## 1. Approches comparées

### Approche A — Bascule du socle en un lot, puis retouches par écran (recommandée)

Phase 2 remplace d'un coup la chaîne de theming (`tokens.ts` → `antdTheme.ts` →
`globals.css` + polices + chrome) : l'application entière change d'ambiance immédiatement,
puis les phases 3-4 corrigent écran par écran les valeurs en dur et appliquent la passe UX.

- **Pour** : le theming est déjà centralisé — la cartographie montre que la quasi-totalité des
  couleurs « en dur » des composants sont des *fallbacks* de variables (`var(--ant-color-primary,
  #1668c5)`) qui suivront automatiquement le re-token ; une seule identité visible à tout
  moment ; le levier maximal (≈ 80 % du rendu) est obtenu dès le premier lot ; la revue se fait
  contre une cible stable.
- **Contre** : fenêtre de risque « big-bang » visuelle — pendant les phases 3, quelques valeurs
  réellement figées (bandeaux héros, CountBadge, pdf-viewer.css, BatchPipeline) jureront avec la
  nouvelle ambiance jusqu'à leur lot.
- **Réversibilité** : élevée — un revert du seul lot 2.1 restaure l'identité complète.

### Approche B — Refonte progressive par section avec double thème temporaire

Les nouveaux tokens vivent derrière un second jeu de variables (`--da2-*` / flag `da-theme-v2`)
et chaque section bascule à son rythme.

- **Pour** : recette par petites surfaces, retour arrière par section.
- **Contre** : deux identités cohabitent en production (chrome bleu roi sur écrans ocre, ou
  l'inverse) — précisément l'effet « incohérent » que le relook veut éliminer ; le double jeu de
  tokens sous `cssVar: true` complexifie AntD (deux ConfigProvider ou thèmes commutés par
  zone) ; charge de QA doublée (4 combinaisons thème × version) ; durée totale supérieure.
- **Réversibilité** : granulaire mais au prix d'un état intermédiaire long.

### Recommandation : **Approche A**

Le facteur décisif est architectural : `tokens.ts` est déjà l'unique source de vérité et les
composants consomment des variables. Le coût marginal de B (double thème) n'achète presque
aucune sécurité supplémentaire, alors que la fenêtre de risque de A est fermée par : la galerie
`/design` refaite **dans le même lot** que le socle (surface de vérification immédiate), la
vérification navigateur double thème par lot, et la matrice de risques §9. L'ordre des lots de
phase 3 est choisi pour résorber au plus vite les valeurs figées les plus visibles (bandeaux
héros des deux tableaux de bord en tête).

---

## 2. Cartographie des fichiers à toucher

Relevé exhaustif (audit du code, 2026-08-07). Total estimé : **≈ 120-125 fichiers**, dont ~15
portent l'essentiel du restyle (chaîne de theming + chrome + patrons partagés).

| Zone | Fichiers | Contenu |
|---|---|---|
| Chaîne de theming (9) | `apps/web/app/theme/tokens.ts`, `antdTheme.ts`, `charts.ts`, `motion.ts` (conservé, vérif), `icons.tsx` (vérif), `apps/web/app/globals.css`, `apps/web/app/layout.tsx` (polices next/font — contient le script anti-ChunkLoadError à ne pas toucher), `apps/web/app/components/Providers.tsx` (point d'insertion de l'îlot top bar), `tailwind.config.ts` | Lot 2.1 |
| Chrome (5) | `AuthShell.tsx`, `TopBar.tsx`, `CommandPalette.tsx`, `NotificationsBell.tsx`, `nav.ts` (libellés/pictos seulement — clés intouchées) | Lot 2.2 |
| Patrons partagés (12) | `PageHeader`, `RefLayout`, `archives/BulkRefPage`, `mail/MailRefPage`, `mail/MailWorklist`, `mail/MailDetailPage` (+ `DeadlineAlert`, `tags.tsx`), `archives/LendingListPage`, `security/TypeSecurityPage`, `editable.tsx`, `EmptyState`, `skeletons.tsx`, `viewer/PdfViewer` + `pdf-viewer.css` | Lot 3.1 — rayonnent sur ≈ 35 écrans |
| Composants de contenu (≈ 20) | `KpiCard`, `StatTile`, `StatusTile`, `CountBadge` (#fff en dur), `StatusBadge`, `InfoCard`, `FormSection`/`AiFilledTag`, `BatchPipeline` (dégradé en dur), `MetaDataFields`/`MetaDataDisplay`, `BrandMark` (vérif), onglets documents (8 fichiers), `dashboard/GrilleWidgets`, `ModaleAjoutWidget`, `mail/MailViewer`, `FicheImputationModal`, `NewExternalEntity*Modal`, `feedback.ts` | Lots 3.2-3.4 |
| Pages (57 routes) | 3 hors chrome (`/`, `/admin` = redirections sans UI), 10 Docu-Archives, 14 Docu-Courriers, 14 Paramétrage Archives (dont 1 masqué), 9 Paramétrage Courrier (dont 3 masqués), 4 Sécurité, 3 Administration, `/login`, `/design` | Lots 3.2-3.5 (la majorité hérite des patrons) |
| Documents générés (5-6) | `packages/mailer/src/template.ts` (toutes les couleurs e-mail en dur : accents `#1d4ed8`/`#15803d`/`#b91c1c`, carte rayon 14 px), `brand.ts` (identité texte, sans couleur), `packages/exports/src/index.ts` (Excel : gras seul ; PDF : Helvetica sans couleur), `fiche-pdf.ts` (`#999` seul) — `docx-template.ts` : styles portés par le gabarit fichier, hors relook code | Lot 4.3 |
| `packages/ui` | `src/index.ts` ne contient que `export {};` — **coquille vide**, aucune primitive à relooker | Arbitrage n°1 (§10) |

Hors périmètre confirmé : `packages/pdf` (intercalaires générés), apps/api, worker, scan-agent.

---

## 3. Table de correspondance token par token

Couvre **toutes les clés exportées** de `tokens.ts` et les tokens par composant d'`antdTheme.ts`.
Ratios : voir `design-tokens.md` §3 (tous calculés).

### 3.1 `colors` (clair)

| Clé | Actuel | Cible | Note |
|---|---|---|---|
| `primary` | `#1668C5` | **`#0033c4`** | 9,25:1 sur blanc |
| `primaryHover` | `#2E7FDB` | **`#1a55e3`** | |
| `primaryActive` | `#0F5099` | **`#00279a`** | état pressé — assombrissement à teinte constante |
| **`menuActiveBg`** *(nouveau)* | — | **`#1a55e3`** | fond de l'item de menu actif (sidebar) et de la catégorie active intercalaires — consommé par `Menu.itemSelectedBg` |
| `primarySoft` | `#E6F0FB` | **`#e8eefc`** | 10 % de `#1a55e3` sur blanc ; texte primaire dessus 7,96:1 |
| `accent` / `accentStrong` / `accentSoft` / `accentBorder` | ocres | **supprimés** | consommateurs re-mappés : flash de ligne → `primarySoft`, encart vierge intercalaires → sémantiques, variables `--da-accent-*` retirées de `globals.css` |
| `bgLayout` | `#F6F7F6` | **`#f8f9fb`** | |
| `bgContainer` / `bgElevated` | `#FFFFFF` | `#ffffff` | inchangés |
| `bgSpotlight` | `#101413` | **`#313131`** | fond de Tooltip |
| `border` | `#E3E6E4` | **`#e4e9f0`** | cartes |
| `borderSecondary` | `#EDEFEE` | **`#eef1f6`** | séparateurs internes |
| **`borderControl`** *(nouveau)* | — | **`#8d95a5`** | bordure des champs, 3,01:1 sur blanc — remplace la convention « bordure primaire sur tous les champs » |
| `text` | `#101413` | **`#030303`** | |
| **`textStrong`** *(nouveau)* | — | **`#313131`** | titres de carte |
| `textSecondary` | `#5B635F` | **`#687480`** | dérivé AA du `#76838f` relevé (4,53:1) |
| `textTertiary` | `#8A918D` | **`#8f99a5`** | décoratif |
| `textQuaternary` | `#B6BBB8` | **`#b6bdc6`** | décoratif |
| `success` | `#2F7A4F` | **`#008453`** | fort AA — texte + fonds de badge |
| `successSoft` | `#E6F2EB` | **`#e0f7ec`** | teinté sur `#00d284` |
| `warning` | `#B7791F` | **`#dd2a00`** | fort AA |
| `warningSoft` | `#F8EFDD` | **`#ffeae4`** | |
| `danger` | `#C0392B` | **`#e50047`** | fort AA |
| `dangerSoft` | `#FBE9E7` | **`#ffe4ec`** | |
| `info` | `#1668C5` | **`#007e95`** | l'info Plus Admin est le cyan — fort AA (arbitrage n°2) |
| **`infoSoft`** *(nouveau)* | — | **`#dff5fa`** | fond discret teinté sur `#00cff4` (symétrique des trois `*Soft` existants) |
| **`secondary` / `secondaryStrong`** *(nouveaux)* | — | **`#a0a0a0`** / **`#737373`** | surfaces secondaires sans texte / fort AA (texte + fond de badge, 4,74:1 sur blanc) |
| **`successVivid` / `infoVivid` / `warningVivid` / `dangerVivid`** *(nouveaux)* | — | `#00d284` / `#00cff4` / `#ff5730` / `#ff0854` | surfaces sans texte uniquement (règle §4.1 du PRD) |
| `brandBgFrom` → `brandBgTo` | `#1668C5` → `#0F5099` | **`#00cff4` → `#0033c4`** | dégradé signature ; texte toujours sur la moitié bleue |
| `onBrand` | `#EAF1FB` | **`#ffffff`** | |
| `onBrandMuted` | `#BFD2EE` | **`#c9d7ff`** | |
| **`topbarBg` / `onTopbar` / `onTopbarMuted`** *(nouveaux)* | — | `#0033c4` / `#ffffff` / `#ffffff` | îlot top bar (§6 de design-tokens.md). *`topbarToggler` `#ff0854` a existé puis a été supprimé avec la languette — PRD §4.6 n°8* |
| **`theadBg`** *(nouveau)* | — | **`#f8f9fb`** | en-têtes de table |

### 3.2 `colorsDark`

| Clé | Actuel | Cible | Note |
|---|---|---|---|
| `primary` | `#4F9BE8` | **`#5a85ff`** | 4,53:1 sur `#252529` |
| `primaryHover` / `primaryActive` | | **`#7a9cff`** / **`#4a6fe0`** | dérivés |
| `primarySoft` | `#16263F` | **`#2c3247`** | sélection |
| `accent*` | ocres sombres | **supprimés** | |
| `bgLayout` | `#0A0E16` | **`#111115`** | |
| `bgContainer` | `#121823` | **`#252529`** | |
| `bgElevated` | `#161E2B` | **`#33333a`** | popups (l'ombre est invisible en sombre) |
| `bgSpotlight` | `#EAEEF6` | `#eaeef6` | conservé |
| `border` | `#262F3D` | **`#111115`** | « carte fondue » du template |
| `borderSecondary` | `#1C2433` | **`#2f2f36`** | séparateurs internes |
| **`borderControl`** | — | **`#70708a`** | 3,18:1 sur `#252529` |
| `text` | `#E6EAF2` | **`#dee2e6`** | |
| **`textStrong`** | — | **`#dee2e6`** | |
| `textSecondary` | `#9BA4B4` | **`#8e94a9`** | 5,06:1 |
| `textTertiary` / `textQuaternary` | | **`#757a8c`** / **`#52566a`** | décoratifs |
| `success` / `info` / `warning` | dérivés actuels | **`#00d284` / `#00cff4` / `#ff5730`** | les vifs passent l'AA en sombre (7,67 / 8,17 / 4,84:1) |
| `danger` | `#E06A5C` | **`#ff3d78`** | 4,50:1 |
| `*Soft` | | **`#0c2a1e` / `#0c2a30` / `#2f1a13` / `#2f141c`** | fonds discrets teintés |
| `*Vivid` | — | = valeurs vives (identiques) | |
| `brandBgFrom` → `brandBgTo` | `#123A66` → `#070C12` | **`#00829a` → `#00279a`** | assombrissement du dégradé signature — à valider visuellement en phase 2 |
| `onBrand` / `onBrandMuted` | | `#ffffff` / `#c9d7ff` | |
| `topbarBg` / `onTopbar` / `onTopbarMuted` | — | `#0033c4` / `#ffffff` / **`#b9c0d4`** | constants ; muted 5,09:1 |
| **`theadBg`** | — | **`#1e1e20`** | relevé `custom-table` sombre |

### 3.3 `radii`, `space`, `fontSize`, `fonts`, `motion`, `shadows`

| Export | Actuel | Cible |
|---|---|---|
| `radii` | `{sm:6, base:8, lg:12, xl:16, pill:999}` | **`{xs:2, sm:3, base:4, lg:5, field:8, card:12, pill:999}`** — l'ancienne echelle disparait ; `field`/`card` ajoutes le 2026-09-08 par l'assouplissement PRD §4.6 n°9 (champs et boutons 8 px, cartes/tuiles/alertes 12 px) |
| `space` | base 4 px (4→48) | **conservé** ; le padding de page passe à 25×27 px dans `.da-page` (valeur Plus Admin, tokenisée pour la barre collante des intercalaires) |
| `fontSize` | `{xs:12, sm:13, base:14, md:16, lg:20, xl:24, xxl:32}` | **conservé** (la dominante 14 correspond) — usages : boutons 12 (`xs`), champs 13 (`sm`), card-title 16 (`md`) |
| `fonts` | Geist Sans + Bricolage + Geist Mono | **Open Sans** (300/400/600/700, `--font-sans`) pour `sans` ET `display` (alias conservé) ; `mono` inchangé (Geist Mono) |
| `motion` | durées/courbes | **conservé intégralement** (§6.8 du PRD) |
| `shadows` | card/raised/popover/modal | **`{card: 'none', soft: '0 1px 15px 1px rgba(230,234,236,0.35)', popover: '0 3px 21px rgba(0,0,0,0.2)', modal: '0 3px 21px rgba(0,0,0,0.25)'}`** — voir mécanisme §9 (risque R4) |
| `tiles` / `tilesDark` / `statusTiles` / `statusTilesDark` | palette Atelier | re-basés Plus Admin — valeurs complètes (claires **et** sombres) dans `design-tokens.md` §10 ; `statusTiles` sur les sémantiques **fortes AA** |

### 3.4 Tokens AntD (`antdTheme.ts`)

| Token | Actuel | Cible |
|---|---|---|
| `token.borderRadius` / `SM` / `LG` | 8 / 6 / 12 | **4 / 2 / 5** |
| `token.controlHeight` / `SM` / `LG` | 36 / 28 / 44 | **36 / 28 / 46** (SM re-épinglé explicitement) |
| `token.fontSize`, `fontFamily` | 14, Geist | 14, **Open Sans** |
| `boxShadow` / `Secondary` / `Tertiary` | ombres douces | `modal` / **`0 3px 21px rgba(0,0,0,0.2)`** / retiré de Card uniquement |
| `colorPrimaryBorder` (focus) | `#9EC0EC` | dérivé du nouveau primaire (clair) / `primaryActive` (sombre) |
| `Button` | h36, w500, r8 | h36, **w600, `contentFontSize: 12`, r4**, shadows none |
| `Card` | rLG12, ombre, header 16 | **rLG3, sans ombre, header 16 + graisse 700 via CSS, body 30×28** (via `styles`/CSS ciblé — pas de token AntD de padding de body) |
| `Table` | headerBg layout, cellPaddingBlock 12, fwStrong 600 | **headerBg `theadBg`, `cellPaddingBlock: 15`, `cellPaddingBlockSM: 7`, fwStrong 700, headerBorderRadius 3** |
| `Input`/`InputNumber`/`Select`/`TreeSelect`/`DatePicker`/`Cascader`/`Mentions` | r8, `colorBorder: primary` | **r2 (+ `borderRadiusLG: 2`, `borderRadiusSM: 2`), `colorBorder: borderControl`, `Input.inputFontSize: 13`** — la bordure primaire systématique disparaît |
| `Tag` | rSM6, defaultBg layout | **rSM4, fontSize 11** |
| `Modal` | rLG12 | **rLG5** |
| `Menu` (sidebar) | itemBorderRadius 8, marges 8, selectedBg `primarySoft` | **itemBorderRadius 0, itemMarginInline 0, `itemSelectedBg: #1a55e3`, `itemSelectedColor: #fff`** (item rempli pleine largeur), groupTitle 11/600 |
| `Tabs` | inkBar primary | inchangé (nouveau primaire) |
| `Tooltip` | r6 | **r5** (`borderRadius`, pas LG) |
| `Popover` / `Collapse` / `Alert` / `Segmented` | r8 | **r5 / 4 / 4 / 4** |
| `Badge` | rSM6 | **rSM4** |
| `Layout` | headerBg container | **headerBg : îlot top bar** (`topbarBg` via variables, cf. R5), siderBg container, headerHeight 60 |
| `Dropdown` *(nouveau)* | — | `borderRadiusLG: 5` |
| `Avatar` | défauts | forme **cercle** systématique (grille §4.2) |
| `Form` *(nouveau)* | défauts | `labelFontSize: 14`, espace label→champ 8 px (§4.3) |

### 3.5 `globals.css` et `charts.ts`

- `--da-accent-*` : supprimées (consommateurs re-mappés) ; `--da-brand-*` : dégradé signature ;
  `--da-shadow-*` : nouvelles valeurs §3.3 ; `--da-grid-line` : re-teintée sur `#0033c4` ;
  nouvelles : `--da-topbar-*`, `--da-radius-pill`.
- `body` : Open Sans ; `.da-display` : alias (aucun consommateur modifié) ; `da-row-flash` :
  `primarySoft` au lieu de l'ocre ; focus ring : nouveau primaire + variante blanche top bar.
- `charts.ts` : `CATEGORICAL_LIGHT`/`DARK` remplacées par les palettes corrigées de
  `design-tokens.md` §7 (ordre préservant « rouge/vert non adjacents ») ; `primary` `#0033c4`/`#5a85ff`.

---

## 4. Dérivés de contraste

Tous calculés — voir `design-tokens.md` §3 (sémantiques fortes, primaire sombre, bordures de
contrôles, chrome/top bar) et §7 (graphiques). Rappel des conclusions structurantes :

1. Aucune sémantique vive Plus Admin ne peut porter de texte en clair → doublet vif/fort par
   sémantique (`*Vivid` pour les surfaces, valeur AA par défaut pour `colorSuccess/Warning/Error`).
2. `#0033c4` est réservé à la top bar en sombre ; le primaire sombre est `#5a85ff`.
3. Bordures de contrôles : `#8d95a5` (clair) / `#70708a` (sombre) — WCAG 1.4.11.
4. 9 des 20 teintes de graphiques nécessitent un dérivé par thème.

---

## 5. Stratégie de densité (recensement exhaustif)

Constat clé : **les 42 `<Table>` de l'app ont toutes un `size` explicite** (aucun héritage
implicite) et **`componentSize` n'est utilisé nulle part** — la bascule est donc entièrement
pilotable, sans surprise.

### 5.1 Tokens

`controlHeight: 36` (inchangé — pilote toutes les commandes), `controlHeightSM: 28`
ré-épinglé, `controlHeightLG: 46` défini.

> **Amendement du 2026-09-08 (PRD §4.6 n°10)** : le gabarit 46 px est **abandonné**. Tous les
> champs et boutons de l'application sont à 36 px, sans exception — `/login` et la palette
> Ctrl+K comprises. `controlHeightLG: 46` reste défini mais n'est consommé par aucune surface.
> Le §5.4 ci-dessous ne décrit donc plus l'état cible : il est conservé comme trace du
> recensement, et l'ensemble de sa colonne « Mécanisme » a été retiré du code.

### 5.2 Tables « production » (`size="small"`, `cellPaddingBlockSM: 7` → lignes 32-36 px)

Files courriers (`MailWorklist` — contrôle/parapheur/suivi/validation), `/search`,
`/courriers/recherche`, `/courriers/documents-scannes`, `/archives/dua-expirees`,
`/archives/communiquer` (table de sélection), `LendingListPage` (documents-communiqués — cf.
arbitrage n°3 pour l'historique), `/acquisition` (table du lot + « Documents du lot » déjà
small), `/admin/courriers/entites-externes` (annuaire volumineux), widgets de tableaux de bord
(déjà small).

### 5.3 Tables « consultation » (`middle`, `cellPaddingBlock: 15`)

Tous les référentiels (RefLayout/BulkRefPage/MailRefPage), `/admin/users`, `/admin/roles`,
TypeSecurityPage et metadonnees-types (tables externes ; les internes imbriquées restent
small), `/archives/documents-epures`, `/archives/historique-communications` (écran type),
onglets de `/documents/[id]` (cf. arbitrage n°4).

### 5.4 Formulaires pleine page (9 écrans) — ~~mécanisme `large`~~, **caduc depuis §4.6 n°10**

| Écran | Mécanisme | Précaution |
|---|---|---|
| /courriers/enregistrement | `size="large"` sur le Form (l.377) | épingler `middle` sur le bouton « + » expéditeur (l.479) et « Sélectionner un PDF » (l.555) |
| /courriers/depart | Form l.154 | « Parcourir » (l.261) à épingler ; « Retirer » déjà small |
| /courriers/integration-decharge | Form l.99 | « Parcourir » (l.135) |
| /acquisition (étapes 1-2) | `ConfigProvider componentSize="large"` **autour du contenu de la Card wizard seulement** (l.844-1067) | le `Steps size="small"` (l.836) et la modale d'indexation restent hors périmètre |
| /archives/communiquer | ConfigProvider sur le contenu de la carte « Communication » ; TreeSelect gauche en `size="large"` **explicite seul** | ne jamais envelopper la carte gauche (table + pagination) |
| /admin/archives/cycles-de-vie | ConfigProvider sur la carte formulaire (l.240-314) | la carte des règles (toolbar + table) reste hors |
| /admin/parametres/email | Form l.140 | boutons Logo (l.209-212) à épingler ou carte Logo sortie du Form ; « Enregistrer » est dans PageHeader, hors Form — voulu |
| /login | ~~`size="large"`~~ retiré (§4.6 n°10) | champs au gabarit commun 36 px |
| Modale « Créer un expéditeur » | ConfigProvider sur le Space (l.80-116) | footer Modal hors children, non affecté |

### 5.5 Effets de bord recensés

~~`controlHeightLG: 46` grossit les `size="large"` déjà présents : barre `/search`, filtres
`/courriers/recherche`, « Générer » intercalaires, « Lancer le traitement » acquisition.~~
Caduc (§4.6 n°10) : tous ces `size="large"` ont été retirés, CommandPalette et `/login`
compris.
`controlHeightSM: 28` re-épinglé impacte `editable.tsx`, `MetaDataFields small` (modale
d'indexation) et les toolbars PdfViewer — vérification de saisie dense au lot 3.5. Pagination
des tables small : vérifier la cible tactile ≥ 40 px (§6.9). Toute table de production oubliée
en `middle` deviendra involontairement aérée (padding 15) : la liste §5.2 est le contrat.

---

## 6. Séquencement en lots

Chaque lot se termine par : vérification navigateur **clair + sombre**, breakpoints `lg` /
768 / 1600 px, `prefers-reduced-motion`, et non-régression des parcours critiques quand le lot
touche leur chemin. Un lot = livrable indépendamment.

| Lot | Contenu | Critères d'acceptation propres |
|---|---|---|
| **2.1 Socle** | tokens.ts, antdTheme.ts, globals.css, layout.tsx (Open Sans), charts.ts, tailwind.config | Toutes les valeurs de `design-tokens.md` retrouvables par diff ; `/login` conforme (§9.2 partiel) ; aucune régression d'hydratation SSR ; Lighthouse/CLS stables |
| **2.2 Chrome** | AuthShell (sidebar 260, item rempli, drawer 260, icône par section pour le rail replié, écran d'attente), TopBar (îlot + bouton de repli discret — la languette rose a été retirée, PRD §4.6 n°8), CommandPalette, NotificationsBell | Les signatures §4.5.1 et 3 visibles ; focus ring blanc sur top bar ; badges/menus/accordéon/menuKeys inchangés fonctionnellement |
| **2.3 Galerie** | `/design` refaite en surface de vérification | Grille §4.2 complète + les 6 signatures §4.5 restantes + 2 densités de tables démontrées |
| **3.1 Patrons** | les 12 patrons partagés (§2) | Un écran vitrine par patron recetté (document-types pour RefLayout, sorts-finaux pour BulkRefPage, controle pour MailWorklist…) ; a11y de `editable` (focusable) |
| **3.2 Docu-Archives** | dashboards (bandeau + widgets), acquisition, search, détail document + 8 onglets, 6 écrans cycle de vie, intercalaires | Plus aucune valeur figée de l'ancienne identité (grep hex) ; barres collantes en place ; EmptyState partout |
| **3.3 Docu-Courriers** | tableau de bord (bandeau + 9 widgets), enregistrement, depart, integration-decharge, files + fiches, recherche, documents-scannes, validation (barre collante) | Formulaires en large avec épinglages §5.4 ; badges/tags sur sémantiques AA |
| **3.4 Paramétrages + Sécurité + Admin** | 14 + 9 + 4 + 3 écrans (majoritairement hérités des patrons), TypeSecurityPage, users/roles/email | Écrans masqués avec breadcrumb ; confirmations complétées (conséquences) |
| **3.5 Densité** | passe transverse tables/formulaires selon §5.2-5.4 | Chaque table de la liste §5.2 en small ; les 9 formulaires en large avec leurs épinglages ; cibles tactiles ≥ 40 px vérifiées |
| **4.1 Graphiques** | palettes corrigées, vérification des 9 widgets courriers + widgets archives dans les deux thèmes | Aucune série < 3:1 sur sa surface |
| **4.2 PdfViewer** | pdf-viewer.css tokenisé, surlignages AA, vignette active | Ratios des surlignages consignés ; sombre vérifié |
| **4.3 Documents générés** | mailer/template.ts, exports (en-têtes PDF/Excel, fiche d'imputation) | Rendu e-mail vérifié sur gabarit ; best-effort assumé |
| **4.4 Recette finale** | audit AA global, grep « aucun hex hors tokens », revue des dérogations §4.6, parcours critiques complets | Critères §9 du PRD tous verts |

**Portes de validation** : fin de phase 2 (l'ambiance a basculé), fin de phase 3, fin de
phase 4 — vérification double thème + validation du propriétaire du produit avant d'ouvrir la
phase suivante (PRD §8.2).

---

## 7. Estimation de charge (jours-homme)

| Lot | Charge | Commentaire |
|---|---|---|
| 2.1 Socle | 1,5 j | mécanique mais à fort rayon — vérification double thème incluse |
| 2.2 Chrome | 2,5 j | îlot top bar + bouton de repli + sidebar = le travail neuf le plus dense |
| 2.3 Galerie | 1 j | |
| 3.1 Patrons | 2,5 j | 12 fichiers, mutualisation maximale |
| 3.2 Docu-Archives | 2 j | acquisition (L) + dashboards |
| 3.3 Docu-Courriers | 2 j | 2 formulaires à restructurer (depart), barre collante validation |
| 3.4 Param. + Sécurité + Admin | 1,5 j | majoritairement hérité |
| 3.5 Densité | 1 j | listes contractuelles §5 |
| 4.1 Graphiques | 1 j | |
| 4.2 PdfViewer | 0,5 j | |
| 4.3 Documents générés | 1 j | mailer surtout |
| 4.4 Recette finale | 1,5 j | |
| **Total** | **≈ 18 j** | hors arbitrages produits et aléas (buffer conseillé : +20 %) |

---

## 8. Matrice de risques

| # | Risque | Impact | Parade |
|---|---|---|---|
| R1 | Mismatch d'hydratation SSR (thème, polices) | Écran blanc / flash | SSR clair intouchable (§7.4 PRD) ; Open Sans via next/font avec `display: swap` ; recette du lot 2.1 dédiée |
| R2 | Dérive de densité via `controlHeight`/SizeContext | Toolbars géantes, pagination grossie | `controlHeight` inchangé (36) ; large scopé au plus près (§5.4, épinglages listés ligne par ligne) ; `controlHeightSM` ré-épinglé |
| R3 | Îlot top bar sous `cssVar: true` | Styles AntD « fond clair » sur fond bleu | Tokens dédiés `--da-topbar-*` consommés par TopBar (pas de second ConfigProvider de thème) ; popovers portalés sous le thème ambiant ; à défaut, ConfigProvider imbriqué avec sa **propre clé cssVar** |
| R4 | Zéroïsation des ombres cassant Modal/Drawer/popups | Surfaces flottantes illisibles | Retrait ciblé (usages CSS + Card) — jamais les tokens globaux ; `bgElevated #33333a` en sombre |
| R5 | Sombre : bordures/popovers invisibles | Champs sans limite perceptible | `borderControl #70708a` (3,18:1) ; `bgElevated` distinct ; critère §9.6 |
| R6 | Graphiques illisibles (jaune 1,27:1 en clair) | Widgets muets | Palettes corrigées par thème (calculées) ; lot 4.1 dédié |
| R7 | Valeurs figées oubliées (fallbacks OK, mais CountBadge, pdf-viewer.css, BatchPipeline, bandeaux) | Ancienne identité résiduelle | Grep hex systématique en recette de chaque lot ; liste des vrais figés déjà établie (§2) |
| R8 | E-mails : clients mail capricieux | Rendu dégradé | Best-effort assumé (§2.1 PRD) ; test sur gabarit réel |
| R9 | Régression fonctionnelle en retouchant les patrons | Files/référentiels cassés | Un écran vitrine recetté par patron avant propagation ; parcours critiques en fin de phase |
| R10 | Double serveur dev / Turbopack pendant les vérifications | Faux diagnostics | Garde `ensure-single-dev.mjs` respectée ; attacher la preview par `{url}`, jamais un second serveur |

---

## 9. Vérification (par lot et finale)

1. Navigateur : chaque écran du lot en clair **et** sombre ; `lg` (drawer), 768, 1600 px ;
   `prefers-reduced-motion` ; focus clavier sur les éléments retouchés.
2. Grep de recette : aucun hex/rgb hors `tokens.ts`/`globals.css`/`pdf-viewer.css` tokenisé ;
   aucune classe `bg-[#`.
3. Parcours critiques (PRD §7.1) : login → acquisition → indexation → recherche → export ;
   enregistrement → imputation → validation → archivage — en fin de phases 2, 3 et 4.
4. `/design` comme tableau de bord de conformité permanent (grille §4.2, signatures §4.5).

---

## 10. Points d'arbitrage (décisions produit avant phase 2)

1. **`packages/ui` est vide** (`export {};`) — le retirer du périmètre (recommandé) ou y
   déplacer des primitives en phase 3 ? Le critère §9.1 du PRD le cite ; à amender si retrait.
2. **Info = cyan** : `colorInfo` passe au cyan fort `#007e95` (fidélité Plus Admin) ou reste
   aligné sur le primaire (habitude actuelle) ? Recommandation : cyan.
3. **`LendingListPage`** sert 3 écrans : prop de densité (production pour les deux listes de
   travail, consultation pour l'historique — recommandé) ou densité unique ?
4. **Onglets de `/documents/[id]`** déjà en tables `small` : les assumer comme annexes
   compactes (dérogation à documenter — recommandé) ou remonter en `middle` aéré ?
5. **Colonne « Date butoir » masquée** dans les files Contrôle et Parapheur : la réafficher
   (le rendu existe, simple flag — recommandé pour la priorisation §6.4) ? Le masquage actuel
   est commenté comme voulu.
6. **Références de spéc « (§07) (§09) (§12) (§13) (§14) (§15) »** dans des textes visibles :
   les purger (texte d'aide UI, pas texte métier — à valider au titre du garde-fou §2.2).
7. **Motif « formulaire au-dessus »** de parametrage-types/cycles-de-vie : rallier
   PageHeader.actions ou l'officialiser comme second motif des écrans à formulaire large ?
8. **Lien métadonnées → éléments-listes** : rendre l'action de ligne (route et deep-link
   existants, iso-navigation) — le PRD fige la navigation, validation demandée.
9. **Libellé de menu « par profil »** vs titre « par rôle » : aligner le libellé UI (clé de
   route et menuKeys inchangées).
10. **Colonne « Bénéficiaire »** redondante sur /archives/mes-documents-communiques : masquer
    via prop du patron ?
11. **Collapse des filtres** (/search, /courriers/recherche) : replié par défaut quand aucun
    filtre n'est actif ?
12. **Input de la CommandPalette** : passé à 36 px comme le reste (§4.6 n°10) — le gabarit
    46 px ne survit nulle part.
13. **Aperçu A4 des intercalaires** : blanc/noir en dur conservé (simulacre d'impression) —
    dérogation à inscrire au §4.6 du PRD si validée.
14. **Micro-copies** : harmonisation « document(s) » des `showTotal`, casses de titres
    (« Gestion des Dossiers »), formTitle au singulier, désambiguïsation des deux écrans
    « Confidentialités » — textes UI à valider en bloc.
15. **Confirmations ajoutées** sur gestes de masse destructifs (validation courriers,
    « Remplacer la liste » métadonnées-types, « Appliquer » habilitations) — motif §6.3,
    iso-fonctionnalités, validation de principe.
16. **Toolbar PdfViewer** : cible tactile 40 px vs densité de la visionneuse — étendre la
    dérogation §4.6.5 aux toolbars d'outils ?
17. **Mini-aperçu du gabarit e-mail** dans /admin/parametres/email (phase 4, best-effort) :
    inclure ou différer ?
18. **Dégradé de marque sombre** (`#00829a → #00279a`) : valider visuellement au lot 2.1.
19. **Ordre des séries de graphiques** : les palettes corrigées (`design-tokens.md` §7) doivent
    être ré-ordonnées pour préserver la règle actuelle « rouge/vert non adjacents »
    (daltonisme) — proposer l'ordre au lot 4.1 et le valider.
