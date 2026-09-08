# Audit mobile — DocuPro V6

> Établi le 2026-09-08 par **mesure dans un navigateur** (pas par lecture de code) sur les
> 57 routes `apps/web/app/**/page.tsx`, à 360 px, 390 px et 768 px, plus un contrôle à 320 px.
> Serveur de dev `http://localhost:5000` (Next 15 + Turbopack), API `:3001`, compte `admin`.
> Routes dynamiques ouvertes sur des enregistrements réels : document `149`,
> courriers `1244` (contrôle / recherche), `1236` (parapheur), `1247` (suivi).
>
> Documents connexes : [`OVERVIEW-APPLICATION.md`](OVERVIEW-APPLICATION.md),
> [`../relook.md`](../relook.md), [`MOBILE-CORRECTIONS.md`](MOBILE-CORRECTIONS.md) *(phase 2)*.

---

## 0. Protocole de mesure et un piège majeur

### 0.1 La mesure

Sur chaque route, à chaque largeur, après navigation réelle (rechargement complet, pas de
redimensionnement à chaud), un script mesure dans la page :

- `document.documentElement.scrollWidth > clientWidth + 1` → **débordement de page** (critère
  binaire de réussite/échec) ;
- les éléments dont le bord droit dépasse le viewport, **en excluant ceux qui sont dans un
  conteneur à défilement horizontal légitime** (sinon chaque tableau défilable produit 200 faux
  coupables) ;
- pour chaque `.ant-table` : largeur du tableau, largeur disponible, et l'état réel —
  `ok` / `defilable` / `TRONQUE` (clippé sans défilement) / `DEBORDE` (pousse la page) ;
- cibles tactiles < 44 px, textes < 12 px, champs de saisie < 16 px (zoom iOS),
  éléments `position: fixed`, largeur des modales/tiroirs ouverts.

**Les captures d'écran de cet outillage ne sont PAS une preuve.** Vérifié en plaçant des repères
de position à gauche, au milieu et à droite du viewport : sous viewport émulé, la capture
**répète le viewport en mosaïque**. Ce qui ressemble à du contenu coupé au bord droit est une
limite de tuile, pas un débordement. Les captures « avant » de ce document sont donc
illustratives et ne doivent pas être lues comme des mesures ; **c'est la mesure DOM qui fait
foi**, et c'est elle qui est reportée dans les tableaux.

### 0.2 Le piège : un faux positif massif, écarté

**La première campagne de mesure a produit un diagnostic faux, qui aurait conduit à « corriger »
du code sain.** Il est documenté ici parce qu'il conditionne la lecture de tout l'audit.

Mesuré initialement sur `/dashboards` à 360 px : `scrollWidth` = **1296 px**, 118 éléments hors
cadre, `.react-grid-item` figé à **1280 px**. Conclusion apparente : *react-grid-layout ne
s'adapte pas*.

C'était faux. En inspectant l'élément :

| | valeur |
|---|---|
| `style` en ligne posé par react-grid-layout | `width: 328px` ✅ *(correct)* |
| `getComputedStyle().width` | `1280px` ❌ |
| `document.getAnimations()` | `CSSTransition` sur `.react-grid-item`, `playState: "running"`, **indéfiniment** |

`react-grid-layout/css/styles.css` déclare `transition: left .2s, top .2s, width .2s, height .2s`.
Le rendu du navigateur piloté ici est **bridé** (pas de tick `requestAnimationFrame` — c'est aussi
pourquoi les captures d'écran expirent) : la transition de largeur **ne s'achève jamais** et
maintient la largeur *initiale* de premier rendu. En neutralisant les transitions :

```
scrollWidth 1296 → 380      .react-grid-item 1280 → 328 (= sa largeur en ligne)
```

Sur un téléphone réel la transition s'achève en 0,2 s. **La grille de widgets fonctionne.**
Toutes les mesures ci-dessous ont donc été refaites avec `transition: none !important` injecté
avant mesure, ce qui donne l'état *stabilisé* — celui que voit l'utilisateur.

Deux autres constats sont tombés avec lui, après vérification **dans le code source** :

- *« les graphiques `@ant-design/plots` ne se redimensionnent pas »* → **faux** : `autoFit` est
  présent sur **les 8 graphiques** (`app/dashboards/components/charts.tsx` l.49/76/100/132,
  `app/courriers/tableau-de-bord/components/charts.tsx` l.51/76/109/133). Le canvas figé à
  1236 px est le même artefact (G2 redimensionne via `ResizeObserver` + rAF, bridé ici).
- *« les tableaux des widgets sont tronqués »* (`TRONQUE(1246/324)`) → **non confirmé** : c'est un
  désaccord en-tête/corps consécutif à la même largeur initiale périmée. À **revérifier sur
  appareil réel** avant toute intervention — voir §5.

> **Règle retenue pour la phase 2 : aucun « correctif » ne sera appliqué sur la foi d'une mesure
> seule ; chaque défaut listé comme certain est adossé à une ligne de code source.**

---

## 1. Tableau des 57 routes

`OK` = `overflow: false`. `ÉCHEC` = débordement de page, avec le `scrollWidth` mesuré.
La colonne « Après » sera renseignée en phase 2.

### 1.1 Accueil, recherche, acquisition, divers (8 routes)

| Route | 360 | 390 | 768 | Débordement (px, élément) | Autres défauts | Gravité | Effort | Après |
|---|---|---|---|---|---|---|---|---|
| `/` → `/dashboards` | **ÉCHEC 380** | OK | OK | +20 — `Segmented` 7 options (364 px) | idem `/dashboards` | Majeur | S | **OK 360 / 390 / 758** |
| `/dashboards` | **ÉCHEC 380** | OK | OK | +20 — `.ant-space` 364 px (`PeriodFilter`) | 7 champs < 16 px | Majeur | S | **OK 360 / 390 / 758** |
| `/acquisition` | OK | OK | OK | — | 1 champ < 16 px | Mineur | S | **OK** |
| `/intercalaires` | OK | OK | OK | — | **21 champs < 16 px**, 32 cibles < 44 px | Majeur | S | **OK** |
| `/search` | OK | OK | OK | — | tableau 1189/278 = **4,3 écrans** | Majeur | M | **OK** |
| `/documents/[id]` (149) | OK | OK | OK | — | onglets 861 px clippés ; PDF | Majeur | M | **OK** |
| `/design` | OK | OK | OK | — | 35 textes < 12 px (galerie de tokens) | Mineur | S | **OK** |
| `/login` | OK | OK | OK | — | 2 champs < 16 px | Mineur | S | **OK** |

### 1.2 Administration (29 routes)

| Route | 360 | 390 | 768 | Débordement | Autres défauts | Gravité | Effort | Après |
|---|---|---|---|---|---|---|---|---|
| `/admin` → `classification-plans` | OK | OK | OK | — | **129 cibles < 44 px** ; 545/278 | Majeur | M | **OK** |
| `/admin/users` | OK | OK | OK | — | 786/278 ; 10 textes < 12 px | Majeur | M | **OK** |
| `/admin/roles` | OK | OK | OK | — | **46 champs < 16 px**, 72 cibles < 44 px | Majeur | M | **OK** |
| `/admin/document-types` | OK | OK | OK | — | — | — | — | **OK** |
| `/admin/dossiers` | OK | OK | OK | — | 553/278 ; 77 cibles < 44 px | Majeur | M | **OK** |
| `/admin/classification-plans` | OK | OK | OK | — | 545/278 ; 129 cibles < 44 px | Majeur | M | **OK** |
| `/admin/geolocalisation` | OK | OK | OK | — | 396/278 | Mineur | S | **OK** |
| `/admin/parametres/email` | OK | OK | OK | — | 3 champs < 16 px | Mineur | S | **OK** |
| `/admin/archives/cycles-de-vie` | **ÉCHEC 614** | **ÉCHEC 614** | OK | +254 — `<table>` 573 px, `<Table>` **sans `scroll`** | 7 colonnes inatteignables | **Bloquant** | S | **OK 360 / 390 / 758** |
| `/admin/archives/elements-listes` | OK | OK | OK | — | 438/278 ; 13 champs < 16 px | Mineur | S | **OK** |
| `/admin/archives/metadonnees-types` | OK | OK | OK | — | 559/278 | Mineur | S | **OK** |
| `/admin/archives/metadonnees` | OK | OK | OK | — | 479/278 ; 12 champs < 16 px | Mineur | S | **OK** |
| `/admin/archives/modes-destruction` | OK | OK | OK | — | 5 champs < 16 px | Mineur | S | **OK** |
| `/admin/archives/motifs-pret` | OK | OK | OK | — | 5 champs < 16 px | Mineur | S | **OK** |
| `/admin/archives/parametrage-types` | OK | OK | OK | — | 559/278 (6 colonnes) | Mineur | S | **OK** |
| `/admin/archives/sorts-finaux` | OK | OK | OK | — | — | — | — | **OK** |
| `/admin/courriers/confidentialites` | OK | OK | OK | — | — | — | — | **OK** |
| `/admin/courriers/entites-externes` | OK | OK | OK | — | **1148/278 = 4,1 écrans** ; 103 cibles < 44 px | Majeur | M | **OK** |
| `/admin/courriers/natures` | OK | OK | OK | — | — | — | — | **OK** |
| `/admin/courriers/objets` | OK | OK | OK | — | 606/278 ; 8 champs < 16 px | Mineur | S | **OK** |
| `/admin/courriers/organigrammes` | OK | OK | OK | — | 541/278 | Mineur | S | **OK** |
| `/admin/courriers/role-organigramme` | OK | OK | OK | — | 509/278 ; 7 textes < 12 px | Mineur | S | **OK** |
| `/admin/courriers/types-depart` | OK | OK | OK | — | — | — | — | **OK** |
| `/admin/courriers/types-entites-externes` | OK | OK | OK | — | — | — | — | **OK** |
| `/admin/courriers/types-imputation` | OK | OK | OK | — | 437/278 | Mineur | S | **OK** |
| `/admin/securite/confidentialite-utilisateurs` | OK | OK | OK | — | 633/278 ; 20 textes < 12 px | Majeur | M | **OK** |
| `/admin/securite/confidentialites` | OK | OK | OK | — | 330/278 | Mineur | S | **OK** |
| `/admin/securite/type-par-profil` | OK | OK | OK | — | 368/278 ; 5 champs < 16 px | Mineur | S | **OK** |
| `/admin/securite/type-par-utilisateur` | OK | OK | OK | — | 5 champs < 16 px | Mineur | S | **OK** |

### 1.3 Archives (6 routes)

| Route | 360 | 390 | 768 | Débordement | Autres défauts | Gravité | Effort | Après |
|---|---|---|---|---|---|---|---|---|
| `/archives/communiquer` | OK | OK | OK | — | 5 champs < 16 px | Mineur | S | **OK** |
| `/archives/documents-communiques` | OK | OK | OK | — | 935/278 (8 colonnes) | Majeur | M | **OK** |
| `/archives/documents-epures` | OK | OK | OK | — | 985/278 (7 colonnes) | Majeur | M | **OK** |
| `/archives/dua-expirees` | **ÉCHEC 461** | **ÉCHEC 461** | OK | +101 — `Input.Search` **largeur figée 420 px** | 1151/278 = 4,1 écrans | **Bloquant** | S | **OK 360 / 390 / 768** |
| `/archives/historique-communications` | OK | OK | OK | — | 815/278 | Majeur | M | **OK** |
| `/archives/mes-documents-communiques` | OK | OK | OK | — | 819/278 | Majeur | M | **OK** |

### 1.4 Courriers (14 routes)

| Route | 360 | 390 | 768 | Débordement | Autres défauts | Gravité | Effort | Après |
|---|---|---|---|---|---|---|---|---|
| `/courriers/tableau-de-bord` | **ÉCHEC 380** | OK | OK | +20 — `Segmented` `PeriodFilter` | désaccord en-tête/corps des 2 tableaux de widgets **à confirmer** (§4) | Majeur | S | **OK 360 / 390 / 758** |
| `/courriers/enregistrement` | OK | OK | OK | — | 9 champs < 16 px | Mineur | S | **OK** |
| `/courriers/depart` | OK | OK | OK | — | 6 champs < 16 px | Mineur | S | **OK** |
| `/courriers/controle` | OK | OK | OK | — | **1264/278 = 4,5 écrans** | Majeur | M | **OK** |
| `/courriers/controle/[id]` (1244) | **ÉCHEC 461** | **ÉCHEC 461** | OK | +101 — `<Descriptions>` 419 px | — | **Bloquant** | S | **OK 360 / 390 / 768** |
| `/courriers/validation` | OK | OK | OK | — | **1605/278 = 5,8 écrans** (pire de l'app) ; 50 textes < 12 px | Majeur | M | **OK** |
| `/courriers/suivi` | OK | OK | OK | — | 1544/278 = 5,6 écrans ; 25 textes < 12 px | Majeur | M | **OK** |
| `/courriers/suivi/[id]` (1247) | **ÉCHEC 560** | **ÉCHEC 560** | OK | +200 — `<Descriptions>` 518 px | — | **Bloquant** | S | **OK 360 / 390 / 768** |
| `/courriers/parapheur` | OK | OK | OK | — | 1357/278 = 4,9 écrans | Majeur | M | **OK** |
| `/courriers/parapheur/[id]` (1236) | **ÉCHEC 560** | **ÉCHEC 560** | OK | +200 — `<Descriptions>` 518 px | — | **Bloquant** | S | **OK 360 / 390 / 768** |
| `/courriers/recherche` | OK | OK | OK | — | 1353/278 = 4,9 écrans ; 7 champs < 16 px | Majeur | M | **OK** |
| `/courriers/recherche/[id]` (1244) | **ÉCHEC 461** | **ÉCHEC 461** | OK | +101 — `<Descriptions>` 419 px | — | **Bloquant** | S | **OK 360 / 390 / 768** |
| `/courriers/integration-decharge` | OK | OK | OK | — | 1 champ < 16 px | Mineur | S | **OK** |
| `/courriers/documents-scannes` | OK | OK | OK | — | 752/278 ; infobulle des formats inatteignable au doigt | Majeur | M | **OK** |

---

## 2. Synthèse

### 2.1 Comptage

| | 360 px | 390 px | 768 px |
|---|---|---|---|
| **Avant** — routes qui passent | **48 / 57** | **50 / 57** | **57 / 57** |
| **Avant** — routes en échec | **9** | **7** | **0** |
| **Après** — routes qui passent | **57 / 57** | **57 / 57** | **57 / 57** |
| **Après** — routes en échec | **0** | **0** | **0** |

> **Après correction** (branche `fix/mobile-first`, 6 commits) : les 57 routes ont
> `overflow: false` aux trois largeurs. S'y ajoutent trois défauts qui n'apparaissaient pas dans
> ce comptage et qui sont eux aussi corrigés : le débordement **pendant le chargement**
> (squelettes, §2.3), le panneau de notifications **coupé hors écran** (invisible à
> `scrollWidth`, un popup qui déborde ne fait pas défiler la page), et la **recherche globale
> inatteignable** sous 992 px (§2.4b).
>
> Mesure finale : 57/57 à 360 px, 57/57 à 390 px, 18 routes de contrôle à 768 px (couvrant tous
> les modules et **toutes** les routes modifiées — la couche mobile étant bornée à
> `max-width: 767px`, elle est inactive à 768 px, où l'audit initial donnait déjà 57/57).
> Non-régression desktop : empreinte géométrique **identique** à la référence sur les 7 pages de
> contrôle à 1280 px ; aucun débordement à 1536 px.
> Cibles tactiles < 44 px : **0**. Textes < 12 px : **0** (hors spécimens typographiques
> assumés de `/design`). Champs < 16 px : **0**. Zoom utilisateur : préservé.
> `tsc --noEmit` propre, `lint` propre, **build de production OK**.
>
> Le détail des motifs et la règle à suivre pour une page future :
> [`MOBILE-CORRECTIONS.md`](MOBILE-CORRECTIONS.md).

Les 9 routes en échec à 360 px (8 pages distinctes, `/` étant un alias de `/dashboards`) :

1. `/` et `/dashboards` — +20 px
2. `/courriers/tableau-de-bord` — +20 px
3. `/admin/archives/cycles-de-vie` — +254 px
4. `/archives/dua-expirees` — +101 px
5. `/courriers/controle/[id]` — +101 px
6. `/courriers/recherche/[id]` — +101 px
7. `/courriers/parapheur/[id]` — +200 px
8. `/courriers/suivi/[id]` — +200 px

**Contrôle à 320 px** : aucune page saine à 360 ne casse à 320 (`/courriers/validation`,
`/admin/users`, `/search`, `/intercalaires`, `/courriers/enregistrement` toutes `overflow: false`,
`scrollWidth = 320`). **Il n'y a donc pas de point de rupture** : les échecs sont causés par des
éléments de taille fixe, qui cassent en dessous de leur propre largeur, pas par un palier.

### 2.2 Ce qui va déjà bien — à ne pas toucher

- **La coquille** (`AuthShell.tsx`) : `Grid.useBreakpoint`, `Drawer` 260 px sous `lg`. Aucun défaut.
- **`.da-page`** est déjà mobile-first : `padding: 16px`, puis `25px 27px` en `@media (min-width: 768px)`.
  `globals.css` **contient déjà des media queries** (contrairement à l'hypothèse de départ).
- **`PageHeader`** est déjà responsive : `stacked = !screens.sm`, actions sous le titre, `minWidth: 0`.
- **La grille de widgets** (`GrilleWidgets.tsx`) : point de rupture unique **délibéré et documenté**
  (il corrige un bug d'enregistrement d'agencement). Elle se réduit correctement. **Ne pas y toucher.**
- **Les graphiques** : `autoFit` déjà posé sur les 8.
- **33 des 37 tableaux** défilent déjà horizontalement (`.ant-table-content: overflow-x auto`).

### 2.3 Un défaut que la mesure seule ne pouvait pas voir : les squelettes de chargement

Le script de mesure attend la disparition de `.ant-skeleton-active` avant de mesurer — il n'a donc
**jamais vu l'état de chargement**, qui est pourtant le premier écran affiché sur ~11 routes.
L'inventaire statique l'a trouvé dans le code ; la mesure l'a ensuite confirmé.

`app/components/skeletons.tsx:21` et `:42` posent `gridTemplateColumns: repeat(N, 1fr)`.
Une piste `1fr` a pour minimum `auto`, et chaque `Skeleton.Button size="small"` porte le
`min-width` qu'AntD calcule comme `controlHeightSM × 2` = **56 px** (`antdTheme.ts:56`). Les pistes
ne peuvent donc pas rétrécir. Mesuré à 360 px, en direct, pendant le chargement :

| Route | Colonnes | `grid-template-columns` calculé | `scrollWidth` | Débordement |
|---|---|---|---|---|
| `/courriers/validation` | 7 | `56px 56px 56px 56px 56px 56px 56px` | **537** | **+177 px** |
| `/admin/courriers/entites-externes` | 5 | `56px 56px 56px 56px 56px` | **393** | **+33 px** |
| `/admin/courriers/objets` | 4 | `56px 56px 56px 56px` | 360 | 0 (à la limite exacte) |

Seuil réel : **≥ 5 colonnes déborde**. `MailWorklist.tsx:197` passe `columns={columns.length}`
(7 à 8) pour les 4 files courrier — c'est le pire cas. Correction : `minmax(0, 1fr)` +
`minWidth: 0` sur les `Skeleton.Button`. **2 lignes, 11 routes.**

### 2.4 Deux défauts de fond confirmés dans le navigateur

**a) Aucun `box-sizing: border-box` global.** Le preflight Tailwind est désactivé
(`tailwind.config.ts`, décision assumée : ne pas écraser le reset AntD). AntD ne pose
`border-box` que sur ses propres classes `.ant-*`. Vérifié en direct :

```
div { width:100px; padding:10px; border:1px }  →  rendu 122 px        body → content-box
```

Toute `<div>` maison portant `width` **et** `padding` est donc plus large que sa valeur déclarée.
C'est le préalable arithmétique de toutes les autres corrections de largeur.

**b) La recherche globale disparaît sous 992 px.** `TopBar.tsx:142` :
`{!isMobile && (<button aria-label="Recherche globale (Ctrl+K)" …>)}`, avec `isMobile = !screens.lg`.
Le **seul** autre point d'entrée de la palette est le raccourci `Ctrl+K` (`AuthShell.tsx`) — qu'un
téléphone n'a pas. **C'est une action primaire rendue inatteignable sur mobile**, donc une
violation directe de la règle « rien ne disparaît sur mobile ». Le titre de page (`:123`) et le nom
d'utilisateur (`:209`) sont eux aussi masqués, mais légitimement : ils sont redonnés ailleurs
(`PageHeader`, menu utilisateur). **Ne pas « corriger » ces deux-là.**

### 2.5 Familles de causes, par nombre de pages touchées

| # | Famille | Pages | Gravité | Point de correction unique |
|---|---|---|---|---|
| **F1** | **Aucune couche CSS mobile** : pas de `box-sizing` global, **zéro `@media (max-width)`** dans `globals.css`. `.ant-space` horizontal est `flex-wrap: nowrap` (vérifié) → ~47 barres d'actions ne se replient pas. | **57** | Majeur | `globals.css`, un seul bloc |
| **F2** | **Chrome applicatif** : palette masquée (§2.4b), `NotificationsBell` figé à 360 px, Drawer `RefLayout` 380 px, `PageHeader` bascule à `sm` au lieu de `md` | 33 → 57 | **Bloquant** (palette) | 5 fichiers `app/components/` |
| **F3** | **Tableaux** : `grep "fixed:"` = **0** et `grep "responsive:"` = **0** sur 121 fichiers. 4 à 6 écrans de défilement pour atteindre les actions. | ~30 | Majeur | 5 patrons partagés + pages |
| **F4** | **`TableSkeleton` non rétractable** (§2.3) | 11 | **Bloquant** | `skeletons.tsx`, 2 lignes |
| **F5** | **Patrons du module Courrier** : `<Descriptions column={2} bordered>` → AntD repasse en `table-layout: auto` sans `overflow` — c'est la cause exacte des 419/518 px mesurés | 12 | **Bloquant** | `MailDetailPage.tsx:284` + 3 fichiers |
| **F6** | **Champs : `minWidth` figé au lieu de `maxWidth`** (34 occurrences) ; `Input.Search` 420 px | ~12 | **Bloquant** | motif mécanique |
| **F7** | **Champs < 16 px → zoom iOS** ; **cibles < 44 px** (`controlHeight` = 32) | ~25 | Majeur | **arbitrage requis** (§4) |
| **F8** | **Visionneuse PDF** : `scale` initial 1,25 sans ajustement, rail de vignettes 148 px `flex:none` | 6 hôtes → 12 | Majeur | `PdfViewer.tsx` + `pdf-viewer.css` |
| **F9** | **Modales en pourcentage** (70 % / 88 % / 94 %) calibrées desktop : 70 % de 360 = 252 px utiles | 3 | Majeur | `feedback.ts` + 3 fichiers |
| **F10** | **Infobulles porteuses d'information**, inatteignables au tactile | 12 sites | Majeur | nouveau `InfoTooltip` |
| **F11** | **Pas d'export `viewport`** dans `app/layout.tsx` | 57 | Majeur | 1 ligne |
| **F12** | **Paliers Tailwind ≠ AntD** (640/768/1024 vs 576/768/992/1200/1600 — accord sur 768 seulement). Contradiction **latente** : zéro préfixe responsive Tailwind aujourd'hui. | structurel | Majeur | à trancher avant tout |

**Le levier : 9 fichiers portent l'essentiel.** `globals.css`, `skeletons.tsx`, `PageHeader.tsx`,
`RefLayout.tsx`, `TopBar.tsx`, `MailDetailPage.tsx`, `MailWorklist.tsx`, `pdf-viewer.css`,
`TypeSecurityPage.tsx` — les corriger avant toute page individuelle traite **~45 des 57 routes
sans ouvrir un seul fichier de page**.

---

## 3. Stratégie de correction proposée

Principe : **corriger le motif, mesurer, et seulement ensuite descendre à la page.** Chaque lot est
re-mesuré à 360 px *et* à 1280/1536 px avant de passer au suivant.

| Lot | Contenu | Routes débloquées | Fichiers |
|---|---|---|---|
| **1. Socle** | `box-sizing` global (**commit isolé**) ; bloc `@media (max-width: 767px)` : `flex-wrap` sur les `Space`, en-têtes de carte, `Popover`, `RangePicker`, `.ant-descriptions-view { overflow-x:auto }`, onglets défilables ; export `viewport` ; décision paliers | **57** | `globals.css`, `layout.tsx`, `tailwind.config.ts` |
| **2. Chrome** | palette de recherche rendue en bouton-icône sur mobile (**lot bloquant**), `NotificationsBell`, `RefLayout`, `PageHeader` `sm`→`md`, `feedback.ts` | 33 → 57 | 5 fichiers |
| **3. Squelettes** | `minmax(0, 1fr)` + `minWidth: 0` | 11 | 1 fichier, 2 lignes |
| **4. Admin** | 4 patrons partagés puis les locaux ; `cycles-de-vie:383` en wrapper `overflowX`, **pas** `scroll.x` (voir §5) | 29 | ~10 fichiers |
| **5. Courriers** | `MailDetailPage` (4 fiches d'un coup), `MailWorklist`, `MailViewer`, `FicheImputationModal` | 14 | 4 + locaux |
| **6. Documents + Archives** | `LendingListPage` (3 pages), `AccessTab`, `SecurityTab`, `dua-expirees:237` | 10 | ~8 fichiers |
| **7. PDF** | `pdf-viewer.css` puis échelle initiale (**après arbitrage**) | 12 en aval | 2 fichiers |
| **8. Dashboards** | `PeriodFilter` défilable, `ChartCard`, tables des widgets | 2 | ~6 fichiers |
| **9. Résiduel** | acquisition, intercalaires, search, **`/design`** (la vitrine doit porter la convention) | 4 | 4 fichiers |
| **10. Filet** | `overflow-x: clip` sur `.da-page` — **en tout dernier, jamais avant** : posé tôt, il masquerait les débordements et rendrait la vérification des lots 1-9 impossible. `clip` et non `hidden` (`hidden` casserait le `position: sticky` de `.da-sticky-actions`). | — | 1 ligne |

**Non-régression desktop — le risque numéro un est `box-sizing: border-box`.** Il rétrécit toute
`<div>` maison combinant `width` et `padding` : `TopBar.tsx:142` (−24 px), `NotificationsBell:76`,
`PdfViewer.tsx:442/467/515`, `design/page.tsx:209`. D'où le **commit isolé d'une seule ligne**,
révocable en une ligne, suivi d'un contrôle visuel desktop ciblé sur ces quatre surfaces.

Second risque : `fixed: 'right'` sur les colonnes d'actions fait passer AntD en vraie
`table-layout: fixed` — les tables sans largeur explicite sur toutes leurs colonnes peuvent se
redistribuer. À appliquer patron par patron, avec contrôle desktop après chacun (5 contrôles au
lieu de 23).

---

## 4. Arbitrages qui vous reviennent

1. **Police des champs à 16 px sous 768 px (zoom iOS).** `inputFontSize: 13` et `fontSize: 14`
   sont des décisions de charte (PRD relook §4.6). Les porter à 16 px **est** une modification
   typographique, que le brief interdit — mais sans elle, iOS zoome à chaque focus et la page
   saute. L'alternative (`maximum-scale=1`) est un anti-patron d'accessibilité, écartée d'office.
   *Recommandation : accepter, en surcharge CSS bornée à `max-width: 767px`, sans jamais toucher
   `tokens.ts` ni `antdTheme.ts` — le desktop reste bit-à-bit identique.*
2. **Cibles tactiles à 44 px sous 768 px** : même nature (densité de production, dérogation §4.6).
   *Recommandation : 40 px sous `(pointer: coarse)` uniquement, zéro effet sur poste à souris.*
3. **Glisser-déposer des widgets sur mobile.** Sortir de react-grid-layout sous 768 px est la seule
   façon d'empiler les widgets sans réintroduire le bug de persistance documenté
   (`GrilleWidgets.tsx:27-45`). Contrepartie : réorganiser son tableau de bord au doigt devient
   impossible (ajout, retrait et enregistrement continuent de fonctionner).
   *Recommandation : accepter — réorganiser une grille de 12 colonnes sur 360 px n'a pas de sens.*
4. **Échelle initiale du visionneur PDF.** Passer `fit` de `null` à `'width'` change l'état initial
   du composant — formellement un changement de comportement. Sans lui, la page est peinte à
   744 px dans un cadre de 310 px et reste illisible.
   *Recommandation : accepter, conditionné à `!screens.md` pour garantir zéro effet desktop.*
5. **Paliers Tailwind.** Soit aligner `theme.extend.screens` sur AntD, soit interdire les préfixes
   responsive Tailwind et ne garder que des `@media` dans `globals.css`.
   *Recommandation : la seconde — il y a aujourd'hui **zéro** préfixe responsive Tailwind dans les
   121 fichiers, la contradiction est donc latente, et tout concentrer dans le socle la supprime.*
6. **Le dépôt n'est pas un dépôt Git.** `git rev-parse` échoue, il n'y a pas de `.git`. La consigne
   « branche `fix/mobile-first`, un commit par module » est donc inapplicable en l'état.
   *Options : `git init` + commit initial de l'existant avant de commencer, ou livrer sans Git.*

---

## 5. Points restant à confirmer

1. **Désaccord en-tête/corps des tableaux de widgets** (`ZoneRetards.tsx:79`, `ZoneCharge.tsx:43` —
   `scroll={{ y }}` sans `x` ; vérifié dans `rc-table` : `scroll.y` seul ne pose **pas**
   `overflow-x: auto`). Mesuré en-tête 1236 px / corps 650 px, mais dans le contexte bridé du §0.2.
   **À revérifier sur appareil réel avant modification.** Le correctif (`x: 'max-content'`) est de
   toute façon sans risque.
2. ~~**`parametrage-types` et `cycles-de-vie`**~~ — **traité.** `cycles-de-vie` a reçu le wrapper
   `overflowX: 'auto'`, le motif déjà en place sur `parametrage-types`, pour la raison que son
   commentaire d'origine documente (`max-content` fige les colonnes et rejetait « Plan de
   classement » hors cadre).
3. **Visionneuse PDF** : toujours non exercée par la mesure (les fiches ne l'ouvrent pas par
   défaut). Diagnostic issu de la lecture du code. **Non corrigée** — voir
   [`MOBILE-CORRECTIONS.md`](MOBILE-CORRECTIONS.md) §6.
4. **Modales et tiroirs** — **partiellement traité.** Ouverts et mesurés à 360 px : le panneau de
   notifications (défaut réel, corrigé), le tiroir `RefLayout` (336 px, déjà correct) et les
   modales de confirmation (AntD les plafonne lui-même — règle relevée dans sa feuille de style,
   aucune correction nécessaire). **Restent** les trois modales en pourcentage (70 / 88 / 94 %),
   non ouvertes faute de chemin d'accès direct, et non corrigées.
5. **`Grid.useBreakpoint()` renverrait `{}` au premier rendu** (donc tous les `!screens.X` vrais au
   premier paint) : rapporté par l'inventaire statique, **toujours non revérifié par moi**. La
   règle de méthode qui en découle (préférer la media query CSS au point de rupture JS) a été
   appliquée par précaution : la couche mobile est entièrement en CSS.
6. **Une 58ᵉ route est apparue pendant le chantier** — `/profil`, développée en parallèle par un
   autre intervenant (avec des modifications de `TopBar.tsx`, `nav.ts`, `lib/auth.ts` et de l'API).
   Elle ne fait partie d'aucun de mes commits et **n'a reçu aucune correction**. Elle a en
   revanche été **mesurée**, et elle passe : `overflow: false` à 360, 390 et 768 px, 0 cible
   tactile sous 44 px, 0 texte sous 12 px, 0 champ sous 16 px.
   C'est la meilleure validation de l'approche : une page écrite **sans connaissance du
   chantier** hérite de la couche mobile partagée et passe les critères sans intervention.
