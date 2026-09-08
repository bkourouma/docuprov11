# Prompt — Porter le design system « Atelier d'archives » sur une autre application

> Copiez tout ce qui suit (à partir de la ligne `---`) dans l'agent qui travaille sur
> l'application cible. Le prompt est autoportant : il ne nécessite aucun accès au dépôt
> DocuPro-V6.

---

# MISSION

Tu vas appliquer un design system existant, nommé **« Atelier d'archives »**, à **toutes les
pages** de cette application. La spécification complète est donnée plus bas — elle fait
autorité. Ta tâche n'est **pas** d'inventer un style : c'est de **porter fidèlement** celui-ci
en l'adaptant à la stack réellement utilisée ici.

Contrainte principale : **zéro valeur en dur dans les pages**. Tout passe par une couche de
tokens unique, puis par des composants partagés. Si tu écris `#1668C5` ailleurs que dans le
fichier de tokens, tu t'es trompé.

---

## PHASE 0 — Audit (obligatoire, avant toute écriture)

Ne modifie rien tant que tu n'as pas répondu à ces questions, en lisant le code :

1. **Framework & langage** : React / Vue / Angular / Svelte / Blazor / Rails / Django / Laravel /
   HTML statique ? TypeScript ou non ?
2. **Bibliothèque de composants UI** déjà présente : Ant Design, MUI, Chakra, shadcn/ui,
   Mantine, Bootstrap, Tailwind seul, Element Plus, Naive UI, Vuetify, PrimeNG/PrimeVue,
   Angular Material, Radix, ou aucune ?
3. **Système de style** : CSS Modules, Sass, Tailwind, CSS-in-JS (emotion/styled-components),
   fichiers CSS globaux, styles inline ?
4. **Bibliothèque d'icônes** actuelle et son mode d'import.
5. **Chargement des polices** : `next/font`, `@font-face`, `<link>` Google Fonts, CDN, aucune ?
6. **Inventaire des pages/écrans** : liste-les toutes (chemin de fichier + rôle). C'est ton plan
   de travail pour la Phase 5.
7. **Y a-t-il déjà un mode sombre ?** Par quel mécanisme (classe, attribut, media query) ?
8. Existe-t-il déjà des composants partagés (en-tête de page, carte, état vide, badge) ?

**Restitue cet audit sous forme de tableau court, puis annonce ton plan d'adaptation** (quelle
couche de tokens, quel mécanisme de thème, quels composants créés vs. adaptés). Attends
la validation avant d'attaquer la Phase 1 **uniquement si le plan implique de remplacer une
bibliothèque UI existante** ; sinon, enchaîne.

### Règle d'adaptation

| Situation | Ce que tu fais |
|---|---|
| L'app utilise déjà **Ant Design v5** | Portage à l'identique : `ConfigProvider` + `theme.token` / `theme.components`, `cssVar: true` |
| L'app utilise **une autre lib UI** (MUI, Chakra, Vuetify, PrimeVue, Element…) | Tu **gardes cette lib** et tu traduis les tokens dans SON système de thème (`createTheme`, `extendTheme`, variables SCSS, presets…). Tu ne la remplaces jamais. |
| L'app utilise **Tailwind seul / shadcn** | Tokens en variables CSS sur `:root`, exposés dans `tailwind.config` (`theme.extend.colors`, `borderRadius`, `fontFamily`) |
| L'app n'a **aucune lib** | Variables CSS `:root` + une petite feuille de primitives (bouton, champ, carte, tableau) |
| Stack **non-JS** (Blazor, Rails, Django, Laravel, PHP) | Variables CSS + partials/composants serveur (layout, en-tête de page, carte). Le mouvement devient de simples transitions CSS. |

Si une exigence de la spec est **techniquement impossible** dans la stack cible, implémente
l'équivalent le plus proche et **signale-le explicitement** dans ton rapport final. Ne l'abandonne
pas en silence.

---

## PHASE 1 — La couche de tokens (source de vérité unique)

Crée **un seul fichier** de tokens (`theme/tokens.*`, `_tokens.scss`, `tokens.css`… selon la
stack) contenant exactement ces valeurs.

### Couleurs — mode clair

```
/* Primaire « Bleu roi » — actions, navigation active, focus */
primary:        #1668C5
primaryHover:   #2E7FDB
primaryActive:  #0F5099
primarySoft:    #E6F0FB   /* remplissage discret : survol nav, sélection, badges */

/* Accent « Ocre manille » — identité, structure, jalons */
accent:         #9A5A23   /* version assombrie, lisible en texte sur fond clair (WCAG AA) */
accentStrong:   #B26B2E   /* teinte de marque : remplissages et bordures */
accentSoft:     #F4E9DB
accentBorder:   #E4C9A6

/* Neutres — légèrement verdâtres, jamais gris purs */
bgLayout:       #F6F7F6   /* fond de page */
bgContainer:    #FFFFFF   /* cartes, sider, header */
bgElevated:     #FFFFFF   /* modales, popovers */
border:         #E3E6E4
borderSecondary:#EDEFEE
text:           #101413
textSecondary:  #5B635F
textTertiary:   #8A918D
textQuaternary: #B6BBB8

/* Sémantique */
success: #2F7A4F   successSoft: #E6F2EB
warning: #B7791F   warningSoft: #F8EFDD
danger:  #C0392B   dangerSoft:  #FBE9E7
info:    #1668C5

/* Panneau de marque (login, splash) — dégradé bleu roi */
brandBgFrom: #1668C5   brandBgTo: #0F5099
onBrand:     #EAF1FB   onBrandMuted: #BFD2EE
```

### Couleurs — mode sombre (obligatoire)

```
primary: #4F9BE8   primaryHover: #6FB0EF   primaryActive: #3D7FC4   primarySoft: #16263F
accent:  #D89A5E   accentStrong: #CE8E4E   accentSoft:  #2A2017     accentBorder: #5C4628
bgLayout: #0A0E16  bgContainer: #121823    bgElevated: #161E2B
border:  #262F3D   borderSecondary: #1C2433
text: #E6EAF2      textSecondary: #9BA4B4  textTertiary: #757E8E    textQuaternary: #525A6A
success: #4FAE78 (#13241B)   warning: #D6A33F (#2A2113)   danger: #E06A5C (#2A1714)   info: #4F9BE8
brandBgFrom: #123A66   brandBgTo: #070C12
```

**Règle d'or non négociable sur l'ocre** : il sert aux **remplissages, bordures et badges** —
**jamais** à du petit texte sur fond clair (contraste insuffisant). Seule la variante `accent`
(#9A5A23) est autorisée en texte.

### Rayons, espacement, typographie

```
radii:   sm 6  ·  base 8  ·  lg 12  ·  xl 16  ·  pill 999      (jamais de rayon 0)
space:   xs 4 · sm 8 · md 12 · lg 16 · xl 24 · xxl 32 · xxxl 48   (base 4 px)
fontSize: xs 12 · sm 13 · base 14 · md 16 · lg 20 · xl 24 · xxl 32
hauteur de contrôle : SM 28 · base 36 · LG 44
```

### Ombres — douces, à deux couches, jamais lourdes

```
card:    0 1px 2px rgba(16,20,19,.04), 0 1px 3px rgba(16,20,19,.06)
raised:  0 2px 8px rgba(16,20,19,.08), 0 1px 3px rgba(16,20,19,.05)
popover: 0 6px 16px rgba(16,20,19,.10), 0 3px 6px rgba(16,20,19,.06)
modal:   0 18px 48px rgba(16,20,19,.18), 0 8px 16px rgba(16,20,19,.10)
/* Sombre : rgba(0,0,0,.30 → .50), mêmes rayons */
```

### Mouvement

```
durées (s) : micro .14 (hover/press) · standard .22 · enter .32 (écrans, listes)
courbes    : out [0.16, 1, 0.3, 1]   ·   inOut [0.65, 0, 0.35, 1]
ressort    : stiffness 300, damping 30
stagger    : 0.045 s entre items d'une liste
```

Philosophie : **le mouvement sert la compréhension (continuité, feedback, hiérarchie), jamais la
décoration.** `prefers-reduced-motion: reduce` doit être respecté globalement.

### Tuiles de synthèse (bandeaux de KPI) — dégradés pleins, texte clair

```
Décoratives :  ink    #1668C5 → #0B4E93 (texte #FFF / #CFE1F7)
               sky    #DCEBFB → #C7DFF7 (texte #0F3E6E / #3E6690)
               violet #6E5BC6 → #4E3F9E (texte #FFF / #DAD3F5)
               coral  #E8794F → #C85A32 (texte #FFF / #FBDCCB)

Sémantiques :  success #2F7A4F → #1F5C3A   warning #B7791F → #8F5D14
               danger  #C0392B → #96271C   info    #1668C5 → #0B4E93
```

Deux familles **distinctes et non interchangeables** : les décoratives pour un chiffre qui ne
porte pas de statut, les sémantiques pour un chiffre qui en porte un (retards, alertes, files).
Ne jamais utiliser une teinte décorative pour signaler une erreur.

### Mécanisme de thème

- Les tokens doivent être exposés en **variables CSS** (pas seulement en objets JS), afin que le
  CSS sur-mesure puisse les consommer. Si la lib UI le propose (AntD `cssVar: true`, MUI
  `cssVariables`), active-le.
- Bascule clair/sombre par **attribut sur `<html>`** (`data-theme="light" | "dark"`) ou classe,
  selon la convention de la stack. Persiste le choix (localStorage) et respecte
  `prefers-color-scheme` au premier chargement.
- Préfixe tes variables sur-mesure de manière cohérente (ex. `--ds-*`) pour les distinguer de
  celles de la lib UI.

---

## PHASE 2 — Icônes : **Lucide**, via une map sémantique

1. Installe **`lucide`** dans la variante adaptée : `lucide-react`, `lucide-vue-next`,
   `lucide-angular`, `lucide-svelte`, ou les SVG bruts (`lucide-static`) pour une stack serveur.
2. Crée **un fichier de map unique** (`theme/icons.*`). **Interdiction absolue d'importer Lucide
   directement dans une page.** Une icône = un sens, cohérent dans toute l'app ; le nom de la clé
   décrit le **sens métier**, pas le glyphe.
3. Réglages optiques par défaut : **`size: 18`, `strokeWidth: 1.75`**.
   Variantes : 16 px dans les boutons, 22 px dans l'en-tête de page, 14 px dans un titre de
   section, 13 px (`strokeWidth: 2`) dans un badge de statut.
4. Remplace **toutes** les icônes existantes de l'app. Ne laisse jamais coexister deux
   bibliothèques d'icônes.

Structure de la map (adapte les entrées au métier de l'application cible, garde la logique) :

```
Navigation     : dashboard, analytics, search, settings, inbox
Objets métier  : document, archive, folder, folderTree, mail, users, roles
Actions        : add, edit, delete, download, upload, view, filter, reset,
                 refresh, logout, lock, close, menu, command, collapse, expand
États          : validated (CheckCircle2), pending (Clock), check, alert (CircleAlert),
                 spinner (Loader2), sparkle
Direction      : chevronUp/Down/Left/Right, arrowLeft/Right
Thème          : light (Sun), dark (Moon)
```

---

## PHASE 3 — Typographie : trois familles, trois rôles

| Rôle | Police | Usage |
|---|---|---|
| **Corps** | **Geist Sans** → fallback `Inter, system-ui, -apple-system, Segoe UI, Roboto, sans-serif` | tout le texte courant, base **14 px** |
| **Display** | **Bricolage Grotesque** (500/600/700, sous-ensembles `latin` + `latin-ext`), `letter-spacing: -0.01em` | **titres uniquement**, usage parcimonieux — via une classe dédiée `.ds-display` |
| **Mono** | **Geist Mono** → `ui-monospace, SFMono-Regular, Consolas, monospace`, `font-variant-numeric: tabular-nums` | références, identifiants, codes, numéros de pièce — via `.ds-mono` |

- Charge les polices avec `display: swap` (ou l'équivalent de la stack) pour éviter le FOUT.
- Applique `font-variant-numeric: tabular-nums` à **toutes les cellules de tableau** : c'est ce
  qui donne l'alignement net des colonnes chiffrées.
- `-webkit-font-smoothing: antialiased` et `text-rendering: optimizeLegibility` sur `body`.
- Titre de page : **26 px, `line-height: 1.2`**, famille display.

---

## PHASE 4 — Composants partagés (à créer avant de toucher aux pages)

Crée ces primitives dans un dossier `components/` (ou l'équivalent). Chaque page les consomme :
aucune page ne redéfinit sa propre mise en page d'en-tête ou son propre état vide.

### 4.1 `PageHeader` — en-tête de page, présent sur **toutes** les pages

- Fil d'Ariane optionnel, 13 px, marge basse 10 px
- Badge d'icône **44 × 44 px, rayon 12 px**, fond `primarySoft`, glyphe primaire 22 px
- Titre en famille display, 26 px, marge nulle
- Description optionnelle, couleur `textSecondary`, largeur max 720 px
- Zone d'actions à droite, qui **passe sous le titre en mobile** (empilement sous le point
  de rupture `sm`)
- Entrée animée `fadeUp` (opacité 0 → 1, `y: 8 → 0`, durée .32 s)
- Marge basse 24 px

### 4.2 `FormSection` — découpe des formulaires longs

- Séparateur horizontal au-dessus (sauf pour la première section)
- Badge d'icône **26 × 26 px, rayon 8 px**, fond `primarySoft`, glyphe 14 px
- Titre en texte **gras** (pas un `h2`), description optionnelle 12 px `textSecondary`
- Aucun formulaire de plus de ~6 champs ne doit rester une grille indifférenciée : on le
  découpe en groupes logiques.

### 4.3 `EmptyState` — état vide

Icône, titre, description, **et toujours une action**. Centré, `gap: 12`, padding `52px 24px`
(ou `28px 16px` en variante compacte), entrée `fadeUp`.
**Ton de la voix : jamais d'excuse — on dit quoi faire ensuite.**

### 4.4 `StatusBadge` — vocabulaire de statut unique

Une pastille (`Tag`) rayon 6 px, padding horizontal 8 px, icône 13 px `strokeWidth: 2`, couleur
sémantique. Un statut = un libellé = une couleur = une icône, **partout dans l'app**. L'état
« en cours » fait tourner son icône (`animation: spin 1s linear infinite`).

### 4.5 `StatTile` / `CountBadge`

- `StatTile` : tuile à dégradé plein (palette Phase 1), grand chiffre, libellé, indice
  optionnel, icône, cliquable. Réservée aux **bandeaux de KPI d'accueil**.
- `CountBadge` : pastille pleine primaire (mono, gras, rayon 999, hauteur 26 px, min-width 30 px)
  + libellé, pour les en-têtes de carte du type « 12 résultats ».
- Une carte blanche neutre (`KpiCard`) reste la norme pour les chiffres dans les tableaux et
  files de travail : ne transforme pas une donnée décorative en signal de statut.

### 4.6 Squelettes de chargement

Jamais de spinner plein écran sur une page de contenu : squelettes aux dimensions réelles du
contenu attendu (tableau, carte, liste), puis fondu vers le contenu.

---

## PHASE 5 — Passe sur toutes les pages

Traite les pages **une par une**, dans l'ordre de l'inventaire de la Phase 0. Pour chacune :

### Structure

- Conteneur de page : padding **24 px** (**28 px vertical / 32 px horizontal ≥ 768 px**),
  largeur max **1600 px centrée** au-delà de 1600 px de viewport (généreuse, pour ne pas gêner
  les tableaux larges).
- Fond de page `bgLayout`, cartes en `bgContainer` rayon **12 px** avec l'ombre `card`.
- Shell applicatif : barre latérale `bgContainer` à gauche (items 40 px, rayon 8, marge
  horizontale 8, sélection en `primarySoft` avec texte primaire, icônes 18 px, titres de groupe
  11 px `textTertiary`), barre supérieure **60 px** avec padding `0 24px`, contenu sur
  `bgLayout`. En mobile, la barre latérale devient un tiroir.

### Formulaires — **format imposé**

- **Libellé au-dessus du champ** (`layout="vertical"` en AntD, équivalent ailleurs). Jamais de
  libellés à gauche.
- Marqueur de champ obligatoire **activé**.
- Grille : gouttière **16 px** (`[16, 16]`), et **2 colonnes en desktop, 1 en mobile** —
  `xs={24} md={12}` en AntD, `col-12 col-md-6` en Bootstrap, `grid-cols-1 md:grid-cols-2` en
  Tailwind. C'est le motif dominant ; réserve la pleine largeur aux champs longs (objet,
  description, zones de texte).
- Contrôles : hauteur **36 px**, rayon **8 px**, **pas d'ombre au focus** (l'anneau de focus
  suffit).
- **Signature visuelle à reproduire** : les champs de saisie (`Input`, `Select`, `DatePicker`,
  `InputNumber`, sélecteurs arborescents…) portent une **bordure primaire bleue en permanence**,
  pas seulement au survol. **Cette surcharge s'applique au niveau du composant de saisie
  uniquement** — elle ne doit jamais bleuir les bordures des cartes, tableaux ou séparateurs.
- Messages de validation explicites et rédigés (« L'objet est obligatoire »), pas « Champ requis ».

### Tableaux

- En-tête sur fond `bgLayout`, texte `textSecondary`, **pas de séparateur vertical d'en-tête**,
  rayon 8 px sur l'en-tête, `font-weight: 600` pour le texte fort
- Bordures en `borderSecondary`, survol de ligne en `primarySoft`
- Padding vertical de cellule **12 px**, chiffres tabulaires
- Édition en ligne « cliquer pour modifier » lorsque pertinent : soulignement pointillé et crayon
  discret au survol, flash de fond ocre pâle 1,4 s après enregistrement
- Pages de référentiel (CRUD simple) : patron commun — tableau à gauche (~62 % de largeur), carte
  « Nouvel élément » à droite en desktop ; en mobile, la carte devient un tiroir déclenché par un
  bouton « + ».

### Boutons et éléments divers

- Boutons : hauteur 36 px, `font-weight: 500`, rayon 8, **aucune ombre** (ni primaire ni par
  défaut), icône 16 px à gauche du libellé
- Onglets : barre d'encre primaire, padding `10px 0`, taille de titre 14 px
- Segmented / groupes : fond de piste `bgLayout`, élément sélectionné en `bgContainer`
- Modales : rayon 12 px, titre 20 px, en-tête sans fond propre
- Pastilles / tags : rayon 6 px, fond `bgLayout`, texte `textSecondary` par défaut

### Langue et formats

Conserve la langue de l'application cible. Applique systématiquement le formatage **local**
(`Intl`) : séparateurs de milliers, dates, pourcentages, tailles en octets. Les libellés d'état
et les messages doivent employer un **vocabulaire unique** dans toute l'app (un même état ne se
dit jamais de deux façons différentes).

### Accessibilité (non négociable)

- **Anneau de focus visible partout** : `outline: 2px solid <primary>`, `outline-offset: 2px`,
  sur `a, button, [role=button], input, select, textarea, [tabindex]` en `:focus-visible`
- Contraste AA minimum sur tout texte (c'est la raison d'être de l'ocre assombri)
- `prefers-reduced-motion: reduce` → animations et transitions ramenées à `0.01ms`, opacité
  conservée, `scroll-behavior: auto`
- Barres de défilement fines et discrètes (`scrollbar-width: thin`, pouce en couleur `border`,
  rayon 999, bordure transparente de 3 px)
- Couleur de sélection de texte : primaire à 22 % d'opacité

---

## PHASE 6 — Vérification et rapport

1. **Lance l'application** et parcours **chaque page** de l'inventaire, en clair **et** en sombre.
2. Vérifie explicitement : aucune régression fonctionnelle, aucune icône de l'ancienne
   bibliothèque restante, aucun `#rrggbb` en dur hors du fichier de tokens, aucune police non
   déclarée, focus visible au clavier sur chaque page, rendu correct en largeur mobile.
3. Fais tourner le linter / la vérification de types / les tests du projet. Corrige ce que tu
   casses.
4. **Rapport final**, court et factuel :
   - tableau page par page : traitée ✅ / partielle ⚠️ / non traitée ❌ + raison
   - liste des exigences de la spec **non implémentables** dans cette stack, avec l'équivalent
     retenu
   - liste des fichiers créés et des fichiers modifiés
   - ce qui reste à faire, s'il reste quelque chose

Si une page est bloquée (dépendance externe, composant tiers non thématisable), **termine toutes
les autres** et signale-la — ne réduis pas le périmètre de ton propre chef.

---

## ANTI-PATRONS — ce qui invalide le travail

- ❌ Une couleur, un rayon ou une taille de police en dur dans une page
- ❌ Deux bibliothèques d'icônes coexistantes, ou un import direct de Lucide hors de la map
- ❌ Des libellés de formulaire à gauche du champ
- ❌ Des ombres marquées, des dégradés hors des tuiles de KPI, des rayons à 0
- ❌ De l'ocre en petit texte sur fond clair
- ❌ Une page sans `PageHeader`, ou un en-tête réinventé localement
- ❌ Un état vide sans action proposée
- ❌ Une animation décorative qui n'aide pas à comprendre l'interface
- ❌ Un mode sombre partiel (des zones restées claires)
- ❌ Remplacer la bibliothèque UI existante de l'application au lieu de la thématiser

## Ordre de travail

Phases 0 → 6, dans l'ordre. Ne commence la Phase 5 (les pages) qu'une fois les tokens, les
icônes, les polices et les composants partagés en place : sinon tu réécriras tout deux fois.
