---
version: 1
slug: "app-components-authshell-tsx"
primary_target: "app/components/AuthShell.tsx"
related_targets: ["app/theme/tokens.ts","app/globals.css","app/components/TopBar.tsx","app/components/RefLayout.tsx"]
---

## Scope

L'application DocuPro entière : chrome (rails, barre supérieure, palette de commandes), listes de travail, formulaires et référentiels. Mode : Operate.

## Audience et tâche

Agents du quotidien (sessions longues, tableaux denses, saisie) et direction/valideurs (lecture rapide, parfois projetée), à parts égales. Tâche : retrouver son écran, lire une liste, repérer ce qui est en retard, agir.

## Contraintes

Ant Design 5 + Tailwind, chaîne `theme/tokens.ts` → `antdTheme.ts` → `globals.css`. Routes, libellés métier, droits par rôle (`menuKeys`) et contrats d'API inchangés. Logo DocuPro et co-branding de l'écran de connexion conservés. Mode sombre désactivé.

## Direction contract

THESIS: La ligne numérotée du registre du courrier est l'unité de travail de DocuPro : le tableau le plus lisible possible. Refuse le back-office à cartes d'indicateurs et au menu accordéon de soixante entrées.

OWN-WORLD: Toile vert bouteille `#0E3B2E` pour le rail des modules et les actions primaires ; fond papier teinté vert `#EFF4F0` ; papier blanc ; réglure bleu-gris `#C6D3DF` ; rouge de marge `#B3261E` réservé au double filet et au retard. Archivo : texte en largeur normale, en-têtes de colonne en capitales étroites, chiffres tabulaires. Coins nets (4 à 6 px), aucune ombre de carte, états en pastille + texte.

STORY: L'agent retrouve son écran par geste (Traiter, Suivre, Expédier), lit la liste d'un coup d'œil et voit en rouge ce qui est en retard, à toutes les largeurs ; le décideur lit en tête de liste le total et les retards de la page.

FIRST VIEWPORT: Rail vert de 80 px (modules) ; panneau de 216 px (écrans du module groupés par geste, compteurs) ; barre fine (fil d'Ariane, recherche Ctrl K, cloche) ; titre 30 px ; tête de liste (total, retards de la page en rouge) ; tableau à marge numérotée, délai écrit à côté de chaque date butoir ; pied de totaux et folio. L'action primaire verte, quand l'écran en a une, se place en haut à droite.

FORM: Registre du courrier à colonnes, 1er de la liste ordonnée ; seed:20c1f4012e990deb. Signature : la marge numérotée à gauche d'un double filet rouge, et le pied de totaux reportés.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Écarts assumés par rapport à la maquette choisie

- La bande récapitulative à quatre chiffres (En cours, En retard, Échéance, Urgents) n'est pas construite : l'API n'expose pas ces compteurs et ses contrats sont figés. La tête de liste porte les chiffres réellement disponibles.
- Le sens (Arrivée, Départ, Interne) reste une colonne, il n'est pas replié en lettre dans la marge : le format réel du numéro d'enregistrement n'est pas garanti.
- Ni étiquette « Urgent » ni colonne « Imputation » : la liste réelle n'a pas ces champs.

## Décisions ouvertes

- Regroupement par geste des écrans de Docu-Archives et Docu-Flow : libellés de groupe à valider par le propriétaire du produit.
- Référentiels (traité le 2026-11-22) : tableaux bord à bord dans leur carte et échec de chargement affiché comme tel, via `RefLayout`. Reste à contrôler avec de vraies données : les référentiels arborescents (plan de classement, dossiers, géolocalisation, organigrammes) et ceux à filtre (entités externes, éléments des listes).
- Gabarits d'e-mails et exports (`packages/mailer`, `packages/exports`) : hors de ce chantier.
