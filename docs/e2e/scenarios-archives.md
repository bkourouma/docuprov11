# Scénarios E2E — Docu-Archive (archivage par QR)

Lot 2. Specs Playwright sous `apps/e2e/tests/archives/` (colonne Spec relative à `apps/e2e/`).
Priorités : P1 critique, P2 important, P3 confort. Chaque test porte l’identifiant de son scénario en tête de titre ;
un scénario « fixme » est un `test.fixme` motivé (question métier ou dépendance), listé dans le rapport du lot.

Plages : ARC-01 parcours de bout en bout ; ARC-02 à ARC-05 intercalaires ; ARC-06 à ARC-12 acquisition et worker ;
ARC-13 à ARC-17 recherche ; ARC-18 et ARC-19 exports ; ARC-20 à ARC-22 accès refusé par défaut ;
ARC-23 à ARC-34 écrans opérationnels Docu-Archives ; ARC-35 à ARC-46 paramétrage Archives.

## Parcours, intercalaires, acquisition, recherche, exports, accès

### Parcours de bout en bout

| Id | Scénario | Préconditions | Étapes | Résultat attendu | Priorité | Spec |
| --- | --- | --- | --- | --- | --- | --- |
| ARC-01 | Parcours complet : intercalaires → acquisition QR → worker → recherche → exports → prêt/retour → DUA échue → épuration → intégrité | Pile E2E avec worker BullMQ ; type de document, dossier, plan, motif de prêt et cycle de vie échu créés par API (uniq) | Générer à l'écran la feuille d'intercalaires (téléchargement) ; fabriquer un PDF de lot (intercalaires générés + pages de contenu, pdf-lib) ; acquérir le lot à l'écran (seul le drapeau « avec intercalaires » est posé dans la requête, le sélecteur ayant été retiré) ; attendre le worker ; indexer et valider ; rechercher à l'écran ; exporter en Excel, CSV, PDF, Word ; communiquer puis rendre un document ; épurer à l'écran le document à DUA échue ; contrôler l'intégrité | Lot « traité », un document par intercalaire avec le bon type ; documents retrouvés par la recherche multi-critères ; 4 téléchargements au contenu contrôlé ; prêt visible puis clos dans l'historique ; document épuré absent des DUA expirées et présent dans « Documents épurés » ; intégrité sans anomalie | P1 | tests/archives/parcours-complet.spec.ts |

### Génération d'intercalaires (`/intercalaires`, `POST /intercalaires/generate`)

| Id | Scénario | Préconditions | Étapes | Résultat attendu | Priorité | Spec |
| --- | --- | --- | --- | --- | --- | --- |
| ARC-02 | Génération d'une feuille par type de document sélectionné | Deux types de document créés (uniq) | Catégorie « Type de document » ; cocher les deux types ; « Générer » | Téléchargement d'un PDF (`%PDF-`) d'une page par élément, portant catégorie et libellé | P1 | tests/archives/intercalaires.spec.ts |
| ARC-03 | Dossiers en arbre indenté ; séparateur vierge sans sélection | Dossier parent et enfant | Catégorie « Dossier » : vérifier l'indentation ; catégorie « Vierge » : générer sans sélection | Arbre affiché ; PDF du séparateur vierge d'une page | P2 | tests/archives/intercalaires.spec.ts |
| ARC-04 | Erreurs de saisie : sélection vide, éléments invalides | Aucun | Écran : rien coché, filtre sans correspondance ; API : sélection vide, id inexistant, catégorie inconnue, id nul, liste d'une catégorie inconnue | Bouton désactivé à 0 élément, « Aucun résultat » ; API 400 « Sélection vide », « Aucun élément valide », « Catégorie inconnue » (jamais 500) | P1 | tests/archives/intercalaires.spec.ts |
| ARC-05 | Refus par permission | Utilisateur sans le menu Intercalaires | Ouvrir `/intercalaires` ; appeler les routes | Écran refusé ; API 403 (garde de menu ajouté, cf. ANO) | P1 | tests/archives/intercalaires.spec.ts |

### Acquisition par lot (`/acquisition`, `/batches`, worker)

| Id | Scénario | Préconditions | Étapes | Résultat attendu | Priorité | Spec |
| --- | --- | --- | --- | --- | --- | --- |
| ARC-06 | Acquisition à l'écran de 11 PDF envoyés par paquets, fusionnés puis validés | Type et dossier cibles | Écran : choisir les cibles, ajouter 11 PDF, lancer ; attendre le worker ; valider depuis l'indexation | Envoi en plusieurs requêtes `/batches/:id/files` ; lot « traité » ; un document fusionné contenant toutes les pages ; validé | P1 | tests/archives/acquisition.spec.ts |
| ARC-07 | Découpage par le worker selon les intercalaires TYPE, BLANK, DOSSIER, PLAN, LOCALISATION | Référentiels de chaque catégorie | Lot `useIntercalaires: true` fabriqué avec les intercalaires générés par l'API ; dépôt ; attente | Un document par segment, avec type, dossier, plan et localisation lus dans les QR ; pages d'intercalaire exclues | P1 | tests/archives/acquisition.spec.ts |
| ARC-08 | Retraitement d'un lot sans doublon | Lot traité | `POST /batches/:id/reprocess` ; attente | Même nombre de documents, aucun doublon. Retraitement d'un lot déjà validé : fixme (question métier) | P2 | tests/archives/acquisition.spec.ts |
| ARC-09 | Lot sans QR ; type du lot en repli | Lot sans intercalaire ; lot avec type par défaut | Dépôt ; attente | Un seul document « sans type » ; ou type du lot appliqué quand aucun intercalaire ne le donne | P2 | tests/archives/acquisition.spec.ts |
| ARC-10 | Fichiers illisibles ou non PDF | Aucun | Écran : déposer un PDF illisible seul, puis un fichier texte ; API : lot sans PDF lisible | Lot « en échec » signalé à l'écran ; fichier non PDF écarté dès l'ajout. Lot mêlant lisibles et illisible : fixme (question métier) | P1 | tests/archives/acquisition.spec.ts |
| ARC-11 | Créations et dépôts invalides | Aucun | API : deux dossiers cibles, dossier/type/plan inconnus, libellé de nouveau dossier en doublon, dépôt sans fichier, lot inconnu | 400 avec message (« Dossier cible introuvable », « Type de document introuvable », « Plan de classement introuvable », « Aucun fichier reçu »), 409 « Un dossier actif porte déjà ce libellé », 404 sur lot inconnu ; rien mis en file | P1 | tests/archives/acquisition.spec.ts |
| ARC-12 | Refus par permission | Utilisateur sans le menu Acquisition | Ouvrir `/acquisition` ; appeler `/batches` | Écran refusé ; API 403 (garde de menu ajouté, cf. ANO) | P1 | tests/archives/acquisition.spec.ts |

### Recherche multi-critères (`/search`, `POST /documents/search`)

| Id | Scénario | Préconditions | Étapes | Résultat attendu | Priorité | Spec |
| --- | --- | --- | --- | --- | --- | --- |
| ARC-13 | Plein texte sur le libellé | Documents archivés créés par API, jeton unique | Saisir le jeton, rechercher ; ouvrir la fiche | Résultat unique, filtre affiché en puce, fiche du document ouverte | P1 | tests/archives/recherche.spec.ts |
| ARC-14 | Filtres avancés combinés, retrait d'un filtre, réinitialisation | Documents variant par type, dossier, plan, type de fichier, date | Combiner les filtres ; retirer une puce ; réinitialiser | Corps envoyé conforme ; résultats = intersection ; retrait élargit ; réinitialisation vide les critères | P1 | tests/archives/recherche.spec.ts |
| ARC-15 | Pagination (API) et tri par colonne (écran) | Plus d'une page de documents au même jeton | Pages successives par API ; clic sur l'en-tête de colonne | Pages disjointes, total stable ; ordre conforme au tri | P2 | tests/archives/recherche.spec.ts |
| ARC-16 | Aucun résultat ; saisies invalides | Aucun | Jeton inconnu à l'écran ; API : plage de dates inversée, page/taille hors bornes, champs mal typés | État vide, export désactivé ; API 400 (jamais 500, cf. ANO) | P1 | tests/archives/recherche.spec.ts |
| ARC-17 | Plein texte sur le texte extrait des pages d'un document issu d'un lot ; cote ; OCR Tesseract | Lot traité par le worker (pages à couche texte) | Acquérir un lot de 2 pages dont la 2e porte un mot unique ; valider ; rechercher ce mot (API et écran), puis un mot absent | Le mot de la page 2 retrouve le seul document (total 1), un mot absent ne retrouve rien ; la ligne s'affiche à l'écran. Vérifie le texte extrait par le worker, pas Tesseract. Fixme : cote (plus aucun chemin ne l'écrit, question métier) ; OCR Tesseract réel (tessdata non embarqué dans la pile hermétique) | P3 | tests/archives/recherche.spec.ts |

### Exports de la recherche (Excel, CSV, PDF, Word)

| Id | Scénario | Préconditions | Étapes | Résultat attendu | Priorité | Spec |
| --- | --- | --- | --- | --- | --- | --- |
| ARC-18 | Export dans chaque format depuis l'écran, contenu conforme au filtre | Documents dans et hors filtre | Filtrer ; exporter en Excel, CSV, PDF, Word (événement de téléchargement) | Excel relu (feuille, en-têtes, lignes) ; CSV (en-têtes, lignes) ; Word (`PK`, `word/document.xml`) ; PDF (`%PDF-`, texte extrait) ; le document hors filtre est absent partout ; chaque téléchargement aboutit (ANO-ARC-B-02 corrigée : URL du fichier révoquée trop tôt) | P1 | tests/archives/export.spec.ts |
| ARC-19 | L'export suit le tri et ignore la pagination ; colonnes exportées | Plus d'une page de résultats | Trier ; exporter | Toutes les lignes dans l'ordre du tri. Colonnes de l'export ou colonnes affichées : fixme (question métier) | P2 | tests/archives/export.spec.ts |

### Accès refusé par défaut de la recherche (confidentialité, droits explicites, permissions)

| Id | Scénario | Préconditions | Étapes | Résultat attendu | Priorité | Spec |
| --- | --- | --- | --- | --- | --- | --- |
| ARC-20 | Document confidentiel invisible d'un utilisateur non habilité ; rang suffisant requis | Document à niveau de confidentialité ; utilisateurs sans habilitation, de rang inférieur, de rang suffisant | Rechercher, compter, exporter, ouvrir la fiche, lire le binaire, ouvrir l'écran | Non habilité et rang inférieur : absent de la liste ET du total, de l'export, fiche et binaire refusés ; rang suffisant : visible partout | P1 | tests/archives/acces-confidentialite.spec.ts |
| ARC-21 | Droits explicites : nominatif, sur le type, levée de confidentialité ; refus strict sans droit | Documents avec droits nominatifs ou de type | Rechercher en bénéficiaire puis en tiers | Visible du seul bénéficiaire (ou du rôle) sur les 4 canaux ; le droit nominatif lève la confidentialité pour lui seul. Document sans aucun droit invisible (FR-027) : fixme (écart spec/code) | P1 | tests/archives/acces-confidentialite.spec.ts |
| ARC-22 | Refus par permission | Utilisateur sans droit ; utilisateur sans le menu Recherche | Tenter de s'octroyer un droit ou de lever une confidentialité ; vérifier la navigation ; appeler search/export | Refus 403/404 sans effet (règle : seul qui peut ouvrir la fiche en gère les droits) ; entrée absente de la navigation. Fixme : auto-octroi accepté aujourd'hui (ANO-ARC-B-01, correctif du lot GED) ; écran et routes refusés sans le menu (question métier sur les menus qui ouvrent la recherche) | P1 | tests/archives/acces-confidentialite.spec.ts |

## Écrans opérationnels Docu-Archives

### Communiquer un document (`/archives/communiquer`)

| Id | Scénario | Préconditions | Étapes | Résultat attendu | Priorité | Spec |
| --- | --- | --- | --- | --- | --- | --- |
| ARC-23 | Prêt nominal de bout en bout : saisie à l'écran, visible dans « Documents communiqués » puis dans « Mes documents communiqués » de l'emprunteur, retour par l'emprunteur | Dossier avec 2 documents archivés, motif de prêt, utilisateur emprunteur (menu « Mes documents communiqués ») avec un compte-groupe | Choisir le dossier → cocher 1 document → bénéficiaire → motif → retour prévu J+10 → « Communiquer » ; chercher le document dans « Documents communiqués » ; se connecter comme l'emprunteur, « Mes documents communiqués » → « Retour » → « Enregistrer le retour » | POST 201 avec le corps saisi, toast « Document communiqué », redirection vers « Documents communiqués » ; ligne avec bénéficiaire, motif, « en cours » ; le document n'est plus communicable, son voisin si ; côté emprunteur la colonne Bénéficiaire est masquée ; toast « Document retourné — la communication est close » ; le prêt passe à l'historique avec une date de retour, le document redevient communicable | P1 | tests/archives/communication.spec.ts |
| ARC-26 | Erreurs de saisie : champs requis, retour prévu antérieur au début, règles serveur | Dossier avec 1 document, motif, emprunteur | Écran : vérifier l'état du bouton à chaque champ ; début J-10, retour J-5, puis début ramené à J ; API : corps vide, liste vide, retour < début, format JJ/MM/AAAA, début futur, motif / bénéficiaire / document inconnus | Bouton « Communiquer » désactivé tant qu'un champ manque ou que le retour précède le début, aucun POST envoyé ; API 400 nommant chaque champ, messages « Sélectionnez au moins un document », « La date de retour prévue doit suivre la date de début », « Date attendue au format AAAA-MM-JJ », « La date de début ne peut pas être future » ; 404 « Motif de prêt introuvable », « Bénéficiaire introuvable », document introuvable ; aucun prêt créé | P1 | tests/archives/communication.spec.ts |
| ARC-27 | Document déjà communiqué : non proposé, course entre deux agents, refus en bloc, doublon, document épuré | Dossier avec 3 documents dont 1 déjà prêté | Ouvrir le dossier ; préparer un prêt sur un 2e document, le faire sortir par l'API entre-temps, valider ; API : prêt mêlant un document libre et un sorti ; même document deux fois ; document épuré | Le document sorti n'est pas listé ; à la validation : 409, toast « Document(s) déjà communiqué(s) et non rendu(s) : … », liste rafraîchie sans le document, on reste sur l'écran ; refus en bloc (le libre reste communicable) ; un seul détail pour un document cité deux fois ; 409 « épuré » | P1 | tests/archives/communication.spec.ts |

### Documents communiqués, Mes documents communiqués, Historique (`/archives/documents-communiques`, `/archives/mes-documents-communiques`, `/archives/historique-communications`)

| Id | Scénario | Préconditions | Étapes | Résultat attendu | Priorité | Spec |
| --- | --- | --- | --- | --- | --- | --- |
| ARC-24 | Retour document par document depuis « Documents communiqués », puis consultation de l'historique | Prêt de 2 documents créé par l'API | Rendre le 1er document à l'écran, puis le 2nd ; ouvrir l'historique et chercher ; rejouer le retour par l'API | 1er retour : toast « Document retourné », entête encore ouverte ; 2nd : « … la communication est close », entête close ; historique : 2 lignes datées, aucun bouton « Retour » ; second retour 409 sans écraser la date ; détail inconnu 404 ; documents de nouveau communicables | P1 | tests/archives/communication.spec.ts |
| ARC-25 | Commentaires d'une communication (API) ; saisie à l'écran en fixme | Prêt en cours, agent (menu « Documents communiqués ») avec compte-groupe, lecteur (menu « Historique ») | POST `/archives/lendings/comments` ; GET `/archives/lendings/:id` ; commentaires vide / blanc / > 2000 ; prêt inconnu ; commentaire depuis le seul menu Historique | 201, commentaire relu sans espaces de bordure et signé du compte-groupe ; 400 ; 404 ; 403 et aucun commentaire ajouté. Écran : fixme (aucune page ne consomme ces routes) | P2 | tests/archives/communication.spec.ts |
| ARC-28 | Périmètre de « Mes documents communiqués » ; gestes sur le prêt d'autrui | Deux utilisateurs avec le seul menu « Mes documents communiqués », un prêt au premier | API `lendings/mine` pour chacun ; `lendings/out` pour le second ; écran du second | Le titulaire voit son prêt, le voisin rien (état vide « Aucune communication en cours »), `out` 403. Retour, lecture et commentaire du prêt d'autrui : 404 comme un identifiant inexistant, sans effet ; le titulaire lit (200), commente (201) et rend (200) son propre prêt (ANO-ARC-T3-05 corrigée) | P2 | tests/archives/communication.spec.ts |

### DUA expirés et Documents épurés (`/archives/dua-expirees`, `/archives/documents-epures`)

| Id | Scénario | Préconditions | Étapes | Résultat attendu | Priorité | Spec |
| --- | --- | --- | --- | --- | --- | --- |
| ARC-29 | Liste des DUA échues, horizon d'anticipation, recherche | 3 documents : DUA J-2, DUA J+60, sans cycle de vie | API par horizon ; écran : rechercher, lire la coupure, passer à « Échu dans les 3 mois », rechercher un texte absent | Horizon 0 : seul l'échu (échéance affichée), « Échéance au plus tard le » = date du jour ; 3 mois : les deux, « 2 document(s) » ; le document sans règle n'apparaît jamais ; état vide « Aucun document échu sur cette période » | P1 | tests/archives/dua-epuration.spec.ts |
| ARC-30 | Épuration confirmée à l'écran, annulation, document prêté bloqué, « Documents épurés » ; épuration d'un non-échu refusée | 3 documents échus dont 1 prêté | Cocher → « Épurer la sélection » → « Annuler » ; cocher aussi le prêté → « Épurer » ; ouvrir « Documents épurés » ; API : rejouer, liste vide | Annuler : rien d'épuré ; confirmer : POST des 2 identifiants, toast « 1 document(s) épuré(s). Non épuré(s), encore communiqué(s) : … », l'épuré quitte la liste, le prêté reste ; « Documents épurés » le montre, sans case à cocher ; plus communicable ; rejeu `purged: 0` ; liste vide 400. Non échu (ou sans règle) dans la demande : 409 en bloc qui le nomme, rien d'épuré ; identifiant inconnu 404 ; à l'écran, toast d'erreur (ANO-ARC-T3-06 corrigée) | P1 | tests/archives/dua-epuration.spec.ts |

### Intégrité du fonds (`/archives/integrite`)

| Id | Scénario | Préconditions | Étapes | Résultat attendu | Priorité | Spec |
| --- | --- | --- | --- | --- | --- | --- |
| ARC-31 | Indicateurs de couverture et contrôle de tout le fonds | Un document archivé jamais contrôlé | Ouvrir l'écran ; « Contrôler tout le fonds » | Les 5 indicateurs reprennent exactement la couverture renvoyée par le serveur ; tranches de 50 au plus, toutes 200 ; bandeau « Fonds contrôlé : N document(s) » ; indicateurs rechargés ; le document du test est vérifié, conforme, empreintes SHA-256 posées, absent des non-conformes | P1 | tests/archives/integrite.spec.ts |
| ARC-32 | Binaire altéré détecté et listé, puis restauré | `E2E_ARCHIVES_PATH` exposé par la pile (sinon fixme) ; document de test contrôlé une fois | Ajouter des octets au binaire sur le coffre ; contrôler ; ouvrir l'écran ; restaurer | Contrôle `integrityOk: false`, fichier `mismatch` ; indicateur « Non conformes » ≥ 1 ; le document listé avec lien vers sa fiche et « Intégrité non garantie » ; après restauration : conforme et retiré de la liste | P2 | tests/archives/integrite.spec.ts |

### Refus par permission (sept écrans opérationnels)

| Id | Scénario | Préconditions | Étapes | Résultat attendu | Priorité | Spec |
| --- | --- | --- | --- | --- | --- | --- |
| ARC-33 | Chaque écran refusé sans son menu (écran + API), contrôle positif avec le seul menu | Compte avec le seul menu `/search` ; compte avec le seul menu de l'écran | API de liste pour chacun ; connexion du premier, URL de l'écran saisie à la main (pour « Communiquer » : choix du dossier) | Sans menu : 403 sur la route (et sur balayage / scellement pour l'intégrité, sur la création pour « Communiquer »), toast « Vous n'avez pas accès à cette section. », entrée absente de la navigation, aucune donnée ni action ; avec le menu : 200 sans être administrateur | P1 | tests/archives/communication.spec.ts, tests/archives/dua-epuration.spec.ts, tests/archives/integrite.spec.ts |
| ARC-34 | Épuration et prêt refusés sans le menu d'action, même avec les menus de consultation | Consultant « Documents épurés » seul ; archiviste « DUA expirés » seul ; lecteur des trois listes de prêts ; guichet « Communiquer » + « Historique » | Épurer par l'API et ouvrir « DUA expirés » en consultant ; créer un prêt en lecteur ; rendre un prêt en guichet | 403 à chaque geste, aucun effet (toujours échu, toujours communicable, prêt toujours en cours), écran sans document ni bouton d'épuration ; contrôles positifs : l'archiviste épure, le lecteur rend | P1 | tests/archives/communication.spec.ts, tests/archives/dua-epuration.spec.ts |


## Paramétrage Archives


Huit écrans `/admin/archives/*`. Lectures ouvertes à tout compte authentifié (lookups de formulaire,
voulu par le contrôleur — question remontée) ; chaque écriture exige le menu de SON écran.
Suppression = désactivation pour les référentiels et les métadonnées (les usages gardent le libellé).

### Référentiels du cycle de vie : modes de destruction, sorts finaux, motifs de prêt

| Id | Scénario | Préconditions | Étapes | Résultat attendu | Priorité | Spec |
|---|---|---|---|---|---|---|
| ARC-35 | Création unitaire par l'écran, doublon signalé (x3 écrans) | Admin | Ouvrir l'écran ; vérifier « Ajouter » inactif à vide/blanc ; saisir un libellé, Ajouter ; ressaisir le même en majuscules entouré d'espaces | POST `{ labels: [x] }` 201, « 1 {nom} créé », ligne visible ; doublon : `{created:0, skipped:[X]}`, « 1 ignoré(s) (doublon) », une seule ligne active | P1 | tests/archives/parametrage-referentiels.spec.ts |
| ARC-36 | Création en masse par l'API : doublons internes / existants ignorés, saisies vides refusées (x3) | Un élément existant | POST 4 libellés dont un doublon de casse et un doublon sans espace ; POST `[]`, `['  ']`, `[ok, '']`, `{}` | `created:2`, `skipped` nomme les 2 doublons ; libellés stockés normalisés ; 400 pour chaque saisie vide, rien de créé | P1 | tests/archives/parametrage-referentiels.spec.ts |
| ARC-37 | Renommage en place, doublon refusé, libellé vidé restauré (x3) | Deux éléments A, B | Cliquer le libellé de A, saisir, Entrée ; renommer A en B (casse) ; vider le libellé | PATCH 200 « Modifié » ; 409 avec le message de l'API, libellé inchangé ; vidé : restauré sans aucun PATCH ; API : blanc 400, id inconnu 404 | P2 | tests/archives/parametrage-referentiels.spec.ts |
| ARC-38 | Désactivation unitaire et en lot ; élément utilisé (x3) | Élément cité par une règle de cycle de vie (sorts, modes) | Désactiver avec confirmation ; cocher 2 lignes, « Désactiver la sélection » | DELETE `{ids}` 200, « Élément désactivé » / « 2 éléments désactivés » ; plus listé ; la règle qui le cite garde son libellé ; libellé recréable ; corps absent 400 | P1 | tests/archives/parametrage-referentiels.spec.ts |
| ARC-39 | Refus d'écriture sans le menu, permis avec le seul menu de l'écran (x3) | Compte `/search` seul ; compte avec le menu de l'écran | API : GET, POST, PATCH, DELETE ; écran : Ajouter | Sans menu : GET 200, écritures 403 ; avec : POST 201, PATCH 200, 403 sur un AUTRE référentiel ; écran : 403 et « Vous n'avez pas accès à cette section. », rien de créé | P1 | tests/archives/parametrage-referentiels.spec.ts |

### Métadonnées, éléments des listes, métadonnées par type

| Id | Scénario | Préconditions | Étapes | Résultat attendu | Priorité | Spec |
|---|---|---|---|---|---|---|
| ARC-40 | Métadonnée : création (Liste), doublon, retypage, renommage, désactivation, saisies invalides | Admin | Créer « Liste de valeurs » ; doublon ; passer en « Texte » ; renommer ; désactiver ; API invalide | POST `{metaDatas:[{label,dataType:6}]}` ; lien « Gérer les valeurs » présent puis absent après retypage ; « Métadonnée désactivée » ; 400 pour liste vide, libellé blanc, type 7/-1/absent, PATCH vide ; 409 sur doublon | P1 | tests/archives/parametrage-metadonnees.spec.ts |
| ARC-41 | Valeurs d'une liste : lien depuis la métadonnée, création, doublon, masse, désactivation | Métadonnée Liste + métadonnée Texte | Lien « Gérer les valeurs » ; vérifier la pré-sélection et l'absence de la métadonnée Texte ; créer, doublon ; masse API ; désactiver | URL `?metaDataId=` ; « 1 valeur créée » / doublon signalé ; unicité par liste ; compteur `listItemCount` = valeurs actives ; 400 sur valeur pour métadonnée Texte (ANO-ARC-T4-02), 404 métadonnée inconnue | P1 | tests/archives/parametrage-metadonnees.spec.ts |
| ARC-42 | Associer, remplacer, retirer ; champs du formulaire d'indexation | 2 types, métadonnée Texte, métadonnée Liste à 2 valeurs | Associer 2×2 ; ré-associer un couple ; déplier ; remplacer la liste d'un type ; retirer une association ; désactiver une valeur puis la métadonnée | « 4 association(s) créée(s) », « 0 … — 1 déjà en place » ; `fields` du type = les 2 champs, options de liste ; PUT `{documentTypeId, metaDataIds}` après confirmation « Retirer 1 métadonnée » ; désactivations répercutées sur `fields` ; 400 sur id inconnu (ANO-ARC-T4-01) | P1 | tests/archives/parametrage-metadonnees.spec.ts |
| ARC-42 | Métadonnée obligatoire pour un type | — | — | fixme : aucun caractère « obligatoire » dans le modèle (question métier) | P3 | tests/archives/parametrage-metadonnees.spec.ts |
| ARC-43 | Refus d'écriture des trois écrans sans menu ; un menu n'ouvre que son écran | Compte `/search` ; compte « Métadonnées » | 9 écritures API ; création par l'écran | Lectures 200 ; 9 × 403 ; « Métadonnées » : POST metadatas 201, valeurs et associations 403 ; écran : 403 expliqué | P1 | tests/archives/parametrage-metadonnees.spec.ts |

### Paramétrage des types et cycles de vie

| Id | Scénario | Préconditions | Étapes | Résultat attendu | Priorité | Spec |
|---|---|---|---|---|---|---|
| ARC-44 | Paramétrer un type (dossier, plan, confidentialité), modifier, supprimer | Type, dossier, 2 plans, confidentialité | « Nouveau paramétrage », choisir, Enregistrer ; crayon, changer de plan ; Supprimer | PUT complet 200 « Paramétrage enregistré » ; ligne avec les 3 libellés ; avertissement de remplacement ; une seule ligne par type ; « Paramétrage supprimé », plus de défauts | P1 | tests/archives/parametrage-types-cycles.spec.ts |
| ARC-44 | Paramétrage invalide par l'API | Type | PUT vide, type inconnu, taux 0/101, dossier/plan/confidentialité inconnus | 400 / 404 / 400 / 400 (ANO-ARC-T4-01) ; paramétrage vide accepté | P2 | tests/archives/parametrage-types-cycles.spec.ts |
| ARC-45 | Cycle de vie : DUA, conformité, sort final, mode ; modification ; suppression | Type, sort final, mode | Saisir 3 ans / 10 ans ; recharger, DUA 0 ; supprimer | PUT en MOIS (36/120) ; « 3 ans », « 10 ans », libellés ; relecture en années ; « immédiat » ; « Règle supprimée » ; champs `aria-valuemin=0` | P1 | tests/archives/parametrage-types-cycles.spec.ts |
| ARC-45 | DUA hors bornes ou référence inexistante | Type | PUT -1, décimal, chaîne, champ absent, > 12 000 mois, > 2^31, sort/mode inconnus | 400 partout (ANO-ARC-T4-01/03), 404 type inconnu ; 0 et 12 000 admis | P1 | tests/archives/parametrage-types-cycles.spec.ts |
| ARC-45 | Années entières seulement à l'écran | Type | Saisir 2,5 ans, Enregistrer | « 2,5 » s'affiche 3, « 4.4 » s'affiche 4 ; PUT 36/48 mois, relus à l'identique (ANO-ARC-T4-04 corrigée) | P2 | tests/archives/parametrage-types-cycles.spec.ts |
| ARC-45 | Sort final / mode utilisé puis désactivé | Règle citant les deux | Désactiver par l'API ; ouvrir l'écran ; « Nouvelle règle » | La règle affiche toujours les libellés ; ils ne sont plus proposés | P2 | tests/archives/parametrage-types-cycles.spec.ts |
| ARC-46 | Refus d'écriture types / cycles sans menu ; chaque menu n'ouvre que son écran | Comptes `/search`, « Cycles de vie », « Paramétrage des types » | 5 écritures API ; enregistrement par l'écran | Lectures 200, écritures 403 ; menus croisés 403 ; écran : 403 expliqué, règle inchangée | P1 | tests/archives/parametrage-types-cycles.spec.ts |
| ARC-46 | Écran de paramétrage refusé à l'ouverture sans son menu | Compte sans menu | Ouvrir l'URL | Écran « Accès refusé ». Fixme : en attente du lot transverse (AuthShell) ; le 403 API est vérifié par la ligne précédente | P3 | tests/archives/parametrage-types-cycles.spec.ts |
