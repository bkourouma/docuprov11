# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Deux publics servis à parts égales (confirmé par le propriétaire du produit le 2026-11-22) :

- **Agents du quotidien** — bureau d'ordre (enregistrement du courrier arrivée/départ, imputation),
  opérateurs de numérisation (acquisition par lot, intercalaires QR), archivistes (cycle de vie,
  DUA, prêt et communication de documents). Longues sessions au poste, tableaux denses, saisie
  répétée.
- **Direction et valideurs** — tableaux de bord, parapheur, validation, suivi des échéances.
  Usage court, lecture rapide, parfois en réunion ou en vidéoprojection.

Les administrateurs (paramétrage, rôles, sécurité documentaire) sont un troisième public,
occasionnel. *(Déduit du code et de `docs/OVERVIEW-APPLICATION.md`.)*

## Product Purpose

DocuPro est une GED / SAE (gestion électronique de documents et système d'archivage
électronique) qui réunit dans une seule interface :

- **Docu-Archives** — numérisation de masse par intercalaires QR, indexation, recherche plein
  texte, export, cycle de vie documentaire (DUA, sorts finaux, épuration), prêt et communication.
- **Docu-Courriers** — bureau d'ordre : enregistrement, imputation, parapheur, suivi des
  échéances, validation, décharges, recherche du fonds courrier.
- **Docu-Flow** — workflows (boîte de tâches, conception, suivi, plafonds des agents).
- GED collaborative : espaces, éditeur, connecteurs, recherche IA, gouvernance, assistant.

Réussite : un agent traite son flux sans se perdre ; un décideur lit l'état du fonds et des
échéances d'un coup d'œil.

## Positioning

Du papier à la preuve dans un seul outil : un intercalaire QR sépare les liasses, le lot scanné
est découpé, lu par OCR et indexé, puis le binaire est scellé (empreinte SHA-256, cachet
Ed25519) et suivi jusqu'à son sort final ; le même outil tient le registre du courrier, de
l'arrivée à la décharge. *(Déduit du code ; à confirmer comme formulation commerciale.)*

## Operating Context

- Administrations et organismes francophones ; instance actuelle co-brandée pour l'AGEF
  (Agence de Gestion Foncière).
- Postes de bureau en premier ; un chantier mobile-first a été mené (`docs/AUDIT-MOBILE.md`).
- Vocabulaire métier à conserver tel quel : courrier arrivé / départ, imputation, parapheur,
  décharge, DUA, sort final, épuration, intercalaire, cote, plan de classement, fonds.
- Interface entièrement en français.

## Capabilities and Constraints

- Environ 80 écrans répartis en sept sections de menu ; menus filtrés par rôle (`menuKeys`).
- Stack figée : Next.js 15, React 19, Ant Design 5, Tailwind 3. Chaîne de thème unique
  `app/theme/tokens.ts` → `antdTheme.ts` → `globals.css` (variables `--da-*`).
- Mode sombre désactivé dans l'application.
- Une refonte visuelle ne modifie ni les fonctionnalités, ni les routes, ni les textes métier,
  ni les contrats d'API.

## Brand Commitments

- Nom **DocuPro** et logo existant (`public/DocuPro.png`) conservés.
- Co-branding par instance (`app/theme/client-brand.ts`) conservé sur l'écran de connexion.
- **Non engageant** (confirmé le 2026-11-22) : l'habillage « Plus Admin » actuel — bleu roi,
  Open Sans, cartes plates. Couleurs, typographie, formes et mise en page sont libres.

## Evidence on Hand

- Logos : `public/DocuPro.png`, `public/logo_AGEF.png`.
- Documentation fonctionnelle : `docs/OVERVIEW-APPLICATION.md`, guides utilisateur dans `docs/`.
- Défauts de l'interface actuelle nommés par le propriétaire du produit (2026-11-22) : aspect
  « template » générique ; hiérarchie et lisibilité insuffisantes ; finition et modernité
  inégales ; navigation lourde (menu latéral d'une soixantaine d'entrées).
- Absent : captures d'écran de référence, témoignages, chiffres d'usage — ne pas en inventer.

## Product Principles

1. L'essentiel d'un écran se lit du premier coup d'œil, à un poste de saisie comme en projection.
2. Un outil d'archives et de courrier, reconnaissable comme tel — pas un back-office générique.
3. On retrouve son écran sans parcourir soixante entrées de menu.
4. La finition est la même sur tous les écrans, du tableau de bord au référentiel le plus rare.
5. La forme change, le métier non : mêmes fonctions, mêmes mots, mêmes parcours.

## Accessibility & Inclusion

Contrastes WCAG AA sur le texte et 3:1 sur les contrôles (règle déjà tenue par les tokens
actuels), anneau de focus visible au clavier, respect de `prefers-reduced-motion`.
