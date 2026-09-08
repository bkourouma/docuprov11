# Relook Plus Admin — Audit UX écran par écran (phase 1, livrable 2/3)

> Méthode : chaque route de `docs/OVERVIEW-APPLICATION.md` §5 a été auditée **sur son code
> source réel** (fichiers cités par entrée). Format : constat → proposition (§6.x du PRD
> `relook.md` + prescriptions §5 applicables) → coût (S ≈ quelques heures, M ≈ 0,5-1 j,
> L > 1 j — les coûts sont agrégés par lot dans `plan.md` §7).
>
> **Amendement du 2026-09-08 (PRD §4.6 n°11)** : toute proposition ci-dessous qui ajoute ou
> corrige une **description sous un titre d'écran ou un état vide** est **caduque** — ces
> sous-titres ont été retirés de l'application, avec les props `PageHeader.description` et
> `EmptyState.description` elles-mêmes. Les `description` de `Popconfirm` (conséquence d'une
> action) restent, elles, exigées.
>
> **Amendement du 2026-09-08 (PRD §4.6 n°10)** : partout où une proposition ci-dessous prescrit
> des « champs 46 px », `size="large"` ou `componentSize="large"`, elle est **caduque** — la
> densité de champs est désormais unique, à 36 px, sur toute l'application — `/login` et
> l'invite de la palette Ctrl+K comprises. Le reste de chaque proposition (couleurs, rayons,
> libellés, densités de tables) reste valable.
>
> Couverture : 60 entrées — 100 % des routes, écrans masqués et `/design` inclus, plus les
> patrons partagés et le chrome. `/` et `/admin` sont de simples redirections sans UI (rien à
> auditer). Les coûts « hérités » (écrans portés par un patron corrigé une fois) sont marqués.

---

## 1. Hors chrome

### /login — S
Fichiers : [page](apps/web/app/login/page.tsx), BrandMark.
**Constat** : déjà proche de la cible (Form `size="large"`, bouton block, Alert d'erreur). Défauts : panneau de marque sur l'ancien dégradé `--da-brand-*` ; le motif SVG décoratif contient un ocre `#b26b2e` **en dur** (§7.2) et des rayons 5-12 px hors grille ; titres en Bricolage (`da-display`) ; tailles/espacements inline.
**Proposition** : §5 Connexion — dégradé signature `#00cff4→#0033c4` via tokens (texte toujours sur la moitié bleue), champs au gabarit commun (rayon automatique via `borderRadiusLG`), motif SVG re-teinté primaire + gris. §6.9 : focus ring visible sur le dégradé.

### /design — M
**Constat** : la galerie documente l'ancienne identité qu'elle est censée vérifier (ocre, Bricolage, tuiles, note « l'ocre travaille la structure ») ; `Swatch` à rayon 10 en dur ; il manque les surfaces exigées par §9.2 : modale, dropdown/tooltip, avatar, pilule, badges pleins AA, deux densités de table.
**Proposition** : §5 Galerie — refonte intégrale en **surface de vérification** : grille de rondeur §4.2 complète, les signatures §4.5 (6 depuis le retrait de la languette, PRD §4.6 n°8), badges AA, tables production + consultation, échelle d'espacement §6.1. Zéro valeur en dur.

### Écran d'attente d'authentification (AuthShell `!ready`) — S
**Constat** : logo + Spin sur fond non défini (hérite du body) ; aucun texte d'état — première surface vue à chaque session.
**Proposition** : §4.4 — fond `bgLayout` (`#f8f9fb`/`#111115`) par token, spinner primaire, SSR clair et reduced motion inchangés.

## 2. Docu-Archives

### /dashboards — M
Fichiers : page, PeriodFilter, widget-registry, ChartCard, GrilleWidgets, theme/charts.ts.
**Constat** : bandeau d'accueil **entièrement en dur** (l.230-278) : rayon 16 hors grille, dégradé ancien `#1668C5→#0B4E93`, textes/bordures hex inline — violations §7.2 + §4.2. Widgets dépendants de la palette `charts.ts` non auditée pour le sombre.
**Proposition** : §5 Tableaux de bord — bandeau sur dégradé signature via tokens, rayon grille ; KpiCard/StatTile/StatusTile en cartes plates bordées ; palette séries re-mappée (dérivés §7 de `design-tokens.md`) ; §6.7 : vérification des 9 widgets deux thèmes.

### /acquisition — L
**Constat** : feedback exemplaire (garde de fermeture, tooltips sur boutons désactivés, pipeline). Défauts : labels 12 px `Text secondary` avec astérisques manuels ; carte-radio sélectionnée par `boxShadow 0 0 0 1px` (cible : bordure 2 px) et pastille rayon 7 en dur ; `ClassementLu` rayon 8 + fallbacks `#1668c5`… ; espacements disparates ; panneau droit de la modale d'indexation sans fond différencié.
**Proposition** : §5 Acquisition — Steps primaire, cartes-radio bordure 2 px rayon 3 px, BatchPipeline sur sémantiques AA, panneau modale sur `#f8f9fb`. §6.2 : wizard en `componentSize="large"` **scopé au contenu de la carte** (le `Steps size="small"` et la modale d'indexation restent hors périmètre — cf. plan §5.4). §6.1 : échelle 8/16/24/28. Purge des hex en dur.

### /search — M
**Constat** : états vides/skeleton exemplaires. Défauts : table `middle` sur **l'écran de production par excellence** ; puces `borderRadius: 999` + padding en dur ; labels 13 px maison ; Collapse des filtres ouvert par défaut (résultats sous la ligne de flottaison).
**Proposition** : §6.6 : `size="small"` + `cellPaddingBlockSM` ; §5 : barre 46 px, puces en pilule tokenisée, CountBadge primaire ; §6.2 : labels 14 px. Arbitrage : Collapse replié par défaut sans filtre actif.

### /documents/[documentId] — M
Fichiers : page + 8 onglets (AccessTab, LifeCycleTab, SecurityTab, HistoryTab…).
**Constat** : chargement en `Spin` brut (`padding: 96` en dur) sans squelette ; badge « Vos droits » et « Gelé » en simples Tags — hiérarchie faible pour deux états majeurs ; 7 onglets dans une Card sans hiérarchie secondaire ; en-tête du tiroir d'aperçu non différencié.
**Proposition** : §5 Détail — Tabs à encre primaire, badge de droit en **badge plein AA**, tiroir à en-tête `#f8f9fb` ; §6.1 : squelette structuré + hiérarchie des actions ; §6.9 : cibles ≥ 40 px sur les boutons icône.

### /archives/dua-expirees — M
**Constat** : encart pédagogique déjà en place. Défauts : barre d'action de sélection **inline** (saut de mise en page à chaque coche, hors viewport en bas de liste) ; état vide texte brut ; largeurs de toolbar en dur ; table `middle` pour un écran de campagne.
**Proposition** : §5 Cycle de vie — barre de sélection **collante** (fond de surface + bordure haute) avec compteur ; Alert sur sémantiques AA ; badges d'échéance pleins AA ; §6.5 : EmptyState avec lien vers le paramétrage des cycles ; §6.6 : densité production.

### /archives/documents-epures — S
**Constat** : état vide texte brut sans guidage (d'où viennent les documents épurés ?) ; table `middle` non alignée sur la densité consultation.
**Proposition** : §6.5 : EmptyState guidant avec lien vers « DUA expirés » ; §6.6 : densité consultation (`cellPaddingBlock: 15`).

### /archives/communiquer — M
**Constat** : parcours en deux cartes déjà conforme, liste « À compléter » synchronisée. Défauts : labels `Text secondary` avec `*` collés, champs 36 px ; `Empty` AntD brut au lieu de l'EmptyState maison ; deux Alerts empilées (feedback bruyant) ; DatePickers étirés sans largeur max.
**Proposition** : §6.2 : panneau « Communication » en large (46 px) — **TreeSelect gauche en `size="large"` explicite seul**, la carte gauche contenant la table de production (cf. plan §5.4) ; §6.5 : EmptyState maison ; §6.3 : fusionner les deux Alerts.

### /archives/documents-communiques — M (patron)
**Constat** (porté par `LendingListPage`, partagé par 3 écrans) : badges d'état en Tags vifs bruts (sous AA) ; état vide texte brut ; Popconfirm « Oui/Non » sans conséquence ; `showTotal` « ligne(s) » incohérent ; table `middle` pour un écran opérationnel.
**Proposition** : correctif **unique dans le patron** : badges pleins AA, Popconfirm « Enregistrer le retour — le document réintègre l'archive », EmptyState guidant, densité production, « document(s) ».

### /archives/mes-documents-communiques — S (hérité)
**Constat** : hérite du patron ; colonne « Bénéficiaire » **morte** (toujours l'utilisateur connecté) sur un écran à 7-8 colonnes.
**Proposition** : héritage du correctif patron ; arbitrage : masquer la colonne via une prop.

### /archives/historique-communications — S (hérité)
**Constat** : icône de page « pending » contradictoire avec un historique clos ; Tag vert systématique (signal constant qui ne discrimine rien) ; densité `middle` au lieu de consultation.
**Proposition** : §6.6 : **écran type de la densité consultation** ; icône historique ; Tag constant → date simple ; EmptyState guidant.

## 3. Docu-Courriers

### /courriers/tableau-de-bord — M
**Constat** : bandeau héros en dur (l.320-360) : ancien dégradé, rayon 16, hex inline — §7.2 + §4.2. Le reste est sain (signal « plus ancien : N j », skeletons, toolbar small conforme §4.6.5). 9 widgets sur la palette actuelle.
**Proposition** : identique à /dashboards : bandeau re-tokenisé sur le dégradé signature, palette séries re-mappée, vérification double thème.

### /courriers/enregistrement — M
**Constat** : le formulaire de référence (3 FormSection, feedback IA exemplaire, `da-mono`). Défauts : aide IA en `rgba(0,0,0,.45)` en dur (illisible en sombre) ; pas de `componentSize="large"` ; grille `md={12}` étirée sans largeur max ; 5 tooltips (?) au lieu d'aide sous champ.
**Proposition** : §6.2 : Form en large (46 px) avec boutons à épingler (cf. plan §5.4), colonne ~640 px, aide sous champ ; §5 Formulaires courrier : AiFilledTag sur dérivé AA, mono conservée ; purge du rgba en dur.

### /courriers/controle (+ fiche) — S
**Constat** (MailWorklist partagé) : table `middle` ; la file masque **statut ET date butoir** — aucun signal d'urgence avant d'ouvrir la fiche ; titre « Chargement… » brut ; « N courrier(s) ».
**Proposition** : §6.6 : densité production ; CountBadge primaire ; arbitrage : réafficher la colonne Date butoir (le rendu `DateButoireCell` existe, simple flag — choix actuel commenté comme voulu).

### /courriers/documents-scannes — S
**Constat** : EmptyState et skeleton déjà en place, modale d'aperçu bien pensée. Défauts : triple redondance du texte des formats acceptés ; fallback `#e6e8e7` en dur ; référence de spéc « (§07) » exposée à l'utilisateur ; table `middle`.
**Proposition** : §6.1 : un seul niveau d'explication ; densité production ; purge du fallback ; retrait des « (§07) » (validation produit).

### /courriers/parapheur — S
**Constat** : la boîte de travail personnelle masque statut et date butoir — paradoxal pour la file de **priorisation** ; table `middle`.
**Proposition** : densité production (« l'écran cité par le PRD ») ; même arbitrage Date butoir ; vérifier les dérivés d'échéance en sombre.

### /courriers/suivi — S
**Constat** : meilleure file (colonne butoir tokenisée, distincte des paliers e-mail — documenté). Défauts : bouton « Fiche d'imputation » à cible ~24 px ; icône `download` ambiguë (ouvre une modale) ; table `middle` ; « (§09) » exposé.
**Proposition** : §6.9 : cible ≥ 40 px ; densité production ; dérivés AA sur `DateButoireCell` ; icône de fiche plus juste ; purge « (§09) ».

### /courriers/validation — M
**Constat** : seule file à sélection multiple, mais l'action de lot vit dans le PageHeader (hors viewport en bas de page) ; seule file à ouvrir le détail en popup `MailViewer` (incohérence de navigation — la migration en page serait un changement de route, interdit §2.2) ; pas de confirmation sur une action irréversible.
**Proposition** : §6.1 : **barre collante** en bas (compteur + bouton primaire) ; §6.3 : Popconfirm « Marquer N courriers comme traités ? Leurs imputations seront clôturées. » ; popup restylée aux tokens ; migration en page consignée comme hors-relook.

### /courriers/recherche — S
**Constat** : déjà très proche (EmptyState contextuel exemplaire, puces animées). Défauts : puces inline `999` + preset `blue` ; table `middle` (écran nommé « production ») ; labels 13 px maison ; ~230 px de filtres toujours déployés.
**Proposition** : §5 : pilules tokenisées, CountBadge primaire, densité production ; §6.2 : labels 14 px ; arbitrage : filtres secondaires repliés sous « Filtres (N) ».

### /courriers/depart — M
**Constat** : incohérence flagrante avec l'enregistrement : **aucun FormSection**, un seul Card plat à 6 champs + Dragger sans label. Bons points : dépendances destinataire→courrier lié bien gérées, n° auto en mono. « (§12) », « (§19) » exposés.
**Proposition** : §5 Formulaires courrier : aligner sur le motif d'enregistrement (3 FormSection, large, 640 px, label du Dragger « Courrier à envoyer (PDF, facultatif) ») ; purge des références.

### /courriers/integration-decharge — S
**Constat** : mécanique saine. Défauts : validation du fichier en `message.error` au lieu d'une règle sous le champ ; options du select non hiérarchisées ; pas de FormSection/large ; « (§13) ».
**Proposition** : §6.2 : règle Form.Item (erreur AA sous champ), large, largeur max ; §6.3 : Popconfirm avant archivage définitif ; n° en tête d'option en mono.

### Fiche courrier partagée (MailDetailPage) — M
**Constat** : socle de 4 files. Points forts : breadcrumb, DeadlineAlert calée sur les paliers e-mail, Popconfirm conforme. Défauts : formulaire d'imputation en champs **nus à placeholder-comme-label** (les libellés disparaissent à la saisie — anti-pattern) ; tags en presets AntD (`green`/`gold`/`blue`…) hors sémantiques ; Spin `padding: 96` en dur ; Descriptions sans largeur max.
**Proposition** : §5 Détail : Tabs primaire, badges pleins AA (re-mapper `tags.tsx`), tiroir à en-tête `#f8f9fb` ; §6.2 : vrais labels sur les 4 champs d'imputation ; squelette de fiche ; §6.9 : cibles ≥ 40 px.

## 4. Paramétrage Archives

### (patron commun) RefLayout / BulkRefPage / editable / PageHeader — M
**Constat** : 10 des 13 écrans en héritent. PageHeader : pastille rayon 12 + fallbacks anciens `#e6f0fb`/`#1668c5` en dur ; breadcrumb jamais fourni par les référentiels. RefLayout : labels simulés (rien d'annonçable au lecteur d'écran), champs 36 px, vide AntD brut, deux exports à icône identique. BulkRefPage : barre de sélection qui **décale la mise en page** ; Popconfirm sec. editable : crayon invisible au clavier (span sans role/tabIndex), flash sur l'ocre.
**Proposition** : correctif unique : pastille à la grille sans hex, breadcrumbs, formulaires en large avec labels associés (a11y), EmptyState guidant, wording Popconfirm, cellule éditable focusable + crayon primaire, flash re-tokenisé, barre de sélection stabilisée. Densité consultation recommandée (volumes faibles).

### /admin/classification-plans — S (hérité)
**Constat** : pagination sur les **racines** entièrement dépliées (« 10 élément(s) » peut en afficher 50) ; lignes sans marquage de survol/sélection.
**Proposition** : §5 arbres : survol/sélection `#1a55e3` à 8-10 %, texte primaire ; densité consultation ; micro-copie du showTotal en arbitrage.

### /admin/dossiers — S (hérité)
**Constat** : divergences gratuites avec ses jumeaux : casse du titre, ordre des champs, Entrée-pour-créer absent.
**Proposition** : §6.1 cohérence inter-écrans : aligner titre/ordre/raccourci sur le trio d'arbres.

### /admin/document-types — S (hérité)
**Constat** : Popconfirm sans conséquence alors que la suppression impacte paramétrages/cycles ; double titre identique page/carte.
**Proposition** : §6.3 : conséquence explicite ; titre de carte varié. Écran vitrine pour la recette du patron.

### /intercalaires — M
**Constat** : écran custom riche. Boutons de catégorie rayon 8 hors grille, actif sur fond pâle (cible : **fond plein `#1a55e3`**, signature) ; barre collante à marges négatives couplées en dur au padding de page (**cassera** avec le passage à 25/27 px) + ombre en dur ; encart vierge sur les tokens ocre ; lignes cochables rayon 6.
**Proposition** : §5 : catégorie active en fond plein miroir sidebar ; barre collante re-tokenisée (marges dérivées du padding tokenisé) ; rayons à la grille ; encart sur sémantiques AA ; aperçu A4 : blanc/noir conservé (artefact d'impression, arbitrage documenté), ombre retirée.

### /admin/archives/parametrage-types — M
**Constat** : motif volontairement divergent (bouton sous titre, formulaire au-dessus) — contraire au « motif unique » §6.1, partagé avec cycles-de-vie ; crayon « charger » remplit un formulaire hors champ de vision ; warning 12 px orange vif sous AA ; barre de suppression groupée décalante.
**Proposition** : arbitrage à trancher : rallier PageHeader.actions **ou** officialiser ce second motif ; défilement doux vers le formulaire au clic crayon ; large + 640 px ; warning AA ; description ajoutée.

### /admin/archives/cycles-de-vie — S (hérité)
**Constat** : copie du motif précédent (mutualisation) ; tooltip DUA et conversions années/mois à préserver.
**Proposition** : mêmes retouches que parametrage-types ; description liant l'écran à « DUA expirés ».

### /admin/archives/modes-destruction, sorts-finaux, motifs-pret — 3 × S (hérités)
**Constat** : pures instances BulkRefPage ; formTitle au pluriel pour une saisie unitaire ; Popconfirm sans conséquence ; icône « delete » trompeuse (modes) ; mode multi-lignes du composant inutilisé (code dormant).
**Proposition** : héritage du patron + singulier + conséquences ; icône neutre ; signaler le code dormant (hors périmètre).

### /admin/archives/metadonnees — S (hérité)
**Constat** : le lien documenté vers « Éléments des listes » (`?metaDataId=` supporté côté cible) **n'est pas rendu** — l'affordance promise n'existe pas.
**Proposition** : action de ligne vers l'écran cible pour les métadonnées Liste (route existante — arbitrage : le PRD fige la navigation) ; description ajoutée.

### /admin/archives/metadonnees-types — M
**Constat** : accordéon de tables imbriquées sain, mais table externe **sans pagination** ; « Remplacer la liste » (geste qui délie) porté par un bouton default anodin sans confirmation ; warning 12 px vif ; lignes de groupe indistinctes.
**Proposition** : §5 : groupe sur `#f8f9fb`/`#1e1e20`, compteur en pilule ; §6.3 : Popconfirm chiffrant les déliaisons ; warnings AA ; pagination/hauteur à trancher.

### /admin/archives/elements-listes — S (hérité)
**Constat** : Alert pédagogique et deep-link déjà bons ; filtre posé sans alignement de toolbar, action groupée qui décale.
**Proposition** : toolbar compacte stable (emplacement réservé), filtre actif en pilule ; Alert AA.

### /admin/geolocalisation (masqué) — S (hérité)
**Constat** : même patron que Dossiers avec divergences (casse, ordre des champs, Entrée présent ici mais pas chez Dossiers, largeurs) ; rien n'indique la page hors menu.
**Proposition** : alignement complet sur le trio d'arbres ; breadcrumb explicite ; reste masqué (§2.2).

## 5. Paramétrage Courrier, Sécurité, Administration

### (patron) MailRefPage / RefLayout — M
**Constat** : labels simulés, champs 36 px, **aucun `loading`** sur les Tables (flash « Aucune donnée ») , pas de flash de création (contrairement à /admin/users), crayon invisible au clavier, exports absents des référentiels courrier (incohérence avec les référentiels archives).
**Proposition** : correctif unique rayonnant sur ~10 écrans : large + labels, flash généralisé, TableSkeleton, EmptyState, crayon primaire, densité consultation.

### /admin/courriers/organigrammes — M
**Constat** : arbre rendu en Table plate avec `paddingLeft = depth*20` en dur : hiérarchie illisible dès 3 niveaux ; colonne « Parent » redondante ; « §14 »/« §15 » exposés.
**Proposition** : §5 arbres : sélection teintée, guides de profondeur par bordure tokenisée ; formulaire en large ; purge des références (validation produit).

### /admin/courriers/role-organigramme — S
**Constat** : seul référentiel courrier avec TableSkeleton (à généraliser) ; un rôle **non rattaché** (courrier orphelin potentiel) n'a aucun marqueur — cellule quasi vide.
**Proposition** : §6.4 : badge plein AA « Non rattaché » (warning dérivé) ; crayon primaire ; Alert AA.

### /admin/courriers/types-entites-externes — S (hérité)
**Constat** : quatre référentiels de la même section partagent le même picto (repérage faible menu + ⌘K) ; double point d'entrée invisible.
**Proposition** : pictos différenciés via `icons.tsx` ; mention du second point d'entrée ; héritage patron.

### /admin/courriers/entites-externes — M
**Constat** : annuaire potentiellement long **sans recherche** (pagination 10) ; e-mail non validé côté client (incohérent avec /admin/users) ; bouton « + » de création de type bien traité.
**Proposition** : densité production + filtre client sur le nom ; validation e-mail cohérente ; Popconfirm avec conséquence ; large.

### /admin/courriers/types-imputation — S
**Constat** : Tag « système » gold vif (AA à recalculer) ; Switch non associé à son libellé (a11y) ; Switch de cellule sans état de sauvegarde ; Popconfirm sec.
**Proposition** : Tag sur dérivé AA ; libellé lié au Switch ; loading pendant le PATCH ; wording harmonisé.

### /admin/courriers/types-depart — S (hérité)
**Constat** : règle de numérotation par type dense en une phrase ; conséquence de désactivation absente du Popconfirm.
**Proposition** : héritage + conséquence sur la numérotation (séquence conservée).

### /admin/courriers/natures, objets, confidentialites (3 masqués) — 3 × S
**Constat** : routes hors NAV → TopBar titre « Docu-Archives » et sidebar sans sélection (désorientant par URL directe) ; objets : deux modes d'édition en place incohérents (clic-pour-éditer vs InputNumber permanents à sauvegarde silencieuse) ; confidentialites : homonyme exact de l'écran archives (même titre, même icône).
**Proposition** : breadcrumb « Paramétrage Courrier › … » via la prop existante ; TopBar retombant sur le titre de PageHeader (îlot §4.4) ; unifier le motif d'édition ou ajouter le flash ; désambiguïser les deux « Confidentialités » (suffixe UI en arbitrage).

### /admin/securite/type-par-utilisateur (+ TypeSecurityPage) — M
**Constat** : barre d'octroi à 6 contrôles identifiés **uniquement par placeholders** (disparaissent à la saisie, avec la mention « facultatif » des dates) ; confirmations incohérentes dans le même écran (« Oui/Non » vs « Retirer/Annuler »).
**Proposition** : labels 14 px au-dessus, aide pour la période ; Popconfirm harmonisés ; groupe sur `#f8f9fb` ; Tag niveau → badge plein AA.

### /admin/securite/type-par-profil — S (hérité)
**Constat** : titre « par rôle » vs route/menu « par profil » — dissonance pour l'administrateur.
**Proposition** : héritage ; arbitrage : aligner le libellé de menu (clé de route et menuKeys inchangées).

### /admin/securite/confidentialite-utilisateurs — M
**Constat** : « Appliquer (n) » **écrase n habilitations sans confirmation**, et « vide = retirer » n'est porté que par un placeholder ; homonymes indistinguables (pas de colonne identifiant) ; pas de recherche.
**Proposition** : §6.3 : Popconfirm chiffré + Alert sur le niveau vide ; colonne username en mono + recherche client ; badge AA.

### /admin/securite/confidentialites — M
**Constat** : l'écran affirme que **l'ordre porte la règle d'accès** mais n'affiche ni rang ni gradation — l'information la plus critique du référentiel est invisible ; homonymie avec l'écran courrier.
**Proposition** : colonne « Rang » (pilule numérotée, gradation teintée AA) sans changer l'API ; conséquence de désactivation explicite.

### /admin/users — M
**Constat** : création en Card dépliée + édition en Modal (deux contenants pour le même objet) ; `borderRadius 6` en dur sur les Tags ; StatTiles sur l'ancienne palette ; pas de filtre ni d'indicateur de ligne pour les comptes désactivés.
**Proposition** : unifier création/édition ; large + labels ; Tags à 4 px tokenisés ; badge « Désactivé » AA par ligne ; StatTile re-mappé ; filtre client.

### /admin/roles — M
**Constat** : le rôle en édition n'est signalé que par le titre de la carte droite — **aucune mise en évidence de la ligne**, et changer de rôle perd les coches sans garde ; libellés de sections stylés inline ; Tag « Système » gold + rayon en dur.
**Proposition** : ligne éditée surlignée (`#1a55e3` 8-10 %) + garde « modifications non enregistrées » ; sections au motif 11 px/600 ; tokens partout.

### /admin/parametres/email — S
**Constat** : **seul écran à vrai Form AntD labellisé** (la référence à généraliser) ; mais aucune garde de sortie (Enregistrer éloigné dans le PageHeader) ; zone logo en dur ; aucun aperçu du rendu e-mail.
**Proposition** : garde `isFieldsTouched` ; large + 640 px ; zone d'upload à 3 px tokenisée ; mini-aperçu du gabarit (phase 4, arbitrage best-effort).

## 6. Chrome transverse

### AuthShell / sidebar — L
**Constat** : item actif au style AntD par défaut (fond doux) — loin du marqueur « rempli `#1a55e3` pleine largeur » ; repli = petit bouton texte à affordance faible ; badges de compteurs uniformément warning quelle que soit l'urgence ; drawer 280 px (cible 260). Mécanique à préserver : accordéon, cumuls de badges, menuKeys, persistance, gotoAuth dev.
**Proposition** : §4.4/§4.5 : sidebar 260 px, libellés `#141212`/`#8e94a9`, item actif rempli ; badges pilules danger/primaire selon l'urgence ; sections 11 px/600, **chacune porteuse d'une icône** — sans elle AntD laisse les titres de section déborder du rail replié de 76 px, et le cumul de compteurs de la section doit alors repasser en pastille sur l'icône.
~~Déclencheur : languette `#ff0854` 48×60 pilule gauche (drawer inclus).~~ **Superseded** (PRD §4.6 n°8) : le déclencheur est un bouton texte discret de la top bar ; l'affordance vient du glyphe directionnel (`PanelLeftClose`/`PanelLeftOpen`), pas de la couleur.

### TopBar — L
**Constat** : barre neutre blanche — à l'opposé du marqueur n°1 ; fallback de titre « Docu-Archives » sur les routes hors NAV ; rayons et hex en dur (recherche 8 px, kbd, avatar `#1668c5`).
**Proposition** : §4.4 mécanisme imposé : **îlot de thème** (`--da-topbar-*`), icônes/liens blancs deux thèmes, titre blanc/`#b9c0d4`, focus ring blanc ; popovers sous le thème ambiant ; rayons re-grillés ; titre des écrans masqués corrigé.

### CommandPalette — S
**Constat** : complet fonctionnellement ; items rayon 8 + fallbacks anciens en dur ; la sélection clavier peut **descendre hors de vue** (pas de scrollIntoView).
**Proposition** : §6.10 : rayon 5 px, ombre popover, actif sur primaire via tokens ; scrollIntoView (a11y, pas une fonctionnalité).

### NotificationsBell — S
**Constat** : panneau à largeur/rayon/ombre inline ; non-lus sur `primary-bg` ; cible de la cloche < 40 px.
**Proposition** : panneau 5 px + `boxShadowSecondary` + `bgElevated` ; badge pilule danger ; cible ≥ 40 px ; blanc sur l'îlot top bar.

### PdfViewer — M
**Constat** : vignette active bordée avec fallback `#1677ff` (bleu AntD par défaut — même pas la couleur actuelle) ; **surlignages de recherche en jaune/orange en dur, jamais audités AA ni testés en sombre** ; conteneur 8 px ; toolbar small ~24 px.
**Proposition** : §5 PdfViewer : vignette active `#1a55e3`, surlignages tokenisés vérifiés AA deux thèmes, conteneur 3 px, toolbar sur fond de surface ; arbitrage densité toolbar vs cible 40 px (dérogation §4.6.5 possible).

---

## Synthèse transversale

1. **Trois patrons concentrent le levier** : RefLayout/BulkRefPage/MailRefPage (≈ 20 écrans), MailWorklist + MailDetailPage (8), LendingListPage (3) — les corriger d'abord, les écrans héritent.
2. **Récidives** : labels simulés par `Text secondary` (motif à éradiquer partout, §6.2) ; barres de sélection qui décalent la mise en page (motif « barre collante » à généraliser) ; Popconfirm sans conséquence ; références de spéc « (§xx) » dans les textes visibles ; presets de Tags AntD hors sémantiques ; rayons 6/8/10/12/16 en dur de l'ancienne échelle.
3. **Acquis à ne pas casser** : gardes de fermeture, EmptyState contextuels de /search et /courriers/recherche, DeadlineAlert alignée sur les paliers e-mail, tooltips pédagogiques (DUA, boutons désactivés), flash de ligne.
