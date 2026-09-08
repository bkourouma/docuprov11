# Corrections mobile — motifs, règles et mode d'emploi

> Établi le 2026-09-08, à l'issue du chantier `fix/mobile-first`.
> Audit et mesures : [`AUDIT-MOBILE.md`](AUDIT-MOBILE.md).
>
> **Ce document doit permettre d'écrire une 58ᵉ page correctement du premier coup.**
> Il décrit *où* vivent les corrections, *pourquoi* elles sont là, et les règles à suivre.

---

## 1. La décision structurante : un seul système de paliers

**Il n'y a aucun préfixe responsive Tailwind dans l'application, et il ne doit pas y en avoir.**

Les paliers de Tailwind (640 / 768 / 1024 / 1280 / 1536) et ceux d'Ant Design
(576 / 768 / 992 / 1200 / 1600) ne coïncident que sur **768**. Faire cohabiter les deux, c'est
garantir qu'un jour `lg:` (1024) et `screens.lg` (992) se contrediront sur 32 px, pour un bug
que personne ne saura reproduire.

La règle retenue (arbitrage validé) :

| Besoin | Outil |
|---|---|
| Responsive **transverse** (tous les écrans, comportement AntD) | `@media (max-width: 767px)` dans `app/globals.css` |
| Responsive **d'une grille** | props `xs / sm / md / lg` des `<Col>` AntD |
| Responsive **conditionnant le rendu React** | `Grid.useBreakpoint()` |
| Préfixes Tailwind `md:` `lg:` | **interdits** |

`tailwind.config.ts` porte cette décision en commentaire, avec la marche à suivre si elle devait
un jour être levée (recopier d'abord les paliers AntD).

> **Préférer la media query CSS au point de rupture JS quand le choix existe.**
> `Grid.useBreakpoint()` renvoie un objet vide au premier rendu : tous les `!screens.X` valent
> alors `true`, et la page se peint une première fois en version mobile avant de se corriger.
> Une media query CSS est juste dès le premier pixel.

---

## 2. La couche mobile — `app/globals.css`

Tout le responsive transverse tient dans **un seul bloc** `@media (max-width: 767px)`.
Aucune de ces règles ne touche une couleur, un rayon, une ombre ou une famille de police : le
relook « Plus Admin » est intact, et le rendu au-dessus de 768 px est identique au pixel près
(vérifié par empreinte géométrique, cf. §5).

| Règle | Ce qu'elle corrige | Pourquoi AntD ne le fait pas |
|---|---|---|
| `.ant-space … { flex-wrap: wrap }` | barres d'actions qui ne se replient pas | `.ant-space` est `inline-flex` **sans** `flex-wrap` ; le `wrap` du composant React est posé en style en ligne et reste prioritaire |
| `.ant-space { max-width: 100% }` + `.ant-space-item { min-width: 0 }` | barres de filtres irréductibles | deux verrous cumulés — voir §3.1, c'est le motif le plus subtil du lot |
| `.ant-card-head-wrapper { flex-wrap: wrap }` | l'`extra` d'une carte sort du cadre | `head-wrapper` est flex sans wrap, titre en `flex: 1` |
| `.ant-segmented { overflow-x: auto }` | `Segmented` trop large | AntD ne le replie **jamais**, ses items sont en `overflow: hidden` + ellipsis |
| `.ant-popover, .ant-dropdown, .ant-picker-panel-container { max-width: calc(100vw - 16px) }` | surfaces flottantes bord à bord | AntD plafonne à `100vw`, sans gouttière |
| `.ant-picker-panels { flex-wrap: wrap }` | les 2 panneaux du `RangePicker` (≈ 560 px) | `flex-wrap: nowrap` codé en dur |
| `.ant-descriptions-view { overflow-x: auto }` | `<Descriptions bordered>` qui pousse la page | la variante bordée repasse en `table-layout: auto`, **sans** `overflow` |
| `.ant-tabs-nav-wrap { overflow-x: auto }` | onglets inatteignables | `overflow: hidden` et le bouton « plus » n'est pas toujours rendu |
| `.ant-tag { font-size: 12px }` | seul texte sous 12 px de l'app | valeur de charte (11 px) |
| `@media (pointer: coarse)` → `min-height/min-width: 44px` | cibles tactiles | `controlHeight` = 32 px (densité de production, PRD §4.6) |
| champs de saisie à `16px` | zoom iOS au focus | `inputFontSize` = 13 px |

Hors media query : `box-sizing: border-box` global, et les barres de défilement WebKit stylées
uniquement sous `(hover: hover) and (pointer: fine)`.

### `!important` : quand, et pourquoi

Les feuilles CSS-in-JS d'AntD s'insèrent **après** `globals.css` dans le `<head>`. À spécificité
égale, c'est l'ordre d'insertion qui tranche — et AntD gagne.

> **Règle : `!important` uniquement quand AntD déclare explicitement la même propriété sur le même
> sélecteur, et jamais « au cas où ».** Vérifier dans le navigateur que la règle ne s'applique
> pas avant de l'ajouter.

Concernés ici : `.ant-tabs-nav-wrap` (overflow), `.ant-picker-panels` (flex-wrap), la police des
champs, `.ant-tag` (font-size), `.ant-btn` (min-width), `.da-notif-dropdown` (position posée en
style **en ligne** par rc-align). Les autres règles n'en ont pas besoin.

---

## 3. Les motifs, et comment les reproduire

### 3.1 Une barre de filtres qui ne rétrécit pas

Le motif le plus instructif du chantier, parce que **deux verrous se masquaient l'un l'autre**.
Sur `/archives/dua-expirees`, le champ portait déjà `maxWidth: '100%'` — et débordait quand même.

1. `.ant-space` est `inline-flex` : sans largeur imposée il se dimensionne sur son **contenu**.
   Le pourcentage du champ se résolvait donc contre un parent que le champ dimensionnait
   lui-même. Circulaire.
2. `.ant-space-item` a `min-width: auto` (le défaut d'un élément flex) : il refuse de descendre
   sous la largeur de son contenu.

Les deux règles de la couche mobile lèvent les deux verrous. **La page n'a eu aucune modification
propre** — c'est la démonstration qu'un motif bien placé vaut mieux que N rustines.

> **À retenir : `maxWidth: '100%'` sur un enfant de `Space` ne sert à rien tant que le `Space`
> n'est pas borné et que l'item ne peut pas rétrécir.**

### 3.2 Un tableau large

Trois cas, dans cet ordre de préférence :

1. **`scroll={{ x: 'max-content' }}`** — le défaut. 33 des 40 tables l'ont déjà.
2. **Wrapper `<div style={{ overflowX: 'auto' }}>`** — quand `max-content` a été écarté
   explicitement. C'est le cas de `parametrage-types` et `cycles-de-vie` : `max-content` fige
   chaque colonne à la largeur de son contenu et rejetait « Plan de classement » hors cadre.
   Le commentaire d'origine de `parametrage-types` explique la décision ; `cycles-de-vie` la suit.
3. **Ne rien faire** — seulement si le tableau tient (≤ 3 colonnes courtes).

> **Ne jamais laisser un `<Table>` sans l'un des deux premiers.** `cycles-de-vie` était le seul
> des 40 dans ce cas : ses 7 colonnes poussaient la page entière à 614 px sur un écran de 360,
> décalant l'en-tête et la barre supérieure, sans rapport apparent avec le tableau.
>
> **`scroll={{ y }}` seul ne suffit pas** : vérifié dans `rc-table`, il ne pose pas
> `overflow-x: auto`.

### 3.3 Une grille de squelette

`repeat(N, 1fr)` n'est **pas** réductible : le minimum implicite d'une piste `1fr` est `auto`,
donc la largeur minimale de son contenu — et `Skeleton.Button` porte un `min-width` de 56 px
imposé par AntD.

> **Toujours `repeat(N, minmax(0, 1fr))`, et `minWidth: 0` sur les enfants.**
> Sans cela, 5 colonnes suffisent à déborder un écran de 360 — pendant le chargement, c'est-à-dire
> sur le tout premier écran que voit l'utilisateur.

### 3.4 Une surface flottante (popover, dropdown, panneau)

Un popup qui déborde **ne fait pas défiler la page** : il coupe son contenu en silence, et aucune
mesure de `scrollWidth` ne le voit. Il faut l'ouvrir et le mesurer.

Le panneau de notifications faisait 360 px, aligné sur la cloche dont le bord droit est à 288 px :
56 px partaient hors de l'écran à gauche. `autoAdjustOverflow` d'AntD **bascule le placement**
mais ne traite pas le cas « plus large que la fenêtre ».

> **Un panneau plus large que l'espace disponible doit être étalé sur la fenêtre**
> (`left`/`right` + `width: auto`), pas seulement plafonné en largeur — sinon rc-align le
> positionne toujours avec sa largeur naturelle.

### 3.5 Une largeur figée

```
width: 380                              →  width="min(380px, calc(100vw - 24px))"
Math.min(380, window.innerWidth - 24)   →  idem
```

> **Ne jamais lire `window.innerWidth` pour dimensionner.** La valeur est figée au rendu (elle ne
> suit pas une rotation d'écran) et le repli SSR dépasse la fenêtre le temps de l'hydratation.
> `min()` fait le même calcul, en continu, sans lire `window`.

### 3.6 Modales

**Rien à faire pour une largeur numérique.** AntD 5.29 ship déjà
`@media (max-width: 767px) { .ant-modal { max-width: calc(100vw - 16px) } }` — vérifié dans sa
feuille de style. `width={520}` ou `width={620}` se plafonnent tout seuls.

> **En revanche, une largeur en POURCENTAGE ne se relève jamais** : `width="70%"` donne 252 px
> utiles sur un écran de 360. Les trois modales concernées
> (`FicheImputationModal` 70 %, `MailViewer` 88 %, `acquisition` 94 %) restent à traiter — voir §6.

---

## 4. Rien ne disparaît sur mobile

C'est la règle qui a produit la correction la plus importante du chantier.

`TopBar.tsx` ne rendait pas le déclencheur de recherche globale sous 992 px. Le seul autre point
d'entrée de la palette étant `Ctrl+K`, **la recherche globale était inatteignable sur un
téléphone**. Le correctif conditionne la *forme* et non la *présence* : bouton-icône 44×44 sous
992 px, faux champ « Rechercher… Ctrl K » au-dessus.

> **Un `{!isMobile && …}` autour d'une action est un défaut, sauf si cette action est redonnée
> ailleurs.** Deux masquages du TopBar sont légitimes et ne doivent PAS être « corrigés » : le
> titre de page (redonné par `PageHeader`) et le nom d'utilisateur (redonné par l'entrée `who`
> du menu utilisateur).

---

## 5. Comment vérifier une page

### La mesure

```js
const de = document.documentElement;
({ sw: de.scrollWidth, vw: de.clientWidth, ovf: de.scrollWidth > de.clientWidth + 1 })
```

`ovf: true` = la page est en échec. À exécuter après un **chargement complet** à la largeur
cible, pas après un redimensionnement à chaud.

### Deux pièges de l'outillage, à connaître

1. **Neutraliser les transitions avant de mesurer.** Le navigateur piloté ne fait pas avancer
   `requestAnimationFrame` : les transitions CSS ne s'achèvent jamais et figent les éléments à
   leur largeur de premier rendu. Sur les deux tableaux de bord, `react-grid-layout` mesurait
   ainsi 1280 px au lieu de 328 — et laissait croire à un bug qui n'existe pas.

   ```js
   const s = document.createElement('style');
   s.textContent = '*,*::before,*::after{transition:none!important;animation:none!important}';
   document.head.appendChild(s);
   ```

2. **Ne pas se fier aux captures d'écran** de ce navigateur sous viewport émulé : elles répètent
   le viewport en mosaïque (vérifié avec des repères de position). Ce qui ressemble à du contenu
   coupé au bord droit est une limite de tuile. **La mesure DOM fait foi.**

### Non-régression desktop

Empreinte géométrique de toute la page, à comparer avant / après :

```js
let acc = '';
for (const e of document.querySelectorAll('body *')) {
  const r = e.getBoundingClientRect();
  if (r.width || r.height) acc += e.tagName + '|' + Math.round(r.width) + 'x' + Math.round(r.height) + ';';
}
let h = 5381; for (let i = 0; i < acc.length; i++) h = ((h * 33) ^ acc.charCodeAt(i)) >>> 0;
h.toString(36);
```

Hachage identique = mise en page identique, au pixel près.

---

## 6. Ce qui a été fait après la première passe, et ce qui reste

### Fait

| Sujet | Où |
|---|---|
| **Modales en pourcentage** (70 / 88 / 94 %) → objet responsive `{ xs: '100%', md: … }` | `FicheImputationModal`, `MailViewer`, `acquisition` |
| **Visionneuse PDF** : ajustement initial à la largeur sous 768 px ; rail de vignettes en calque | `PdfViewer.tsx`, `pdf-viewer.css` |
| **Colonnes d'actions épinglées** (`fixed: 'right'`) | `BulkRefPage` (3 pages), `MailRefPage` (4), `TypeSecurityPage` (2) |
| **Widgets empilés sous 768 px**, react-grid-layout non monté | `GrilleWidgets.tsx` |
| **Infobulles atteignables au doigt** | `InfoTooltip.tsx` + 7 sites |

### Reste

| # | Sujet | Pourquoi ce n'est pas fait |
|---|---|---|
| 1 | **Colonnes secondaires en `responsive: ['md']`** avec report dans une ligne dépliable, sur les tableaux les plus denses | Les colonnes d'actions sont maintenant épinglées, donc atteignables sans défiler toute la ligne — le point douloureux est traité. Réduire le nombre de colonnes visibles reste un confort, et demande de concevoir le repli pour que **rien ne disparaisse** (`expandable`). À faire tableau par tableau, pas en masse. |
| 2 | **`documents-scannes:151`** — formats acceptés portés par une infobulle sur le bouton d'un `<Upload>` | Y ajouter un déclencheur au clic entrerait en conflit avec l'action du bouton, et rendre les formats visibles ajouterait une ligne à l'en-tête, donc une régression desktop. L'attribut `accept` de l'`Upload` contraint déjà le sélecteur de fichiers aux mêmes formats : l'information n'est pas perdue, elle est appliquée. |
| 3 | **Les 3 modales en pourcentage n'ont pas été ouvertes** à 360 px | Seule `MailViewer` l'a été (mesurée : 344 px en mobile, 1126 px = 88 % en desktop). Les deux autres sont corrigées par le même mécanisme, vérifié dans la source d'AntD, mais non exercées. |

### Décidé de NE PAS faire : `overflow-x: clip` sur `.da-page`

Ce « filet de sécurité » était prévu en dernier lot. **Il n'a pas été posé, et c'est délibéré.**

Son effet est de faire disparaître tout débordement horizontal résiduel. Mais un débordement
clippé n'est pas un débordement corrigé : le contenu qui dépasse devient **inatteignable**,
silencieusement — alors qu'un débordement laissé visible reste, lui, accessible en faisant
défiler la page. Poser `clip` reviendrait donc à échanger un défaut visible et corrigeable
contre une perte d'information invisible, en contradiction directe avec la règle « rien ne
disparaît sur mobile » (§4).

Il rendrait aussi impossible la vérification décrite au §5 : `scrollWidth === clientWidth`
deviendrait vrai partout, y compris sur une page cassée.

Les 57 routes passant la mesure sans lui, il n'a aucun bénéfice actuel — seulement le coût
d'un futur défaut rendu muet. Si un besoin de filet se fait sentir, la bonne réponse est un
test automatisé qui MESURE `scrollWidth` sur les routes, pas une règle CSS qui le masque.

## 7. Mémo pour une nouvelle page

1. Aucun préfixe Tailwind responsive. Media query dans `globals.css`, ou `xs/sm/md/lg` sur les `Col`.
2. Aucune largeur en px sans `maxWidth` ou `min()`. Jamais de `window.innerWidth`.
3. Tout `<Table>` a `scroll={{ x: 'max-content' }}` ou un wrapper `overflowX: 'auto'`.
4. Tout `TableSkeleton` hérite déjà du `minmax(0, 1fr)` — ne pas le recopier autrement.
5. Toute action masquée sous un palier est redonnée ailleurs, sinon elle n'est pas masquée.
6. Ouvrir les modales, tiroirs et popovers pour les mesurer : leur débordement est invisible à
   `scrollWidth`.
7. Mesurer à 360 px **et** revérifier à 1280 px avant de considérer la page terminée.
