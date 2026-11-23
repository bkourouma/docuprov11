---
name: DocuPro — Registre
description: Le registre du courrier à colonnes, appliqué à toute l'application par la chaîne de thème unique.
colors:
  primary: "#0E3B2E"
  primary-hover: "#17513F"
  primary-active: "#0A2C22"
  primary-soft: "#E3EFE7"
  on-rail: "#BDD3C9"
  danger: "#B3261E"
  danger-soft: "#FBE6E3"
  success: "#0C6641"
  success-soft: "#DDF0E4"
  warning: "#8A5200"
  warning-soft: "#FCEFD3"
  info: "#2B5F7C"
  info-soft: "#E2EDF3"
  success-vivid: "#2FA36B"
  info-vivid: "#4A90B8"
  warning-vivid: "#D9902B"
  danger-vivid: "#D8473C"
  bg-layout: "#EFF4F0"
  bg-container: "#FFFFFF"
  panel-bg: "#F9FBF9"
  border: "#C6D3DF"
  border-secondary: "#D9E2EA"
  border-control: "#7C9086"
  chrome-edge: "#D2DED6"
  text: "#12201B"
  text-secondary: "#4D5E56"
  text-tertiary: "#66766E"
  text-quaternary: "#A9B5AE"
  sidebar-label: "#22332C"
  chart-1-vert: "#17855E"
  chart-2-bleu: "#2a78d6"
  chart-3-orange: "#e0752d"
  chart-4-violet: "#6250d6"
  chart-5-brun: "#a8672f"
  chart-6-sarcelle: "#1aa3a3"
  chart-7-ambre: "#b98500"
  chart-8-magenta: "#d0609a"
typography:
  display:
    fontFamily: "Archivo, system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
    fontSize: "30px"
    fontWeight: 700
    lineHeight: 1.1
    letterSpacing: "-0.01em"
    fontVariation: "'wdth' 86"
  headline:
    fontFamily: "Archivo, system-ui, sans-serif"
    fontSize: "20px"
    fontWeight: 700
    lineHeight: 1
    letterSpacing: "-0.01em"
    fontVariation: "'wdth' 86"
  title:
    fontFamily: "Archivo, system-ui, sans-serif"
    fontSize: "16px"
  body:
    fontFamily: "Archivo, system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
    fontSize: "14px"
    fontFeature: "'lnum'"
  body-sm:
    fontFamily: "Archivo, system-ui, sans-serif"
    fontSize: "13px"
  label:
    fontFamily: "Archivo, system-ui, sans-serif"
    fontSize: "11.5px"
    fontWeight: 600
    letterSpacing: "0.08em"
    fontVariation: "'wdth' 80"
  state:
    fontFamily: "Archivo, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 600
    lineHeight: 1.3
  figure:
    fontFamily: "Archivo, system-ui, sans-serif"
    fontSize: "28px"
    fontWeight: 600
    lineHeight: 1.1
    fontFeature: "'tnum', 'lnum'"
    fontVariation: "'wdth' 72"
  mono:
    fontFamily: "'Geist Mono', 'SFMono-Regular', ui-monospace, 'Cascadia Code', Menlo, Consolas, monospace"
    fontFeature: "'tnum'"
rounded:
  xs: "2px"
  sm: "3px"
  base: "4px"
  lg: "6px"
  field: "6px"
  card: "6px"
  pill: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
  xxl: "32px"
  xxxl: "48px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.bg-container}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.field}"
    height: "36px"
  button-primary-hover:
    backgroundColor: "{colors.primary-hover}"
  button-primary-active:
    backgroundColor: "{colors.primary-active}"
  button-default:
    backgroundColor: "{colors.bg-container}"
    textColor: "{colors.text}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.field}"
    height: "36px"
  input:
    backgroundColor: "{colors.bg-container}"
    textColor: "{colors.text}"
    typography: "{typography.body}"
    rounded: "{rounded.field}"
    height: "36px"
  card:
    backgroundColor: "{colors.bg-container}"
    textColor: "{colors.text}"
    rounded: "{rounded.card}"
  ref-card:
    backgroundColor: "{colors.bg-container}"
    textColor: "{colors.text}"
    rounded: "{rounded.card}"
    padding: "0"
  rail:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-rail}"
    width: "80px"
  rail-button:
    textColor: "{colors.on-rail}"
    rounded: "{rounded.lg}"
    width: "64px"
    height: "58px"
  rail-button-hover:
    backgroundColor: "{colors.primary-hover}"
    textColor: "{colors.bg-container}"
  rail-button-current:
    backgroundColor: "{colors.bg-container}"
    textColor: "{colors.primary}"
  panel:
    backgroundColor: "{colors.panel-bg}"
    textColor: "{colors.sidebar-label}"
    width: "216px"
  panel-item:
    textColor: "{colors.sidebar-label}"
    rounded: "{rounded.field}"
    padding: "7px 10px"
    height: "34px"
  panel-item-hover:
    backgroundColor: "{colors.primary-soft}"
  panel-item-selected:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.bg-container}"
  topbar:
    backgroundColor: "{colors.bg-layout}"
    textColor: "{colors.text}"
    height: "56px"
    padding: "0 16px"
  table-header:
    backgroundColor: "{colors.bg-container}"
    textColor: "{colors.text-secondary}"
    typography: "{typography.label}"
  table-row-hover:
    backgroundColor: "{colors.primary-soft}"
  margin-cell:
    backgroundColor: "{colors.panel-bg}"
    textColor: "{colors.text}"
  margin-cell-late:
    backgroundColor: "{colors.panel-bg}"
    textColor: "{colors.danger}"
  table-totals:
    backgroundColor: "{colors.panel-bg}"
    textColor: "{colors.text}"
  state-mark:
    typography: "{typography.state}"
  tile-ink:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.bg-container}"
    rounded: "{rounded.card}"
    padding: "18px 20px"
  tile-status-danger:
    backgroundColor: "{colors.danger}"
    textColor: "{colors.bg-container}"
    rounded: "{rounded.card}"
    padding: "18px 20px"
---

# Design System: DocuPro — Registre

## Overview

**Creative North Star: "Le registre du courrier à colonnes"**

L'unité de travail de DocuPro est la ligne numérotée d'un registre : un numéro d'ordre dans la marge, un double filet rouge, puis des colonnes que l'on lit d'un trait. Tout le système sert cette ligne. Le chrome est une toile vert bouteille (rail des modules) posée contre du papier (panneau des écrans, cartes, tableaux) ; la page elle-même est un papier légèrement teinté de vert. Ce qui structure est le filet, jamais l'ombre : réglure bleu-gris entre les lignes, filet d'encre sous les en-têtes et au-dessus des totaux.

La voix typographique tient à une seule famille, Archivo, dont l'axe de largeur fait le travail : largeur normale pour le texte, étroite et grasse pour les titres d'écran, étroite en capitales pour les en-têtes de colonne et les titres de groupe, très étroite pour les chiffres clés. Les états s'écrivent comme une annotation de marge — une pastille ou un glyphe, puis le mot — et le rouge n'apparaît que là où quelque chose est en retard ou en erreur. La densité est celle d'un outil de production : contrôles de 36 px, lignes de tableau resserrées, aucun sous-titre gris sous les titres d'écran.

Ce document décrit le système tel qu'il est construit dans `app/theme/tokens.ts`, `app/theme/antdTheme.ts` et `app/globals.css`. Deux limites sont à lire avec lui. Le mode sombre est désactivé dans l'application : une palette sombre existe dans `tokens.ts` pour garder la forme du thème, elle n'a pas été vérifiée à l'écran et ne fait pas partie des jetons ci-dessus. L'écran de connexion (co-branding AGEF, palette locale, carte en verre dépoli, filigrane du logo) n'a pas été repris et reste hors du système Registre. Les référentiels, eux, sont dans le système : leur tableau court bord à bord dans sa carte comme une liste de courriers et un échec de lecture s'y dit comme tel ; seuls les référentiels à arbre ou à filtre n'ont pas été vérifiés avec des données réelles.

**Key Characteristics:**
- Toile vert bouteille pour le rail et les actions primaires, papier blanc sur fond teinté de vert.
- La marge numérotée : colonne d'identifiant calée à droite, bordée d'un double filet rouge.
- Filets à la place des ombres ; coins nets de 4 et 6 px.
- Archivo en trois largeurs ; chiffres alignés et tabulaires dans les tableaux.
- États en pastille ou glyphe suivi du libellé, jamais en étiquette pleine.
- Navigation en deux temps : quatre modules dans le rail, écrans groupés par geste dans le panneau.
- Le délai est écrit à côté de chaque date butoir ; la couleur ne fait que le renforcer.
- Un même papier pour les listes de courriers et les référentiels : tableau bord à bord, échec distinct du vide.

## Colors

Une palette à une seule teinte de marque, sombre et froide, complétée par des neutres tirés vers le vert et un rouge tenu en réserve.

### Primary
- **Toile vert bouteille** (`primary`, #0E3B2E — 12,5:1 sur blanc) : fond du rail des modules, boutons primaires, liens, écran courant dans le panneau, anneau de focus, tuile principale.
- **Toile survolée** (`primary-hover`, #17513F — 9,2:1 avec du blanc) : survol des boutons primaires et des boutons du rail, fond de la pastille aux initiales sur le rail.
- **Toile pressée** (`primary-active`, #0A2C22) : état pressé.
- **Vert de sélection** (`primary-soft`, #E3EFE7) : survol et sélection d'une ligne de tableau, survol d'une entrée du panneau, tuile douce. Le blanc entre les deux filets de la marge prend cette teinte quand la ligne est survolée ou sélectionnée.
- **Encre sur toile** (`on-rail`, #BDD3C9 — 7,9:1 sur la toile) : libellés et icônes des modules non courants.

### Secondary
- **Rouge de marge** (`danger`, #B3261E — 6,5:1 sur blanc) : le double filet de la marge numérotée, et ce qui est en retard ou en erreur (numéro de marge d'une ligne en retard, délai dépassé, « n en retard sur cette page », état d'échec, tuile de statut d'alerte). Fond pâle associé : `danger-soft` (#FBE6E3).

### Tertiary
- **Vert d'état** (`success`, #0C6641 — 7,0:1), **ambre brun** (`warning`, #8A5200 — 6,4:1), **encre bleu-gris** (`info`, #2B5F7C — 6,9:1) : texte d'état, pastilles, fonds de tuile de statut à texte blanc. Chacun a son fond pâle (`success-soft`, `warning-soft`, `info-soft`). L'ambre marque une échéance à trois jours ou moins.
- **Sémantiques vives** (`success-vivid` #2FA36B, `info-vivid` #4A90B8, `warning-vivid` #D9902B, `danger-vivid` #D8473C) : surfaces sans texte uniquement — pastilles, icônes, remplissages, bordures.
- **Palette de graphiques** (`chart-1-vert` à `chart-8-magenta`) : huit teintes dans un ordre fixe — vert, bleu, orange, violet, brun, sarcelle, ambre, magenta. La couleur suit l'entité, jamais son rang. Toutes tiennent au moins 3:1 sur le papier blanc (de 3,1:1 pour la sarcelle et l'orange à 5,8:1 pour le violet). Aucune case n'est rouge. Axes et légendes à l'encre, grille en `rgba(18,32,27,0.08)`.

### Neutral
- **Papier teinté** (`bg-layout`, #EFF4F0) : fond de page et barre supérieure.
- **Papier du registre** (`bg-container`, #FFFFFF) : cartes, tableaux, en-têtes de table, champs, surfaces flottantes.
- **Papier de marge** (`panel-bg`, #F9FBF9) : panneau des écrans, cellule de marge, pied de totaux, survol d'un en-tête triable.
- **Réglure bleu-gris** (`border`, #C6D3DF) : contour des cartes, séparation des lignes de tableau. **Réglure légère** (`border-secondary`, #D9E2EA) : séparateurs internes, lignes des squelettes.
- **Bordure de contrôle** (`border-control`, #7C9086 — 3,4:1 sur blanc) : champs, sélecteurs, boutons secondaires, faux champ de recherche.
- **Filet de chrome** (`chrome-edge`, #D2DED6) : limite entre panneau, barre et page.
- **Encre** (`text`, #12201B) : texte, filet sous les en-têtes de table et au-dessus des totaux, fond des infobulles.
- **Encre secondaire** (`text-secondary`, #4D5E56 — 6,2:1 sur le fond de page) : en-têtes de colonne, titres de groupe, compteurs du panneau, fil d'Ariane, état neutre.
- **Encre tertiaire** (`text-tertiary`, #66766E — 4,8:1 sur blanc, 4,3:1 sur le fond de page) et **quaternaire** (`text-quaternary`, #A9B5AE — 2,1:1, jamais porteuse de texte utile).
- **Libellé de panneau** (`sidebar-label`, #22332C) : entrées du panneau des écrans.

### Named Rules
**La règle du rouge de marge.** Le rouge #B3261E a deux emplois et pas un de plus : le double filet qui borde la marge numérotée, et ce qui est en retard ou en erreur. Il n'est jamais décoratif, n'entre dans aucune tuile de synthèse décorative et n'occupe aucune case de la palette de graphiques.

**La règle des vives sans texte.** Les teintes `*-vivid` ne portent jamais de texte. Tout texte d'état passe par les dérivés forts (`success`, `warning`, `danger`, `info`), qui tiennent AA sur le papier blanc.

**La règle de l'ordre fixe.** Dans un graphique, une entité garde sa couleur d'un écran à l'autre : la palette se lit dans l'ordre, sans réattribution selon le classement.

**La règle de la bordure de contrôle.** Ce qu'on manipule (champ, sélecteur, bouton secondaire) se borde en `border-control` à 3,4:1 ; la réglure bleu-gris à 1,5:1 est réservée à ce qui encadre ou sépare.

## Typography

**Display Font:** Archivo variable, axes graisse et largeur (`wdth`), chargée par `next/font` dans la variable `--font-sans` ; repli `system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif`.
**Body Font:** la même Archivo, en largeur normale. `--font-display` et `--font-geist-sans` sont des alias de `--font-sans`.
**Label/Mono Font:** Geist Mono (`--font-geist-mono`) pour ce qui se recopie caractère par caractère : cotes, références, empreintes, identifiants QR.

**Character:** Une seule famille dont la largeur change de registre : normale pour lire, étroite pour titrer et pour étiqueter les colonnes, très étroite pour les chiffres clés. Les chiffres sont alignés sur la ligne de base partout, et tabulaires dans les tableaux.

### Hierarchy
- **Display** (700, 30 px, interligne 1.1, largeur 86 %, approche -0.01em) : titre d'écran, un par page, équilibré sur ses lignes. Passe à 24 px quand les actions se rangent sous le titre (sous 576 px).
- **Headline** (700, 20 px, largeur 86 %) : nombre en tête de liste (« 38 courriers »), titre de modale.
- **Title** (16 px) : titre de carte, titre du bandeau de raccourcis, titre d'un état vide.
- **Body** (14 px, chiffres alignés) : corps, cellules de tableau, libellés de formulaire, texte des champs. Les boutons et les textes d'appoint sont à 13 px (`body-sm`).
- **Label** (600, 11.5 px, largeur 80 %, capitales, approche 0.08em) : en-têtes de colonne. Les titres de groupe du panneau (Traiter, Suivre, Expédier) ont la même coupe avec une approche de 0.1em.
- **State** (600, 13 px, interligne 1.3) : libellé d'une marque d'état.
- **Figure** (600, 28 px, interligne 1.1, largeur 72 %, tabulaire) : chiffre clé d'une tuile ou d'une carte d'indicateur ; 22 px en version compacte.
- **Mono** (Geist Mono, tabulaire) : identifiants à recopier.

Petits corps observés : 12 px (libellés et indications des cartes d'indicateur), 12.5 px (compteur d'une entrée du panneau, rappel d'échéance mobile), 11 px (libellé d'un module du rail en largeur 88 %, touche « Ctrl K », étiquettes AntD — remontées à 12 px sous 768 px).

### Named Rules
**La règle de la largeur.** La hiérarchie se fait par la largeur et la graisse d'Archivo avant de se faire par la taille : étroit et gras pour titrer, étroit en capitales pour étiqueter une colonne ou un groupe, normal pour tout ce qui se lit en phrase.

**La règle des chiffres en colonne.** Tout chiffre placé dans un tableau, un compteur ou une tuile est tabulaire et aligné ; un numéro de marge est en gras et calé à droite.

**La règle du titre seul.** Un écran porte un titre et rien dessous : ni sous-titre gris, ni icône accolée. L'icône de l'écran vit dans la navigation.

## Layout

Le chrome est une suite de trois bandes fixes puis la page. À gauche, le rail des modules (80 px, toile, boutons de 64 × 58 px espacés de 6 px, menu utilisateur calé au pied) ; contre lui, le panneau des écrans (216 px, papier de marge, logo dans un bandeau fixe de 56 px, liste défilante dessous, filet de chrome à droite). Rail et panneau sont collants sur toute la hauteur. Au-dessus de la page, la barre supérieure (56 px, collante, posée sur le fond de page, un seul filet bas) : bouton de repli, fil d'Ariane module / geste / écran dont seul le dernier terme est à l'encre et en 600, faux champ « Aller à un écran » (34 px de haut, 300 px au moins, touche Ctrl K), assistant, cloche.

Le rail ne porte que quatre modules (Archives, Flow, Courriers, Réglages). Le panneau liste les écrans du module choisi, regroupés par geste (Traiter, Suivre, Expédier ; Consulter, Verser, Contrôler, Communiquer ; Concevoir, Administrer). Cliquer un module feuillette ses écrans sans quitter l'écran courant. Les compteurs sont des chiffres tabulaires alignés à droite de l'entrée, sans pastille ; leur cumul remonte en pastille blanche sur le bouton du module.

La page a une gouttière de 16 px, portée à 24 px × 28 px à partir de 768 px, et son contenu est plafonné à 1600 px, centré, à partir de 1600 px. L'en-tête de page tient dans une rangée de 36 px (la hauteur d'un bouton), titre à gauche, actions à droite, 20 px de marge dessous ; l'action primaire, quand l'écran en a une, se place en haut à droite. Les blocs s'espacent sur une échelle de base 4 (4, 8, 12, 16, 24, 32, 48). Une liste de travail ou un tableau de référentiel court d'un bord à l'autre de sa carte, sans marge intérieure. Une page de référentiel place son tableau à gauche (15 colonnes sur 24 par défaut) et la carte « Nouvel élément » à droite, avec 16 px entre les deux.

Comportement selon la largeur :
- **Sous 1300 px**, sans préférence enregistrée, le panneau démarre replié : le rail reste seul, le logo passe dans la barre, et les listes tiennent sans défilement horizontal. Cliquer un module rouvre le panneau.
- **Sous 992 px**, rail et panneau quittent la page et se rangent ensemble dans un tiroir de 296 px (80 + 216) ouvert par le bouton de menu. Le fil d'Ariane disparaît, la recherche devient un bouton-icône de 44 px, le menu utilisateur passe dans la barre. Sur une page de référentiel, le tableau prend toute la largeur et le formulaire « Nouvel élément » passe dans un tiroir à droite.
- **Sous 768 px**, seuil unique de la couche mobile : barres d'actions et en-têtes de carte se replient, onglets et sélecteurs segmentés défilent au doigt, les champs passent à 16 px (pas de zoom iOS), les étiquettes à 12 px ; au pointeur grossier, boutons et champs font au moins 44 px. Dans une liste de travail, l'en-tête de marge se réduit à « N° » (116 px au lieu de 148) et la date butoir est rappelée sous l'objet.
- **Sous 576 px**, les actions de l'en-tête de page passent sous le titre.

Aucun préfixe responsive Tailwind n'est utilisé : le responsive transverse vit dans `globals.css`, celui des composants passe par les paliers d'Ant Design.

### Named Rules
**La règle du geste.** On range un écran sous le verbe de ce qu'on y fait, pas sous sa rubrique d'administration ; le rail ne dépasse pas quatre modules.

**La règle du retard à toutes les largeurs.** Un retard reste visible quelle que soit la largeur : numéro de marge en rouge dans la colonne qui ne défile pas hors de vue, rappel sous l'objet quand la colonne de date est hors écran.

## Elevation & Depth

Le registre est plat. Aucune carte, aucun tableau, aucun bouton ne porte d'ombre : c'est le filet qui sépare et la teinte du papier qui étage (fond de page teinté, papier de marge, papier blanc). Seules les surfaces qui flottent réellement au-dessus de la page — menus, popovers, modales, tiroirs — portent une ombre douce, teintée à l'encre.

### Shadow Vocabulary
- **Aucune** (`box-shadow: none`) : cartes, tuiles, boutons, champs au focus.
- **Relevé** (`box-shadow: 0 1px 2px rgba(18, 32, 27, 0.08)`) : jeton disponible pour un léger décollement.
- **Flottant** (`box-shadow: 0 8px 24px rgba(18, 32, 27, 0.16)`) : menus déroulants, popovers, menu utilisateur.
- **Modale** (`box-shadow: 0 16px 40px rgba(18, 32, 27, 0.22)`) : modales et tiroirs.

Le double filet de la marge est dessiné en ombres internes sans flou (`inset -1px 0 0`, `inset -3px 0 0`, `inset -4px 0 0`) : c'est un tracé, pas une profondeur.

### Named Rules
**La règle du filet.** Ce qui est posé sur la page se borde ; seul ce qui flotte au-dessus d'elle porte une ombre. Une carte cliquable signale le survol par sa bordure qui passe au vert de toile, pas en se soulevant.

## Shapes

Des coins nets, sur deux valeurs. 4 px pour ce qui étiquette (badges, étiquettes, avatars carrés, anneau de focus, touche clavier) ; 6 px pour ce qu'on manipule ou qui encadre (champs, boutons, entrées du panneau, boutons du rail, cartes, tableaux, modales, menus, infobulles, alertes, tuiles). Les champs et les boutons gardent 6 px à toutes les tailles pour rester assortis quand ils sont accolés. Le cercle et la pilule (999 px) sont réservés à ce qui est rond par nature : pastille d'état de 8 px, compteur d'un module, avatar aux initiales, poignée de barre de défilement.

Les bordures font 1 px ; les deux filets d'encre du tableau (sous l'en-tête, au-dessus des totaux) font 1.5 px. La silhouette récurrente est le double trait vertical rouge : deux filets de 1 px séparés par 2 px de papier.

## Components

### Buttons
Fermes et sans relief : un aplat ou un contour, jamais d'ombre.
- **Shape:** coins nets (6 px à toutes les tailles), hauteur 36 px, libellé en 13 px et 600.
- **Primary:** fond toile (`primary`), texte blanc. Une action primaire par écran, en haut à droite.
- **Hover / Focus:** survol en `primary-hover`, pressé en `primary-active`. Focus clavier : contour de 2 px en vert de toile, décalé de 2 px, sur tout élément interactif (blanc sur le rail).
- **Secondary:** papier blanc, bordure `border-control`. Les boutons-texte de la barre supérieure prennent au survol un voile d'encre à 7 %.
- **Actions de ligne :** cible de 40 px dans une liste de travail, sans épaissir la ligne.

### Marque d'état
L'état d'une ligne se lit comme une annotation, pas comme un bouton posé dessus.
- **Style:** pastille ronde de 8 px, ou glyphe de 14 px, puis le libellé en 13 px et 600, le tout à l'encre de l'état, espacés de 8 px, sans fond ni bordure.
- **Tons:** marque (vert de toile), info, succès, alerte, danger, neutre (encre secondaire).
- **Usage:** statut et sens d'un courrier (pastille) ; état d'un document ou d'un lot (glyphe : validé, à indexer, en cours avec rotation, échec). Le libellé est toujours écrit.

### Cards / Containers
- **Corner Style:** 6 px.
- **Background:** papier blanc sur fond de page teinté.
- **Shadow Strategy:** aucune (voir Elevation & Depth).
- **Border:** réglure bleu-gris de 1 px.
- **Internal Padding:** 16 px pour une carte d'indicateur (12 px en compact) ; aucune pour une liste de travail ou une carte de référentiel, dont le tableau touche les bords de la carte.
- **Carte d'indicateur :** libellé en 12 px secondaire, chiffre en `figure`, teinte d'état optionnelle sur le chiffre ; si elle mène à un écran, sa bordure passe au vert de toile au survol (0.14 s).
- **Tuiles de synthèse :** aplat sans dégradé ni ombre, 6 px de rayon, 18 px × 20 px de marge, 108 px de haut au moins, libellé en 13 px atténué, chiffre en `figure`. Tuiles décoratives : toile, vert pâle, bleu-gris, ambre brun — réservées aux bandeaux d'accueil des tableaux de bord. Tuiles de statut : succès, alerte, danger, info à texte blanc — réservées aux chiffres qui portent un vrai sens de statut ; une tuile rouge signifie toujours un problème.
- **Bandeau de raccourcis :** bande de papier bordée, 14 px × 20 px, titre à gauche en 16 px, actions à droite ; pas d'aplat de couleur.

### Inputs / Fields
- **Style:** papier blanc, bordure `border-control` de 1 px, 6 px de rayon, hauteur unique de 36 px, texte en 14 px.
- **Focus:** contour de 2 px en vert de toile ; pas de halo.
- **Sélecteur segmenté :** piste un cran plus soutenue que la page (#DCE7E0), segment actif en papier blanc à texte vert de toile.
- **Mobile:** texte à 16 px sous 768 px ; 44 px de haut au pointeur grossier.

### Navigation
- **Rail des modules :** toile, 80 px. Bouton de 64 × 58 px, icône de 20 px au trait de 1.75, libellé court en 11 px et 600, largeur 88 %. Repos : encre sur toile. Survol : `primary-hover`, texte blanc. Courant : papier blanc, texte vert de toile. Compteur cumulé : pilule blanche de 18 px cernée de 2 px de toile, inversée sur le bouton courant.
- **Panneau des écrans :** papier de marge, 216 px. Titres de groupe en capitales étroites (11.5 px, 600, largeur 80 %, approche 0.1em). Entrée de 34 px au moins, libellé sur deux lignes plutôt que tronqué, survol en vert de sélection, écran courant en aplat de toile à libellé blanc et 600. Compteur : chiffre tabulaire de 12.5 px, sans pastille, blanc sur l'écran courant.
- **Barre supérieure :** voir Layout. Popovers portés hors de la barre.
- **Menu utilisateur :** pastille ronde aux initiales (36 px au pied du rail, 32 px dans la barre en mobile) ; le panneau s'ouvre sur l'identité en en-tête à l'encre, puis « Mon profil » et « Déconnexion ».
- **Mobile:** même rail et même panneau, rangés dans le tiroir de 296 px.

### Le registre (liste de travail)
La pièce signature du système, construite dans la liste de travail des courriers.
- **En-tête de colonne :** papier blanc, `label` en encre secondaire, souligné d'un filet d'encre de 1.5 px ; pas de séparateur vertical entre colonnes.
- **Lignes :** séparées par la réglure bleu-gris ; table de production à 7 px de garde verticale (11 px pour une table ordinaire) ; survol et sélection en vert de sélection.
- **Marge numérotée :** la colonne d'identifiant (148 px) est calée à droite, en 700, sur papier de marge, avec 18 px de retrait avant un double filet rouge. Le blanc entre les deux filets suit le fond de la ligne.
- **Date butoir :** le délai est toujours écrit à côté de la date — « 19/11/2026 · retard 3 j », « aujourd'hui », « dans 2 j ». En retard : rouge et 600. À trois jours ou moins : ambre et 600. Au-delà : date à l'encre, délai en encre secondaire. Traité ou sans date : la date seule, ou un tiret.
- **Ligne en retard :** son numéro de marge passe au rouge.
- **Tête de liste :** le total en `headline` suivi de son libellé en 500 (« 38 courriers »), puis, en rouge et 600, « n en retard sur cette page ». Le compteur garde sa place pendant le chargement.
- **Pied de totaux :** filet d'encre de 1.5 px au-dessus, papier de marge, 600 ; la cellule de marge donne le nombre de lignes de la page, la suite donne « n lignes à reporter » ou « Fin du registre ».
- **Pagination :** « Folio n sur m », avec 16 px de gouttière ; le total n'y est pas répété.
- **États de la liste :** chargement en squelette qui épouse les colonnes ; liste vide dite par un titre (« Aucun courrier ») ; échec de lecture dit comme tel (« La liste n'a pas pu être chargée ») avec un bouton « Réessayer », sans tête de liste. Un registre qui n'a pas pu être lu ne s'annonce jamais vide.
- **Largeur :** seule la colonne « Objet » est élastique (184 px garantis) ; en dessous de la somme des colonnes, le tableau défile au lieu d'écraser l'objet.

### Carte de référentiel
Le même papier que le registre, pour les tables de paramétrage.
- **Composition :** en-tête de page avec les exports Excel et PDF en boutons secondaires ; carte titrée du tableau à gauche, carte « Nouvel élément » à droite à partir de 992 px. En dessous, un bouton primaire « Nouvel élément » rejoint les actions de l'en-tête et ouvre le formulaire dans un tiroir à droite (380 px au plus, jamais plus large que la fenêtre moins 24 px).
- **Tableau :** bord à bord, la carte n'a aucune marge intérieure. La première et la dernière cellule reprennent la gouttière de 24 px de la carte, pour que le contenu tombe à l'aplomb du titre ; la pagination garde 16 px de gouttière.
- **Ce qui accompagne le tableau :** tout ce qui n'est pas le tableau retrouve sa gouttière — 16 px × 24 px autour d'un squelette, d'un état vide ou d'un état d'échec ; dans une pile verticale, 16 px au-dessus de la pile et 24 px de chaque côté de la barre de lot, du filtre ou de l'alerte.
- **États :** vide dit par « Ce référentiel est vide », avec le bouton primaire « Nouvel élément » sous 992 px ; échec de lecture dit par « Le référentiel n'a pas pu être chargé » avec un bouton « Réessayer ». Un référentiel qui n'a pas pu être lu ne s'annonce jamais vide.
- **Formulaire :** champs empilés, chacun sous un vrai libellé en 14 px placé 8 px au-dessus.
- **Non vérifié :** les référentiels à arbre et à filtre n'ont pas été contrôlés avec des données réelles.

### Squelettes et états vides
- **Squelettes :** ils reprennent la forme du contenu — colonnes de tableau, grille de cartes, zones d'un tableau de bord — avec la bordure et le rayon des vraies cartes.
- **État vide :** un titre en 16 px gras et, quand il y a quelque chose à faire, un bouton ; pas de phrase d'excuse ni de description.

### Mouvement
Le mouvement sert la continuité, jamais le décor. Trois durées : 0.14 s (survol, pressé), 0.22 s (transition courante), 0.32 s (entrée d'écran ou de liste), sur une courbe de sortie `cubic-bezier(0.16, 1, 0.3, 1)`. Les en-têtes de page et les états vides entrent en fondu avec 8 px de montée. Une ligne créée ou modifiée s'éclaire en vert de sélection pendant 1.4 s. `prefers-reduced-motion` coupe transformations et animations.

## Do's and Don'ts

### Do:
- **Do** tirer toute valeur de `app/theme/tokens.ts` ; `antdTheme.ts` et les variables `--da-*` de `globals.css` en dérivent.
- **Do** poser une liste de travail bord à bord dans sa carte, avec la colonne d'identifiant en marge numérotée (classe `da-marge`), la tête de liste et le pied de totaux.
- **Do** écrire le délai à côté de chaque date butoir et le libellé à côté de chaque pastille : la couleur renforce, elle ne porte jamais seule l'information.
- **Do** écrire un état en marque d'état (pastille ou glyphe, puis libellé à l'encre de l'état).
- **Do** border en `border-control` (3,4:1) tout ce qui se manipule, et en réglure bleu-gris ce qui encadre.
- **Do** composer un titre d'écran en Archivo étroit et gras de 30 px, un en-tête de colonne en capitales étroites de 11.5 px.
- **Do** distinguer l'échec de lecture de la liste vide, avec de quoi relancer, dans une liste de travail comme dans un référentiel.
- **Do** poser le tableau d'un référentiel bord à bord dans sa carte, première et dernière cellules alignées sur la gouttière de 24 px.
- **Do** garder l'encre tertiaire sur le papier blanc (4,8:1) ; sur le fond de page elle tombe à 4,3:1, où l'encre secondaire prend le relais.
- **Do** ranger un nouvel écran dans un groupe de geste d'un des quatre modules.
- **Do** garder les cibles tactiles à 44 px au pointeur grossier et les champs à 16 px sous 768 px.

### Don't:
- **Don't** employer le rouge #B3261E hors du double filet de marge et de ce qui est en retard ou en erreur.
- **Don't** écrire un état de ligne en étiquette pleine à texte blanc : dans une liste de cinquante lignes, cinquante pavés colorés disputent l'œil à ce qui est en retard.
- **Don't** mettre d'ombre sous une carte, une tuile ou un bouton, ni de dégradé dans un aplat.
- **Don't** faire porter du texte à une teinte `*-vivid`.
- **Don't** réattribuer les couleurs d'un graphique selon le rang, ni y ajouter une case rouge.
- **Don't** ajouter de sous-titre gris sous un titre d'écran, ni d'icône accolée à ce titre.
- **Don't** tronquer un libellé du panneau des écrans : il passe sur deux lignes.
- **Don't** annoncer « vide » un registre ou un référentiel dont le chargement a échoué.
- **Don't** remettre un tableau dans une carte à marges : le tableau est le papier, il touche les bords.
- **Don't** introduire de préfixe responsive Tailwind dans un composant : les paliers sont ceux d'Ant Design et de la couche mobile à 768 px.
- **Don't** prendre l'écran de connexion ou la palette sombre pour des modèles du système : le premier est hors périmètre, la seconde n'est pas vérifiée.
