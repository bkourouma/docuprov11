# Relook Plus Admin — Spécification des tokens (phase 1, livrable 3/3)

> Source : PRD `relook.md` §4 (valeurs relevées dans le CSS compilé des démos
> `vertical-light` / `vertical-dark` de Plus Admin, BootstrapDash) — complétée ici des
> **valeurs dérivées calculées** (WCAG 2.1, luminance relative ; dérivation en HSL à teinte et
> saturation constantes, luminosité ajustée jusqu'au ratio cible). Tous les ratios annoncés
> sont calculés, pas estimés.
>
> Statut : document de planification — **aucune de ces valeurs n'est encore appliquée au code**.
> En phase 2, ces valeurs remplaceront le contenu de `apps/web/app/theme/tokens.ts` et les
> ratios seront reportés en commentaire (PRD §7.6).

---

## 1. Palette — thème clair

### 1.1 Valeurs normatives (relevé Plus Admin)

| Token cible (`tokens.ts`) | Valeur | Ratio utile | Usage |
|---|---|---|---|
| `primary` | `#0033c4` | 9,25:1 sur blanc (texte OK) | Actions, liens, top bar, états actifs |
| `menuActiveBg` | `#1a55e3` | blanc dessus : 6,08:1 (OK) | Fond de l'item de menu actif (sidebar), catégorie active intercalaires — token dédié ; `primaryHover` partage la valeur, `primaryActive` (état pressé) = `#00279a` |
| `primarySoft` | `#e8eefc` (10 % de `#1a55e3` sur blanc) | texte `#0033c4` dessus : 7,96:1 | Survol nav, sélection d'arbre, `rowHoverBg` |
| `secondary` | `#a0a0a0` | — (jamais porteur de texte) | Surfaces secondaires sans texte |
| `success` / `info` / `warning` / `danger` (vifs) | `#00d284` / `#00cff4` / `#ff5730` / `#ff0854` | — (jamais porteurs de texte, règle §4.1) | Pastilles, icônes, remplissages, bordures, progress |
| `bgLayout` | `#f8f9fb` | — | Fond de la zone de contenu |
| `bgContainer` | `#ffffff` | — | Cartes, sidebar, surfaces |
| `border` (cartes) | `#e4e9f0` | 1,22:1 (décoratif, assumé) | Bordures de cartes, séparateur sidebar |
| `text` | `#030303` | 20,62:1 sur blanc | Corps, titres |
| `textStrong` (titres de carte) | `#313131` | 13,01:1 sur blanc | `card-title`, texte fort |
| `textSecondary` | `#687480` (dérivé, cf. §3.1) | 4,53:1 sur `#f8f9fb` ; 4,77:1 sur blanc | Descriptions, sous-titres (le `#76838f` relevé échoue : 3,68:1) |
| Sidebar libellés N1 | `#141212` | 18,67:1 sur blanc | Items de menu au repos |
| Sidebar sous-menu | `#3e4b5b` | 8,89:1 sur blanc | Liens de sous-menu au repos |
| Dégradé signature | `linear-gradient(to right, #00cff4, #0033c4)` | texte blanc : vérifier sur la moitié claire (sur `#00cff4` seul : 1,87:1 → **texte toujours posé sur la moitié bleue** ou sur un voile assombrissant) | Bandeaux héros, panneau de marque login (extension §4.6.6) |

### 1.2 Palette étendue (graphiques, accents)

Relevé : bleu `#5e50f9`, indigo `#6610f2`, violet `#6a008a`, rose `#e91e63`, rouge `#f96868`,
orange `#f2a654`, jaune `#f6e84e`, vert `#46c35f`, sarcelle `#58d8a3`, cyan `#57c7d4`.
Corrections par thème au §5.

---

## 2. Palette — thème sombre

| Token cible | Valeur | Ratio utile | Note |
|---|---|---|---|
| `bgLayout` | `#111115` | — | Fond de contenu |
| `bgContainer` | `#252529` | — | Cartes, sidebar |
| `bgElevated` | `#33333a` (dérivé) | 1,22:1 vs carte (distinction de surface) | Popups/dropdowns — l'ombre étant invisible en sombre, la surface élevée se distingue par la valeur + bordure `borderSecondary` |
| `border` (cartes) | `#111115` | 1,23:1 (effet « carte fondue » du template, assumé) | Réservé aux cartes |
| `borderControl` | `#70708a` (dérivé, §3.4) | **3,18:1 sur `#252529`** (seuil non-texte OK) | Champs de saisie, obligatoire WCAG 1.4.11 |
| `primary` / `colorLink` | `#5a85ff` (dérivé, §3.3) | 4,53:1 sur `#252529` ; 5,59:1 sur `#111115` | Le `#0033c4` relevé échoue (2,04:1) — réservé à la top bar |
| Item actif sidebar | `#1a55e3` (conservé) | blanc dessus : 6,08:1 | Le fond actif garde la valeur template |
| `success` / `info` / `warning` (texte) | `#00d284` / `#00cff4` / `#ff5730` conservés | 7,67 / 8,17 / 4,84:1 sur `#252529` | Utilisables en texte en sombre |
| `danger` (texte) | `#ff3d78` (dérivé) | 4,5:1 sur `#252529` ; 5,55:1 sur `#111115` | Le `#ff0854` relevé échoue (3,3:1 environ sur carte) |
| `text` | `#dee2e6` (relevé Bootstrap dark) | ≥ 12:1 | Corps |
| `textSecondary` | `#8e94a9` (relevé) | 5,06:1 sur `#252529` | Descriptions — remplace aussi le `#6a6b83` des libellés sidebar qui échoue (2,94:1), cf. §3.5 |
| Thead de table | `#1e1e20` (relevé `custom-table` sombre) | — | Fond d'en-tête |
| Dégradé de marque sombre | `#00829a` → `#00279a` (dérivé) | — | Assombrissement du dégradé signature — à valider visuellement en phase 2 (lot 2.1) |
| Top bar | `#0033c4` **constante** | cf. §6 | Ne change pas en sombre |

---

## 3. Dérivés AA calculés (récapitulatif avec ratios)

### 3.1 Sémantiques « fortes » (un seul dérivé par sémantique : texte ET fond de badge)

Dérivées contre `#f8f9fb` (pire cas clair) → passent aussi sur blanc ; le blanc posé dessus
passe symétriquement (fonds de badge).

| Sémantique | Vif (surfaces) | **Fort AA (texte + fond de badge)** | Texte sur `#f8f9fb` / blanc | Blanc posé dessus |
|---|---|---|---|---|
| Succès | `#00d284` (blanc dessus : 1,99:1 ✗) | **`#008453`** | 4,50:1 / 4,75:1 | 4,75:1 |
| Info | `#00cff4` (1,87:1 ✗) | **`#007e95`** | 4,51:1 / 4,75:1 | 4,75:1 |
| Warning | `#ff5730` (3,15:1 ✗) | **`#dd2a00`** | 4,52:1 / 4,77:1 | 4,77:1 |
| Danger | `#ff0854` (3,88:1 ✗) | **`#e50047`** | 4,51:1 / 4,75:1 | 4,75:1 |
| Secondaire | `#a0a0a0` (2,61:1 ✗) | **`#737373`** | 4,50:1 / 4,74:1 | 4,74:1 |

Usage : `colorError`/`colorWarning`/`colorSuccess` d'AntD (messages de formulaire, alerts,
texte d'état) et fonds des badges/tags pleins à texte blanc. Les vifs restent pour pastilles,
icônes, remplissages sans texte (PRD §4.1).

### 3.2 Sémantiques sombres (texte sur `#252529` / `#111115`)

| Sémantique | Valeur | Ratio carte / fond |
|---|---|---|
| Succès | `#00d284` conservé | 7,67 / 9,46:1 |
| Info | `#00cff4` conservé | 8,17 / 10,07:1 |
| Warning | `#ff5730` conservé | 4,84 / 5,97:1 |
| Danger | **`#ff3d78`** | 4,50 / 5,55:1 |

### 3.3 Primaire sombre

| Token | Valeur | Ratio |
|---|---|---|
| `colorPrimary`/`colorLink` sombre | **`#5a85ff`** | 4,53:1 sur `#252529`, 5,59:1 sur `#111115` |
| Sélection primaire sombre (`primarySoft`) | **`#2c3247`** (14 % de `#5a85ff` sur `#252529`) | texte `#5a85ff` dessus : 3,77:1 (éléments UI, OK) |

### 3.4 Bordures de contrôles (WCAG 1.4.11, seuil 3:1)

| Thème | Valeur | Ratio sur la surface porteuse |
|---|---|---|
| Clair | **`#8d95a5`** | 3,01:1 sur blanc (2,86:1 sur `#f8f9fb` — les champs posés directement sur le fond de layout sont à éviter : toujours dans une carte) |
| Sombre | **`#70708a`** | 3,18:1 sur `#252529` (3,92:1 sur `#111115`) |

Note : la convention actuelle « bordure primaire sur tous les champs » disparaît (PRD §4.4) ;
c'est ce dérivé neutre qui la remplace.

### 3.5 Chrome

| Élément | Valeur | Ratio |
|---|---|---|
| Libellés sidebar sombre | **`#8e94a9`** (au lieu du `#6a6b83` relevé, 2,94:1 ✗) | 5,06:1 sur `#252529` |
| Top bar : liens/icônes (2 thèmes) | `#ffffff` | 9,25:1 sur `#0033c4` |
| Top bar : texte non interactif clair | `#ffffff` | 9,25:1 |
| Top bar : texte non interactif sombre | **`#b9c0d4`** (au lieu du `#8e94a9` relevé, 3,06:1 ✗ en texte) | 5,09:1 sur `#0033c4` |
| Focus ring sur top bar | `#ffffff` | 9,25:1 (seuil non-texte 3:1 largement passé) |
| Bouton de repli : icône blanche sur `#0033c4` (survol `rgba(255,255,255,.14)`) | `#ffffff` | 9,25:1 — *(remplace la languette `#ff0854` du relevé, retirée : PRD §4.6 n°8)* |

---

## 4. Rondeur des bordures — grille cible et mapping AntD (PRD §4.2)

| Élément | Rayon | Tokens AntD |
|---|---|---|
| Base globale | 4 px | `token.borderRadius: 4`, `borderRadiusSM: 2`, `borderRadiusLG: 5` |
| Champs (toutes tailles) | ~~2 px~~ **8 px** (`radii.field`, PRD §4.6 n°9) | `Input/InputNumber/Select/TreeSelect/DatePicker/Cascader/Mentions` : `borderRadius`, `borderRadiusLG` et `borderRadiusSM` a `radii.field` |
| Cartes, tuiles, bandeaux heros, panneaux encartes | ~~3 px~~ **12 px** (`radii.card`) | `Card.borderRadiusLG: radii.card` ; les surfaces dessinees a la main consomment le meme token |
| Modales | ~~5 px~~ **12 px** (`radii.card`, PRD §4.6 n°9) | `Modal.borderRadiusLG: radii.card` |
| Boutons | ~~4 px~~ **8 px** (`radii.field`) | `Button.borderRadius/LG/SM: radii.field` |
| Bandeaux d'alerte (`Alert`) | ~~4 px~~ **12 px** (`radii.card`) | `Alert.borderRadiusLG: radii.card` |
| Badges / Tags | **4 px** (inchange) | `Tag.borderRadiusSM: 4`, `Badge.borderRadiusSM: 4` |
| Dropdown / Popover / toasts / notifications / zone de depot | ~~5 px~~ **12 px** (`radii.card`) | `Dropdown/Popover/Message/Notification/Upload` : `borderRadiusLG: radii.card` |
| Popups d'un champ (panneau Select, calendrier DatePicker) | **8 px** (`radii.field`) | herite du `borderRadiusLG` du champ : le panneau reste solidaire de son champ |
| Tooltip | ~~5 px~~ **12 px** (`radii.card`) | `Tooltip.borderRadius: radii.card` — Tooltip consomme le rayon de BASE, pas `borderRadiusLG` |
| Pilules (badges pilule) | 50 px / `9999` | utilitaire CSS `--da-radius-pill` |
| Avatars, pastilles | cercle | `Avatar` shape circle |

`radii` dans `tokens.ts` : `{ xs: 2, sm: 3, base: 4, lg: 5, field: 8, card: 12, pill: 999 }`.
`xs`/`sm` ne servent plus qu'a de rares marques (barres de graphique, feuille A4 des
intercalaires) : depuis l'assouplissement du 2026-09-08, les champs consomment `field` et les
cartes `card`. Depuis le second temps de l'assouplissement, `lg` (5 px) n'est plus consomme par aucune
surface : modales, popups et infobulles sont tous sur `card`. Badges et en-tetes de table
restent sur `base`/`sm`.

---

## 5. Typographie (PRD §4.3)

| Élément | Valeur | Token / mécanisme |
|---|---|---|
| Famille | Open Sans 300/400/600/700 | `next/font/google` dans `layout.tsx`, variable `--font-sans` ; `fonts.sans` et `fonts.display` de `tokens.ts` pointent dessus ; `--font-display` conservée en **alias** (aucun consommateur `.da-display` à modifier) ; `--font-geist-mono` seule survivante des Geist |
| Corps AntD | 14 px | `token.fontSize: 14` (dominante du template ; body template = 16 px) |
| Champs | 13 px | `Input.inputFontSize: 13` (+ équivalents Select/Picker si rendu incohérent) |
| Boutons | 12 px / 600 | `Button.contentFontSize: 12`, `Button.fontWeight: 600` |
| Titres h1-h3 | 600 | `fontSizeHeading1/2/3` conservés (32/24/20), graisse via `titleFontWeight`/CSS |
| Titre de carte | 16 px / 700 / `#313131` | `Card.headerFontSize: 16` + graisse CSS ; **pas de `text-transform: capitalize`** (dérogation §4.6.3) |
| Badges | 11 px / 600 | `Tag` : fontSize 11 |
| Labels de formulaire | 14 px, `margin-bottom: 0.5rem` (8 px) | `Form` : `labelFontSize: 14`, espace label→champ 8 px |
| Top bar | Open Sans 300 | style TopBar |
| Palette de graphiques — libellés | inchangé (`label` de `charts.ts` re-mappé) | cf. §7 |

---

## 6. Îlot top bar (PRD §4.4 — mécanisme sans valeurs en dur)

Nouveaux tokens dans `tokens.ts`, exposés en variables CSS par `globals.css` :

```
topbarBg:        #0033c4   (identique clair/sombre)
onTopbar:        #ffffff   (liens, icônes, titre en clair)
onTopbarMuted:   clair #ffffff · sombre #b9c0d4
focus ring topbar: #ffffff
```

Pas de token `topbarToggler` : la languette rose `#ff0854` du relevé a été retirée (PRD §4.6
n°8). Le bouton de repli est un `Button type="text"` ordinaire de la top bar — il hérite de
`onTopbar` et du survol `rgba(255,255,255,.14)` de l'îlot, sans couleur propre.

Les popovers portalés (notifications, menu utilisateur, palette) restent sous le thème ambiant
(`bgElevated` + `boxShadowSecondary`).

---

## 7. Palette de graphiques (`charts.ts`) — corrections par thème

Cible : chaque série ≥ 3:1 (seuil éléments graphiques) sur la surface de carte de son thème.
« ✗ » = valeur brute non conforme, remplacée par le dérivé.

| Série | Clair (sur blanc) | Sombre (sur `#252529`) |
|---|---|---|
| bleu | `#5e50f9` (5,26:1) | **`#6254f9`** (3,02:1 ; brut 2,9 ✗) |
| indigo | `#6610f2` (7,19:1) | **`#8743f5`** (3,02:1 ; brut 2,12 ✗) |
| violet | `#6a008a` (10,61:1) | **`#b400ea`** (3,0:1 ; brut 1,44 ✗) |
| rose | `#e91e63` (4,35:1) | `#e91e63` (3,51:1) |
| rouge | **`#f96363`** (3,0:1 ; brut 2,91 ✗) | `#f96868` (5,24:1) |
| orange | **`#de7c11`** (3,0:1 ; brut 2,03 ✗) | `#f2a654` (7,53:1) |
| jaune | **`#a39608`** (3,03:1 ; brut 1,27 ✗) | `#f6e84e` (12,05:1) |
| vert | **`#37a94e`** (3,02:1 ; brut 2,27 ✗) | `#46c35f` (6,71:1) |
| sarcelle | **`#27a873`** (3,03:1 ; brut 1,78 ✗) | `#58d8a3` (8,56:1) |
| cyan | **`#2da3b1`** (3,01:1 ; brut 2 ✗) | `#57c7d4` (7,65:1) |

`primary` de graphique : `#0033c4` (clair) / `#5a85ff` (sombre). Grille : conserver le principe
`rgba` discret en re-teintant sur le primaire Plus Admin. La contrainte « mêmes couleurs dans
les deux thèmes » est abandonnée pour les teintes corrigées (dérogation §4.6.1, décision déjà
actée pour la palette actuelle qui a aussi deux variantes).

Ordre des séries : conserver la règle actuelle « rouge/vert non adjacents » (daltonisme) lors
du re-mapping — l'ordre exact est un point d'arbitrage de `plan.md`.

---

## 8. Ombres (PRD §4.4 — mécanisme)

| Token | Valeur cible | Note |
|---|---|---|
| Cartes | **aucune ombre** | Retrait des usages `--da-shadow-card` / `-raised` dans `globals.css` et de `Card.boxShadowTertiary` — pas de zéroïsation des tokens globaux |
| `boxShadowSecondary` (popups) | `0 3px 21px rgba(0,0,0,0.2)` | Dropdown/Select/Popover |
| `boxShadow` (Modal/Drawer) | conservé (valeur actuelle ou `0 3px 21px rgba(0,0,0,0.25)`) | Les composants AntD en dépendent |
| Ombre douce résiduelle | `0 1px 15px 1px rgba(230,234,236,0.35)` | Rares éléments flottants clairs (barres collantes) |
| Sombre | distinction par `bgElevated #33333a` + bordure | l'ombre est invisible sur `#111115` |

---

## 9. Dimensions & densités (PRD §4.4)

| Élément | Valeur |
|---|---|
| Top bar | 60 px (`Layout.headerHeight: 60` déjà en place) |
| Sidebar | 260 px (déplié) / repli icônes ; drawer mobile 260 px |
| Contenu | padding 25×27 px (`.da-page`) |
| `card-body` | 30×28 px (`Card` paddings) |
| `controlHeight` | **36 conservé** ; `controlHeightSM: 28` repinné ; `controlHeightLG: 46` defini mais **plus consomme nulle part** |
| Champs et boutons | **densite UNIQUE a 36 px** (PRD §4.6 n°10, 2026-09-08) : plus aucun `componentSize`/`size="large"`, `/login` et la palette Ctrl+K comprises |
| Tables production | `size="small"` + `Table.cellPaddingBlockSM: 7` → lignes ≈ 32-36 px |
| Tables consultation | `Table.cellPaddingBlock: 15` (padding du template) |
| Thead | graisse 700, fond `#f8f9fb` / `#1e1e20`, sans bordure haute |
| Boutons outline | bordure 1 px |

---

## 10. Tuiles décoratives et de statut (`tiles` / `statusTiles`)

Le motif des tuiles (`StatTile`, `StatusTile`) est conservé, re-basé sur la palette Plus Admin :

- `tiles.ink` : dégradé `#0033c4 → #001f77` (marque), fg blanc.
- `tiles.sky` : `#e8eefc → #d4e0fa`, fg `#0033c4`.
- `tiles.violet` : `#6a008a → #4a0061`, fg blanc.
- `tiles.coral` : `#ff5730 → #c93a1a`, fg blanc — distinct du danger `#ff0854`.
- `statusTiles.*` : dégradés construits sur les sémantiques **fortes AA** (§3.1) → texte blanc
  conforme : success `#008453 → #00522f`, warning `#dd2a00 → #8f1b00`, danger
  `#e50047 → #8f002c`, info `#0033c4 → #001f77` (fg `#ffffff`, muted = teinte claire du ton).
- Variantes sombres (proposées, vérification visuelle au lot 2.1) :
  - `tilesDark.ink` : `#1a55e3 → #001f77`, fg `#eaf1fb`, muted `#9fb7e8` ;
  - `tilesDark.sky` : `#2c3247 → #1e2333`, fg `#c9d7ff`, muted `#8fa3d9` ;
  - `tilesDark.violet` : `#4a0061 → #2e003d`, fg `#f0d9fa`, muted `#c98fe0` ;
  - `tilesDark.coral` : `#b3401f → #7a2a12`, fg `#ffe4da`, muted `#f0a98c` ;
  - `statusTilesDark` : success `#00663f → #003d26` (fg `#dff3e9`, muted `#66cfa4`), warning
    `#a82000 → #5e1200` (fg `#ffe4dc`, muted `#ff9c7d`), danger `#ad0036 → #5e001d`
    (fg `#ffdae6`, muted `#ff7da6`), info `#1a55e3 → #001f77` (fg `#eaf1fb`, muted `#9fb7e8`).

---

## 11. Ce qui est volontairement hors AA (assumé, PRD §4.6)

- Bordure de carte claire `#e4e9f0` (1,22:1) et sombre `#111115` (1,23:1) : décoratives, la
  séparation est portée par le contraste de fond carte/layout — conforme (1.4.11 ne s'applique
  pas aux séparateurs purement décoratifs).
- Ombres quasi nulles : la hiérarchie est portée par bordures + fonds.
- `#8e94a9` texte non interactif top bar sombre du template : remplacé (§3.5), pas assumé.
