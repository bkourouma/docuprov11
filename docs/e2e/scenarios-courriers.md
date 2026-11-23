# Scénarios E2E — Docu-Courriers (lot 1)

Module couvert : écrans opérationnels `/courriers/*` (enregistrement, documents scannés, contrôle,
parapheur, suivi, validation, départ, intégration décharge, recherche, tableau de bord, et leurs
fiches `[mailId]`), paramétrage `/admin/courriers/*` (confidentialités, entités externes, natures,
objets, organigrammes, rôle ↔ organigramme, types de départ, types d'entités externes, types
d'imputation), API `apps/api/src/modules/courriers/**` et notifications.

Conventions :
- Specs : chemins relatifs à `apps/e2e/tests/courriers/`. Chaque test porte l'identifiant de son scénario dans son titre.
- Données : chaque test crée ses acteurs (`createCourrierActor` : rôle neuf + utilisateur), ses référentiels
  (`createCourrierRefs`) et ses courriers (`uniq()`), par l'API ; l'interface sert à ce qu'on teste.
- Priorités : P1 critique, P2 important, P3 confort. Les P1/P2 sont des tests réels ; « fixme » signale un
  `test.fixme(true, raison)` (anomalie dans un fichier hors périmètre ou question métier ouverte).
- Services externes : pas d'IA ni de SMTP en E2E ; on teste leurs états sans service (désactivé, action qui réussit sans e-mail).
- Refus par permission : sans le menu, l'entrée n'apparaît pas dans la navigation, l'écran ouvert par URL
  affiche le refus (toast 403) et l'API répond 403.

Plages d'identifiants : COU-01 à 19 enregistrement / scans / contrôle ; COU-20 à 39 parapheur / suivi /
validation / notifications ; COU-40 à 59 départ / décharge / recherche / tableau de bord ; COU-60 à 64
parcours de bout en bout ; COU-70 à 99 paramétrage et permissions de menu.

**Parcours critique de bout en bout : COU-60** (section 3, « Parcours de bout en bout ») — enregistrement
d'un courrier arrivée, contrôle, imputation, parapheur, suivi, validation, réponse par un départ lié,
intégration de la décharge, recherche, tableau de bord.

## 1. Enregistrement, documents scannés, contrôle (COU-01 à COU-19)



### Enregistrement

| Id | Scénario | Préconditions | Étapes | Résultat attendu | Priorité | Spec |
|---|---|---|---|---|---|---|
| COU-01 | Enregistrement nominal d'un courrier arrivé | Admin connecté ; référentiels E2E créés (nature, objet, confidentialité, correspondant) ; rôle destinataire avec un porteur | Ouvrir Enregistrement ; vérifier le n° proposé et la date du jour ; remplir titre, référence expéditeur, expéditeur, nature, objet, confidentialité, destinataire (rôle) ; joindre un PDF ; Enregistrer | POST arrivée 201 ; toast de succès ; le courrier relu par l'API porte le n° proposé, le rôle destinataire, l'organigramme dérivé, `valider=false` et un document joint | P1 | enregistrement.spec.ts |
| COU-02 | Champs obligatoires manquants à l'écran | Admin connecté | Ouvrir Enregistrement ; vider le titre ; cliquer Enregistrer sans rien remplir | Erreurs sous chaque champ obligatoire (titre, référence, expéditeur, destinataire, PDF) ; aucune requête POST arrivée envoyée | P1 | enregistrement.spec.ts |
| COU-03 | Validation API de la saisie | Admin ; rôle destinataire actif ; un rôle désactivé | POST arrivée sans titre, titre blanc, date absente ou invalide, sans destinataire, destinataire non entier, rôle inconnu, rôle désactivé | 400 pour chaque cas (jamais 500) ; rôle inconnu : « Rôle destinataire introuvable ou inactif » | P1 | enregistrement.spec.ts |
| COU-04 | Liste des destinataires = rôles non système | Admin ; un rôle avec porteur, un rôle sans porteur | Ouvrir la liste « Destinataire » ; chercher les deux rôles et le rôle système | Rôles actifs non système proposés ; rôle sans porteur suffixé « (aucun utilisateur) » ; rôle système absent | P2 | enregistrement.spec.ts |
| COU-04 (fixme) | L'API refuse le rôle système comme destinataire | Rôle système existant | POST arrivée avec `destinataireRoleId` = rôle système | Attendu : 400. Fixme : `deriveOrganigramme` ne vérifie que `isActive` (question métier) | P2 | enregistrement.spec.ts |
| COU-05 | Correspondant créé à la volée | Admin ; rôle destinataire | Cliquer « + » à côté d'Expéditeur ; saisir un nom unique ; valider la fenêtre « Créer un expéditeur » ; enregistrer le courrier | Fenêtre fermée, correspondant sélectionné dans le champ ; le courrier enregistré porte ce `externalEntityId` ; correspondant présent au référentiel | P1 | enregistrement.spec.ts |
| COU-06 | Destinataire en copie | Admin ; rôle principal et rôle en copie avec porteurs | Enregistrer un courrier avec un rôle « En copie » | Imputation de type 17 (En Copie) créée pour le porteur ; courrier absent de son parapheur ; visible dans son suivi DC | P2 | enregistrement.spec.ts |
| COU-07 | Rattachement d'un scan via `?scanId=` | Admin ; scan déposé non traité | Ouvrir Enregistrement `?scanId=<id>` ; vérifier le bandeau ; remplir sans joindre de PDF ; Enregistrer ; rouvrir avec un scanId inconnu | Bandeau « Document scanné rattaché » avec le nom du fichier ; PDF non exigé ; courrier créé, scan `isTraite=true` lié au courrier ; scanId inconnu → 404 signalé | P1 | enregistrement.spec.ts |
| COU-08 | Saisie automatique IA désactivée | Pile E2E sans service IA | GET disponibilité ; ouvrir Enregistrement ; POST extraction-ia avec un PDF puis un TIFF | `enabled=false` ; aucune case « Saisie automatique » ; extraction PDF → 503 « L'IA est désactivée » ; TIFF → 400 | P2 | enregistrement.spec.ts |
| COU-09 | Refus sans le menu Enregistrement | Agent n'ayant que le menu Contrôle | Appels API n° suivant, disponibilité IA, POST arrivée, création de correspondant, dépôt de scan ; connexion de l'agent ; barre latérale ; accès direct à l'écran, saisie complète et envoi | API 403 « Vous n'avez pas accès à cette section. » ; entrée de menu absente ; n° proposé vide ; toast de refus à l'envoi ; POST arrivée jamais émis (dépôt du PDF refusé d'abord) | P1 | enregistrement.spec.ts |
| COU-09 (fixme) | Écran « Accès refusé » explicite en accès direct | Agent sans le menu | Ouvrir `/courriers/enregistrement` par l'URL | Écran « Accès refusé » dès l'ouverture, sans formulaire (décision de l'utilisateur). Fixme : en attente du lot transverse (AuthShell) ; le 403 de l'API est vérifié par COU-09 | P3 | enregistrement.spec.ts |

### Documents scannés

| Id | Scénario | Préconditions | Étapes | Résultat attendu | Priorité | Spec |
|---|---|---|---|---|---|---|
| COU-10 | Dépôt d'un PDF depuis l'écran | Admin connecté | Ouvrir Documents scannés ; déposer un PDF au nom unique | POST 201 ; toast « « nom » déposé. » ; ligne visible avec Consulter et Enregistrer ; scan non traité, sans courrier ni document, sans poste | P1 | documents-scannes.spec.ts |
| COU-11 | Aperçu d'un scan | Scan PDF déposé avec un poste | GET contenu et détail ; ouvrir Consulter à l'écran ; Échap ; GET d'un id inconnu | Contenu 200 `application/pdf` en `inline`, commençant par `%PDF-` ; fenêtre au nom du fichier sans « Aperçu indisponible » ; fermeture par Échap ; id inconnu → 404 (contenu et détail) | P1 | documents-scannes.spec.ts |
| COU-12 | « Enregistrer » ouvre la saisie rattachée, puis le scan quitte la file | Scan déposé ; rôle destinataire | Cliquer Enregistrer sur la ligne ; enregistrer le courrier rattaché ; recharger la file | URL `/courriers/enregistrement?scanId=<id>` et bandeau ; scan traité lié au courrier ; absent de la file API et de l'écran | P1 | documents-scannes.spec.ts |
| COU-13 | Dépôts refusés | Admin | Déposer .exe, .bmp, PDF vide par l'API ; forcer un .txt à l'écran | 400 « Extension non acceptée » / 400 « Aucun fichier reçu » ; toast d'erreur à l'écran ; aucune ligne créée | P2 | documents-scannes.spec.ts |
| COU-14 | Refus sans le menu Documents scannés | Agent avec Contrôle seul ; agent avec Enregistrement seul ; un scan | Appels liste, détail, contenu, dépôt pour chacun ; connexion de l'agent Contrôle et accès direct à l'écran | Agent Contrôle : 403 partout, entrée de menu absente, toast de refus, file vide. Agent Enregistrement : détail d'un scan 200 et dépôt 201, mais liste et contenu 403 | P1 | documents-scannes.spec.ts |

### Contrôle

| Id | Scénario | Préconditions | Étapes | Résultat attendu | Priorité | Spec |
|---|---|---|---|---|---|---|
| COU-15 | Le courrier apparaît dans la file du seul destinataire principal | Courrier arrivé enregistré pour le rôle A ; porteur de A et porteur d'un rôle B, tous deux avec le menu Contrôle | Connexion du porteur A ; ouvrir Contrôle ; ouvrir le détail ; vérifier la file du porteur B par l'API | Courrier listé chez A, compteur = total ; détail en onglets, sans bouton Valider ni Supprimer ; absent de la file de B | P1 | controle.spec.ts |
| COU-16 | Imputation depuis le contrôle : auto-validation | Courrier pour le rôle A ; porteur A ; un imputé avec Parapheur | A impute le courrier depuis le détail ; puis supprime son imputation | Imputation créée ; courrier `valider=true`, sorti de la file de A ; présent au parapheur de l'imputé ; suppression par l'auteur acceptée | P1 | controle.spec.ts |
| COU-16b | Imputation par un tiers : pas d'auto-validation | Courrier pour le rôle A ; un tiers non destinataire ; l'admin | Le tiers puis l'admin imputent le courrier par l'API | Imputations créées ; courrier toujours `valider=false` et dans la file de A | P2 | controle.spec.ts |
| COU-17 | Validation manuelle du contrôle (API) | Courrier non validé pour le rôle A | POST valider par l'API ; relire la file de A et la validation direction | `valider=true` ; courrier sorti de la file ; visible en Validation direction | P1 | controle.spec.ts |
| COU-18 | Suppression logique | Courrier non validé pour le rôle A | DELETE du courrier par l'API ; relire la file, le détail API et l'écran détail | Courrier absent de la file ; détail API 404 ; écran « Courrier introuvable » | P1 | controle.spec.ts |
| COU-19 | Refus sans le menu Contrôle | Agent avec Enregistrement seul ; destinataire et imputé avec le menu Contrôle ; courrier non validé | Agent : file, valider, supprimer, imputer par l'API ; l'imputé tente de supprimer l'imputation posée par le destinataire ; connexion de l'agent et accès direct à l'écran | 403 « Vous n'avez pas accès à cette section. » ; courrier inchangé ; 403 « Seul l'auteur de l'imputation peut la supprimer » ; entrée de menu absente ; toast de refus et file vide | P1 | controle.spec.ts |
| COU-19b | Un porteur du menu Contrôle non destinataire peut valider et supprimer | Courrier pour le rôle A ; porteur du menu Contrôle sur un rôle B | B appelle valider sur un courrier, supprimer sur un autre | 200 ; le premier est `valider=true`, le second n'est plus lisible (404). Règle confirmée par l'utilisateur : tout porteur du menu Contrôle peut valider ou supprimer | P2 | controle.spec.ts |

## 2. Parapheur, suivi, validation, notifications (COU-20 à COU-39)



Conventions : acteurs créés par test (`createCourrierActor`, rôle neuf), courriers `uniq()`, type
d'imputation NEUF `suivi=false` quand l'ouverture du parapheur ne doit pas traiter l'imputation.
Spec relative à `apps/e2e/tests/courriers/`. « fixme » = `test.fixme(true, raison)` (anomalie ou
question métier ouverte, assertion attendue écrite telle quelle).

### Parapheur (Courriers Imputés)

| Id | Scénario | Préconditions | Étapes | Résultat attendu | Priorité | Spec |
|---|---|---|---|---|---|---|
| COU-20 | File personnelle, badge du menu, ouverture de la fiche | Dest (Contrôle), imputé B et autre (Parapheur), courrier imputé à B par le destinataire (type neuf non « suivi ») | API : files de B et de l'autre, badges. UI B : ouvrir la file, lire badge, ouvrir la fiche par l'objet, onglet Imputations, retour liste. UI autre : ouvrir la file | B : file = [courrier], badge = total = 1, colonne Statut masquée ; lecture `POST :id/imputations/lecture` 200 puis `GET :id?imputations=mine` ; fiche titrée, imputation (type, B, « par Dest ») ; non traitée, courrier toujours en file. Autre : file vide « Aucun courrier imputé » | P1 | parapheur.spec.ts |
| COU-21 | Ré-imputation depuis le parapheur : rôle → porteur → type → échéance → instructions | Courrier imputé à B ; C (Parapheur) | UI B : fiche, « Ajouter une imputation », Rôle = rôle de C, Imputer à = C, type, échéance J+7, instructions, « Imputer » | 201 + toast « Imputation créée. », onglet « Imputations (2) », ligne C avec type, instructions, « Échéance JJ/MM/AAAA », « par B », pas de « Supprimer » ; API : createdBy = B, échéance au jour choisi (fuseau navigateur), C a le courrier au parapheur et la notification « Courrier imputé : … » ; B le garde | P1 | parapheur.spec.ts |
| COU-22 | Erreurs de saisie : sans destinataire, sans type, références inconnues | Courrier imputé à B ; rôle actif sans porteur ; C | UI : formulaire vide, rôle sans porteur, rôle C + C sans type, puis type, puis « Annuler ». API B : sans type, sans userGroupId, type inconnu, acteur inconnu, courrier inconnu, courrier supprimé | « Imputer » inactif tant qu'il manque destinataire OU type ; « Imputer à » inactif avant le rôle ; « Aucun utilisateur actif ne porte ce rôle » ; Annuler referme sans appel ; API 400/400/400 « Type d'imputation introuvable »/400 « Destinataire de l'imputation introuvable »/404/404 ; aucune imputation ni notification créée | P1 | parapheur.spec.ts |
| COU-23 | « En Copie » exclu du parapheur (file + badge), visible au Suivi DC ; entre au parapheur si réellement imputé | Courrier enregistré avec B en copie ; B (Parapheur + Suivi DC) | API + UI B : parapheur, badge, Suivi. Puis le destinataire impute B (type neuf) | Copie : imputation type 17, notification « Courrier enregistré, vous êtes en copie : … », parapheur vide, badge 0, ligne présente au Suivi. Après imputation réelle : parapheur = [courrier], badge 1 | P2 | parapheur.spec.ts |
| COU-24 | Lecture auto-traitée « Pour Suivi » | Courrier imputé à B en Pour Suivi (10), seule imputation | UI B : ouvrir depuis la file, retour liste | Lecture 200 `allTreated=true`, statut « Traité » ; API : imputation traitée, statut 3, dateTraited posée ; hors parapheur (badge 0) et hors Suivi ; file vide | P1 | parapheur.spec.ts |
| COU-24 | La lecture ne traite que les imputations « suivi » du lecteur | B (type neuf) et C (Pour Suivi) imputés | B appelle la lecture | fixme Q1 — attendu : l'imputation Pour Suivi de C reste non traitée et dans son parapheur | P3 | parapheur.spec.ts |
| COU-25 | `?imputations=mine` : chacun sa branche, le destinataire principal (et l'admin) tout | Dest (Contrôle+Parapheur) impute B et D ; B impute C | API : détail `mine` pour B, C, Dest, admin ; sans paramètre pour B. UI B puis Dest : fiche parapheur | B → {B, C} ; C → {C} ; Dest et admin → {B, C, D} ; sans paramètre → 3 ; UI B « Imputations (2) » sans D ; UI Dest « Imputations (3) » | P2 | parapheur.spec.ts |
| COU-26 | « Marquer traité » (API, menu Parapheur) | Courrier imputé à B et C | B : `POST :id/imputations/traiter` ; id inconnu | `allTreated`, statut 3, dateTraited, toutes imputations traitées, hors parapheurs de B et C ; 404 sur id inconnu | P1 | parapheur.spec.ts |
| COU-26 | Fiche parapheur : actions de workflow + « Traiter » par imputation | Courrier imputé à B | UI B : fiche ; « Marquer traité » | fixme A1 — attendu : boutons « Marquer traité », « Archiver », « Traiter » + « En attente » ; toast « Courrier traité. », statut Traité | P2 | parapheur.spec.ts |
| COU-27 | Archivage réservé Parapheur/Validation : dateTraited posée, statut inchangé | Courrier imputé à B ; S (Suivi seul) | S : API archiver ; UI S : fiche Suivi. B : API archiver ; id inconnu | S : 403 + bouton « Archiver » absent (« Marquer traité » présent). B : 200, dateTraited, statut 0, valider vrai, validationDirection faux ; hors Suivi et Validation ; destinataire notifié « Courrier archivé : … » ; 404 | P2 | parapheur.spec.ts |
| COU-27 | Un courrier archivé sort du parapheur | Courrier imputé à B, archivé par B | Parapheur et badge de B | fixme Q2 — attendu : absent, badge 0 | P3 | parapheur.spec.ts |
| COU-28 | Refus sans le menu Parapheur (écran + API) | Acteur « sans » (Enregistrement seul), courrier imputé à B | API sans : file, imputer, lecture, soumission, traiter, archiver. UI sans : barre latérale, `/courriers/parapheur` | 403 + « Vous n'avez pas accès à cette section. » partout, courrier inchangé ; entrée « Courriers Imputés » absente ; toast d'accès refusé + « Aucun courrier imputé » | P1 | parapheur.spec.ts |
| COU-28 | Suppression d'imputation par un autre que l'auteur | Imputation de B créée par Dest ; tiers (Contrôle+Parapheur) | B (sans Contrôle), tiers, puis Dest suppriment | B : 403 garde ; tiers : 403 « Seul l'auteur de l'imputation peut la supprimer » ; Dest : `{deleted:true}` puis 404 ; 0 imputation | P1 | parapheur.spec.ts |
| COU-29 | Soumission à validation DG / Direction (API) | Courrier imputé à B ; valideurs DG et Dir (Parapheur) | B : soumission `isDG:true` puis sans `isDG` ; lecture par DG ; erreurs ; Dest (sans Parapheur) | Types 5 et 14, createdBy B, échéance +48 h ; notifications « Soumission à validation DG/Direction : … » ; au parapheur du valideur ; non traitée à la lecture ; 400 (sans acteur, acteur inconnu), 404 (courrier inconnu), 403 sans menu ; 3 imputations | P2 | parapheur.spec.ts |
| COU-29 | Soumission à validation depuis l'écran | Courrier imputé à B | UI B : fiche parapheur | fixme Q7 — attendu : bouton « Soumettre à validation » (aucun écran ne l'expose) | P3 | parapheur.spec.ts |

### Suivi des courriers

| Id | Scénario | Préconditions | Étapes | Résultat attendu | Priorité | Spec |
|---|---|---|---|---|---|---|
| COU-30 | « Validation DG » depuis la fiche Suivi | Courrier imputé à B ; S (Suivi) | UI S : fiche Suivi, « Validation DG », onglet Imputations ; API id inconnu | Détail chargé SANS `imputations=mine` ; 200 + toast « Validation DG enregistrée. », bouton disparu ; « Imputations (2) » avec « Pour Suivi » au destinataire ; API : validationDG, imputation 10 createdBy S à +48 h, notification « Validation DG : … », au parapheur du destinataire ; 404 | P2 | suivi.spec.ts |
| COU-31 | Suivi complet : file, fiche de consultation, « Marquer traité » | Courrier imputé à B ; S (Suivi) | UI S : file (100 lignes), ligne + bouton fiche, ouvrir, actions, onglet Imputations, « Marquer traité » | Titre « Suivi des courriers » ; boutons Marquer traité / Validation DG / Décharger / Enregistrer la réponse ; ni « Archiver », ni « Ajouter une imputation », ni « Traiter » ; toast « Courrier traité. », statut Traité ; API statut 3, hors Suivi et hors parapheur de B | P1 | suivi.spec.ts |
| COU-32 | Périmètre « Suivi DC » : seulement les courriers imputés (traité, en copie compris) | DC (Suivi DC seul) : imputé en cours, imputé traité (traiter-destinataire), en copie ; un courrier imputé à un autre | API DC : file, badge, archiver. UI DC : file, badge, fiche | File = exactement les 3, total = badge = 3 ; archiver 403 ; entrée « Suivi des courriers » (altKeys) badge 3, 3 lignes, pas la 4ᵉ ; fiche avec « Marquer traité », sans « Archiver » | P1 | suivi.spec.ts |
| COU-32 | Le périmètre DC suit l'existence de l'imputation | Courrier non imputé au DC | Imputer le DC puis supprimer l'imputation (auteur) | Absent → présent → absent ; badge Suivi 0 | P2 | suivi.spec.ts |
| COU-33 | Sans permission de suivi : écran, API, badge | Acteur imputé avec Enregistrement seul | API : file Suivi, badges, traiter / validation-dg / decharge / enregistrement-reponse, fiche PDF/DOCX. UI : barre latérale, `/courriers/suivi` | 403 + message partout, drapeaux inchangés ; badge suivi 0 ; entrée absente ; toast d'accès refusé + « Aucun courrier en cours » | P1 | suivi.spec.ts |
| COU-33 | Retrait du droit effectif sans reconnexion | S (Suivi) connecté | Admin désactive le rôle (`PATCH /roles/:id {isActive:false}`) ; même jeton | Avant 200 ; après 403 + message ; badge suivi 0 | P2 | suivi.spec.ts |
| COU-34 | Fiche d'imputation : aperçu PDF, DOCX, 404, refus | Courrier imputé à B ; S (Suivi) | UI S : bouton de ligne, modale, « Télécharger (DOCX) », « Fermer ». API : PDF, DOCX, id inconnu, B (Parapheur) | PDF 200 `application/pdf`, « Imprimer » actif ; téléchargement `FICHE_IMPUTATION_<id>.docx` + toast « Fiche téléchargée (DOCX). » ; modale fermée ; API `%PDF`, `PK`, content-disposition `FICHE_IMPUTATION_<id>_` ; 404 ; 403 sans Suivi | P2 | suivi.spec.ts |
| COU-35 | Fiche d'imputation pour un utilisateur Suivi DC | DC imputé sur un courrier ; un autre courrier non imputé | API DC : fiche PDF et DOCX du courrier imputé, puis du courrier non imputé, puis d'un id inconnu ; UI DC : fiche depuis le Suivi | 200 (PDF, DOCX) ; 403 « Courrier hors de votre périmètre de suivi » ; 404 ; aperçu sans toast de refus (décision de l'utilisateur, ANO-COU-12) | P2 | suivi.spec.ts |

### Validation

| Id | Scénario | Préconditions | Étapes | Résultat attendu | Priorité | Spec |
|---|---|---|---|---|---|---|
| COU-36 | Validation Direction en lot | 3 courriers validés (imputés à B, C, C) ; V (Validation) | UI V : barre vide, 100 lignes, cocher 2, « Tout désélectionner », re-cocher, confirmation annulée, puis confirmée | Lot vide : texte d'invite + bouton inactif ; « 2 courrier(s) sélectionné(s) » ; Popconfirm « Marquer 2 courriers comme traités ? » / « Leurs imputations seront clôturées. » ; Annuler n'envoie rien ; POST `{mailIds:[m1,m2]}` → `{updated:2}`, toast « 2 courrier(s) marqué(s) comme traité(s). », 2 lignes parties, la 3ᵉ reste ; API validationDirection + Traité + imputations closes ; notifications « Validation Direction : … » au destinataire et aux imputés, pas pour le 3ᵉ ; parapheurs vidés | P1 | validation.spec.ts |
| COU-36 | Erreurs de saisie du lot | V | API : `[]`, corps vide, id non numérique, id inconnu | 400, 400, 400, `{updated:0}` | P1 | validation.spec.ts |
| COU-36 | Lot sur un courrier déjà archivé | Courrier archivé par V | API lot sur son id | `{updated:0}`, dateTraited et statut inchangés (ANO-COU-13 corrigée) | P2 | validation.spec.ts |
| COU-37 | Visualiseur : « Traiter » par destinataire, « Archiver » | Courrier imputé à B et C ; V | UI V : ouvrir la popup, onglet Imputations, « Traiter » sur B, « Archiver », « Fermer » | Actions Marquer traité / Validation DG / Archiver ; POST `{userGroupId:B}` 200, toast « Imputations de B traitées. », B « Traitée », C « En attente » ; courrier non forcé (statut 0) ; auteur notifié « Imputation traitée par B : … » ; B hors parapheur, C dedans ; archivage 200 + toast « Courrier archivé. », boutons retirés, ligne partie ; dateTraited posée, statut 0 | P2 | validation.spec.ts |
| COU-38 | Refus sans le menu Validation | Acteur Parapheur seul, imputé | API : file, lot, traiter-destinataire. UI : barre latérale, `/courriers/validation` | 403 + message, courrier et imputation inchangés ; entrée « Validation » absente ; toast + « Aucun courrier à traiter », bouton de lot inactif | P1 | validation.spec.ts |

### Notifications in-app

| Id | Scénario | Préconditions | Étapes | Résultat attendu | Priorité | Spec |
|---|---|---|---|---|---|---|
| COU-39 | Imputation notifiée, cloche, « Tout marquer lu », isolement ; e-mail sans SMTP sans échec | Dest, B, autre ; pile sans SMTP | Dest impute B ; API B et autre ; UI B : cloche, liste, « Tout marquer lu » ; seconde imputation, acquittement unitaire ×2 | Action 201 ; B : 1 non lue « Courrier imputé : … » (cible mail), compteur 1 ; autre : ne la voit pas, PATCH → `{updated:0}` ; cloche « 1 », message listé, « Tout marquer lu » → PATCH 200, compteur disparu, bouton inactif, API 0 non lue ; acquittement unitaire `{updated:1}` puis `{updated:0}` | P2 | notifications.spec.ts |
| COU-39 | Boîte vide | Acteur neuf | UI : cloche | Pas de compteur, « Aucune notification », « Tout marquer lu » inactif | P3 | notifications.spec.ts |

Total : 30 scénarios — P1 : 13, P2 : 12, P3 : 5.

## 3. Départ, intégration décharge, recherche, tableau de bord, parcours (COU-40 à COU-64)



Plage : COU-40 à COU-59 (écrans), COU-60 à COU-64 (parcours). Spec = chemin relatif à `apps/e2e/tests/courriers/`.
Acteurs créés par `createCourrierActor` (rôle neuf + utilisateur), référentiels uniques par `createCourrierRefs`.

### Courrier de départ (`/courriers/depart`)

| Id | Scénario | Préconditions | Étapes | Résultat attendu | Priorité | Spec |
|---|---|---|---|---|---|---|
| COU-40 | Création nominale d'un départ avec type, correspondant et PDF | Acteur « rédacteur » (menu Départ) ; référentiels uniques (type de départ, entité externe) | Se connecter ; choisir le type (le n° se propose) ; saisir objet et date ; choisir le destinataire externe ; déposer un PDF ; « Créer le courrier de départ » | Toast « Courrier de départ créé. », formulaire vidé ; en base : type Départ, statut Rédigé, n° 00001 du type, émetteur = rédacteur, 1 pièce ; le départ figure dans les décharges en attente ; le scan est sorti de la file | P1 | depart.spec.ts |
| COU-41 | Départ lié à un courrier (réponse) : le courrier lié est archivé | Arrivée non archivée du même correspondant | « Lié au courrier » désactivé tant qu'aucun correspondant ; choisir le correspondant puis le courrier lié ; changer de correspondant vide la sélection ; recréer et valider | Le départ porte `mailParent` ; l'arrivée passe archivée (`dateTraited`) et reçoit le PDF de la réponse ; n° suivant du type proposé (00002) | P1 | depart.spec.ts |
| COU-42 | Erreurs de saisie (sans objet, sans date, fichier non PDF, objet blanc, API invalide) | Acteur rédacteur | Soumettre le formulaire vide ; déposer un .txt ; objet « ␣␣␣ » + PDF ; POST API sans objet / sans date / objet blanc / date invalide / courrier lié inexistant | Messages « L'objet est obligatoire » et « La date est obligatoire », aucun POST envoyé ; toast « Seuls les fichiers PDF sont acceptés. » ; objet blanc refusé sous le champ SANS dépôt du PDF (anomalie suspectée) ; API 400 ; courrier lié inexistant refusé en 4xx, jamais 500 (anomalie suspectée) | P1 | depart.spec.ts |
| COU-43 | Refus par permission (sans menu Départ) | Acteur avec seulement la Recherche | Ouvrir l'URL directe et tenter de créer ; appels API directs | Entrée de menu absente ; toast « Vous n'avez pas accès à cette section. » à la création ; API POST /courriers/depart, GET by-external-entity et next-reference en 403 | P1 | depart.spec.ts |

### Intégration décharge (`/courriers/integration-decharge`)

| Id | Scénario | Préconditions | Étapes | Résultat attendu | Priorité | Spec |
|---|---|---|---|---|---|---|
| COU-44 | Intégration nominale de la décharge signée d'un départ lié | Arrivée + départ lié (avec PDF) créés par API | Choisir le départ ; déposer le PDF ; « Intégrer la décharge » ; confirmer « Intégrer » | Toast « Décharge intégrée : courrier déchargé et archivé. » ; le départ quitte la liste ; statut Déchargé, `dateDecharge` et `dateTraited` posés ; pièce `decharge=true` sur le départ ET sur le courrier parent ; scan traité | P1 | integration-decharge.spec.ts |
| COU-45 | Erreurs de saisie et annulation | Départ en attente | Soumettre sans rien ; choisir un courrier sans pièce ; déposer un .txt ; retirer la pièce ; « Annuler » la confirmation ; API sans pièce | « Le courrier est obligatoire », « Le scan de la décharge signée est obligatoire » ; toast PDF seul ; la confirmation n'apparaît qu'une fois le formulaire valide, « Annuler » n'envoie rien (départ toujours en attente) ; API 400 | P1 | integration-decharge.spec.ts |
| COU-46 | Intégration hors périmètre fonctionnel (API) | Arrivée non archivée ; départ déjà déchargé | POST integration-decharge sur une ARRIVÉE ; second POST sur le départ déjà déchargé | Arrivée : 400 « La décharge ne s’intègre que sur un courrier départ », courrier inchangé (décision de l'utilisateur, ANO-COU-15) ; double intégration : question métier ouverte (`test.fixme`) | P2 | integration-decharge.spec.ts |
| COU-47 | Refus par permission (sans menu Intégration décharge) | Acteur avec seulement la Recherche | URL directe ; API | Menu absent ; toast « Vous n'avez pas accès à cette section. » au chargement de la liste ; API GET decharges-en-attente et POST integration-decharge en 403 | P1 | integration-decharge.spec.ts |

### Recherche courrier (`/courriers/recherche`, `/courriers/recherche/[mailId]`)

| Id | Scénario | Préconditions | Étapes | Résultat attendu | Priorité | Spec |
|---|---|---|---|---|---|---|
| COU-48 | Recherche plein texte d'un courrier archivé et consultation en lecture seule | Arrivée archivée (API) avec PDF | Saisir le préfixe unique, Entrée ; ouvrir le résultat | 1 résultat (n°, objet, sens Arrivée, correspondant, destinataire) ; puce « Texte : « … » » ; détail : titre, onglet Fichiers (1), aucune action de workflow, ni imputation, ni archivage | P1 | recherche.spec.ts |
| COU-49 | Filtres combinés, puces et exclusion des courriers non archivés | Arrivée archivée + arrivée en cours + départ déchargé, même correspondant | Rechercher le préfixe ; filtrer Sens=Départ ; puis Statut ; retirer une puce ; « Tout effacer » | Le courrier en cours n'apparaît jamais ; Sens=Départ → seul le départ ; puces affichées et retirables ; « Tout effacer » réinitialise les champs | P1 | recherche.spec.ts |
| COU-50 | Recherche sans résultat | — | Texte aléatoire | « 0 résultat » et « Aucun courrier archivé ne correspond » ; aucun toast d'erreur | P1 | recherche.spec.ts |
| COU-51 | Dates inversées et dates invalides | Arrivée archivée datée | UI : « Du » postérieur à « Au » ; API : plage inversée ; API : `dateFrom` « abc » / « 2026-13-01 » | UI : aucune erreur, les champs Du/Au et la puce affichent exactement les bornes envoyées, nombre de résultats cohérent ; API plage inversée : 200 et 0 résultat ; date invalide : 400 (corrigé, était 500) | P2 | recherche.spec.ts |
| COU-51 (fixme) | Plage saisie à l'envers au clavier : les deux jours sont conservés (réordonnés) | Arrivée archivée datée | UI : saisir « Du » 31/03 puis « Au » 01/03 | Attendu supposé : recherche du 01/03 au 31/03. Fixme, question métier : le RangePicker remplace « Au » par « Du » sans avertir (réordonner, refuser ou laisser tel quel ?) | P3 | recherche.spec.ts |
| COU-52 | Refus par permission (sans menu Recherche) | Acteur avec seulement le Départ | URL directe ; API | Menu absent ; toast « Vous n'avez pas accès à cette section. » ; POST /courriers/recherche en 403 | P1 | recherche.spec.ts |

### Tableau de bord (`/courriers/tableau-de-bord`)

| Id | Scénario | Préconditions | Étapes | Résultat attendu | Priorité | Spec |
|---|---|---|---|---|---|---|
| COU-53 | Affichage nominal en périmètre global | Acteur tableau de bord + Suivi permanent | Ouvrir l'écran | « Périmètre : tous les courriers » ; les 9 widgets de l'agencement livré, dont « Charge de travail » ; tuiles de files et chiffres clés chargés ; API layout `scope=all`, `parDefaut=true` | P1 | tableau-de-bord.spec.ts |
| COU-54 | Personnalisation : retirer, enregistrer, persister, réinitialiser | Acteur neuf (agencement par défaut) | « Personnaliser » ; retirer « Hygiène des données » ; « Enregistrer » ; recharger ; « Personnaliser » → « Réinitialiser » | Toast « Tableau de bord enregistré » ; widget absent après rechargement, `parDefaut=false` ; « Agencement par défaut rétabli » et widget revenu | P1 | tableau-de-bord.spec.ts |
| COU-55 | Personnalisation : ajouter un widget, annuler une édition | Agencement enregistré sans un widget | « Ajouter un widget » (liste = catalogue autorisé moins les widgets placés) ; ajouter ; annuler ; puis ajouter et enregistrer | « Annuler » rend l'agencement enregistré ; après ajout + enregistrement le widget est présent et persiste | P2 | tableau-de-bord.spec.ts |
| COU-56 | Périmètre « sur mes imputations » (Suivi DC) | Acteur tableau de bord + Suivi DC, imputé sur 1 arrivée | Ouvrir l'écran ; API | « Périmètre : les courriers où vous êtes imputé » ; « Charge de travail » absent de l'écran et du catalogue ; chiffres = ses seuls courriers (En cours 1) ; API charge 403 ; un agencement contenant « charge » est enregistré sans lui | P1 | tableau-de-bord.spec.ts |
| COU-57 | Aucun périmètre de suivi | Acteur tableau de bord seul | Ouvrir l'écran ; API | Alerte « Aucun périmètre de suivi ne vous est accordé », pas de « Personnaliser » ; API layout `scope=none`, aucun widget ; données à zéro | P1 | tableau-de-bord.spec.ts |
| COU-58 | Refus par permission (sans menu Tableau de bord) | Acteur avec Suivi permanent seul | URL directe ; API | Entrée « Tableau de bord » Docu-Courriers absente ; toast « Vous n'avez pas accès à cette section. » ; API layout et données en 403 | P1 | tableau-de-bord.spec.ts |
| COU-59 | Filtres invalides du tableau de bord | Admin | POST synthese/flux avec date inexistante, champ inconnu, dimension hors liste blanche | 400 (date inexistante corrigée, était 500 sur 2026-13-01) | P2 | tableau-de-bord.spec.ts |

### Parcours de bout en bout

| Id | Scénario | Préconditions | Étapes | Résultat attendu | Priorité | Spec |
|---|---|---|---|---|---|---|
| COU-60 | Parcours complet par l'interface : enregistrement → contrôle → imputation → parapheur → suivi → validation → réponse (départ lié) → décharge → recherche → tableau de bord | Acteurs : bureau d'ordre (enregistrement, départ, décharge, recherche), destinataire (contrôle), imputé (parapheur, suivi DC, tableau de bord), validateur (validation) ; référentiels uniques | Chaque étape par l'écran de l'acteur concerné, connexion par `loginAs` | Le courrier passe d'écran en écran (contrôle → parapheur/suivi → validation), en sort au bon moment ; le départ lié archive l'arrivée ; la décharge clôt le départ ; la recherche retrouve les deux, fichiers 3 et 2 ; le tableau de bord de l'imputé passe de 0 à 1 en cours puis 0 en cours / 1 archivé | P1 | parcours-bout-en-bout.spec.ts |
| COU-61 | Compteurs du tableau de bord à chaque étape (vue globale filtrée sur le correspondant) | Même parcours piloté par API | Lire `dashboard/files` + `synthese` (filtre `externalEntityId`) après chaque étape | À contrôler 1→0 (non vérifié après le départ, cf. COU-64) ; Parapheur 0→1→0 ; Validation Direction 0→1→0 ; En cours 1→0→1 (départ)→0 ; Décharges en attente 0→1→0 ; Archivés = 2 en fin d'échange (arrivée + départ, §3.7) | P1 | parcours-bout-en-bout.spec.ts |
| COU-62 | Badges de menu et notifications au fil du parcours | Même parcours (API) | Lire `/courriers/badges` et `/notifications` de chaque acteur | Badge Contrôle du destinataire 0→1→0 ; Parapheur de l'imputé 0→1→0 ; destinataire : « Nouveau courrier enregistré », « Courrier à imputer », « Validation Direction », « Courrier traité et archivé — réponse envoyée », « Décharge reçue — échange clos » ; imputé : « Courrier imputé » + les trois dernières ; émetteur du départ : « Décharge intégrée » (et pas « réponse envoyée ») | P2 | parcours-bout-en-bout.spec.ts |
| COU-63 | Réponse par départ AVANT la validation : la réponse clôt le courrier | Arrivée imputée non validée | Créer le départ lié ; consulter Suivi, Validation, Recherche | L'arrivée sort du Suivi et de la Validation, apparaît dans la Recherche dès la réponse | P2 | parcours-bout-en-bout.spec.ts |
| COU-64 | Courriers clos restant dans des files personnelles | (a) Arrivée imputée puis close par départ lié ; (b) départ rédigé par un acteur portant aussi le Contrôle | (a) Parapheur et badge de l'imputé ; (b) Contrôle du rédacteur | Questions métier ouvertes (`test.fixme`) : (a) le courrier archivé reste au parapheur tant que l'imputation n'est pas traitée ; (b) un Départ (valider=false) figure au Contrôle de son rédacteur et dans la tuile « À contrôler », même archivé | P3 | parcours-bout-en-bout.spec.ts |

## 4. Paramétrage et permissions de menu (COU-70 à COU-99)



### Référentiels plats (natures, confidentialités, types de courrier départ, types d'entité externe — `/admin/courriers/{natures,confidentialites,types-depart,types-entites-externes}`)

| Id | Scénario | Préconditions | Étapes | Résultat attendu | Priorité | Spec |
|---|---|---|---|---|---|---|
| COU-70 | Création d'un élément depuis le formulaire (×4 référentiels) | Admin connecté | Ouvrir l'écran ; saisir « ␣␣X␣␣␣␣bis␣␣ » dans Libellé ; Ajouter | POST 201, libellé stocké « X bis » (espaces compactés, casse conservée) ; toast « Élément créé » ; champ vidé ; ligne présente ; lookup GET la contient | P1 | admin/referentiels-simples.spec.ts |
| COU-71 | Renommage en place (×4) | Élément X et élément Y actifs (API) | Cliquer le libellé de X, saisir un nouveau nom, Entrée ; puis le passer en majuscules ; puis tenter le libellé de Y (casse/espaces différents) | PATCH 200 + « Modifié » ; changer sa propre casse permis ; libellé d'un autre actif → 409, message serveur affiché, ligne inchangée ; API PATCH variante → 409 | P1 | admin/referentiels-simples.spec.ts |
| COU-72 | Désactivation confirmée (×4) | Élément X actif (API) | Bouton « Désactiver … » de la ligne ; confirmer « Désactiver » | DELETE 200 `{deactivated:true}` ; toast « Élément désactivé » ; X absent de toutes les pages du tableau et du lookup ; recréer X par l'API → 201 (unicité parmi les actifs seulement) | P1 | admin/referentiels-simples.spec.ts |
| COU-73 | Erreurs de saisie (×4) | Élément X actif | Libellé vide puis espaces seuls ; variante normalisée de X ; API : libellé vide, corps vide, variante, PATCH/DELETE d'un identifiant inconnu | Bouton Ajouter désactivé ; doublon → 409 + message « … actif(ve) porte déjà ce libellé », saisie conservée ; API 400 / 400 / 409 ; inconnu → 404 (et non 500) | P1 | admin/referentiels-simples.spec.ts |
| COU-74 | Visibilité dans les listes des formulaires | Élément actif créé par l'API | Type de départ : Select « Type de courrier départ » du Départ ; nature : filtre « Nature » de la Recherche ; type d'entité externe : champ « Type » des entités externes ; confidentialité/objet : lookups API ; désactiver puis rouvrir | Proposé tant qu'actif, absent après désactivation | P1 | admin/referentiels-simples.spec.ts |

### Objets de courrier (`/admin/courriers/objets`, écran masqué)

| Id | Scénario | Préconditions | Étapes | Résultat attendu | Priorité | Spec |
|---|---|---|---|---|---|---|
| COU-75 | Création avec durées, durée modifiée en place, renommage, désactivation | Admin | Libellé + durées 5/3 ; Ajouter ; changer la durée externe à 8 + Entrée ; renommer ; désactiver | POST `{label,5,3}` 201 + « Objet créé » ; cellules 5/3 ; PATCH `{dureeSuiviExterne:8}` + « Modifié » ; renommage 200 ; « Objet désactivé », ligne et lookup vidés | P1 | admin/referentiels-simples.spec.ts |
| COU-76 | Erreurs de saisie objets | Objet X actif | Libellé vide/espaces ; variante de X ; API : libellé vide, durée −1, durée 1,5, PATCH vide, inconnu | Ajouter désactivé ; 409 + message ; 400 ×4 ; inconnu → 404 | P2 | admin/referentiels-simples.spec.ts |

### Entités externes (`/admin/courriers/entites-externes`)

| Id | Scénario | Préconditions | Étapes | Résultat attendu | Priorité | Spec |
|---|---|---|---|---|---|---|
| COU-77 | Création complète puis filtre par nom | Type d'entité créé (API) | Nom, Type (Select), E-mail, Téléphone ; Ajouter ; filtrer par le nom (minuscules) puis par un nom absent | POST 201 avec le corps saisi ; « Entité externe créée » ; ligne avec type/e-mail/téléphone ; « Aucun correspondant ne porte ce nom » | P1 | admin/entites-externes.spec.ts |
| COU-78 | Modification en place (nom, type, e-mail effacé, téléphone) | Correspondant typé A | Éditer chaque cellule ; choisir le type B dans la liste | PATCH ciblés (`{label}`, `{externalEntityTypeId:B}`, `{email:null}`, `{telephone}`) ; état API conforme | P1 | admin/entites-externes.spec.ts |
| COU-79 | Désactivation | Correspondant actif proposé au Départ | Désactiver + confirmer | « Entité externe désactivée » ; absent de l'annuaire, du lookup et du Select « Destinataire externe » du Départ | P1 | admin/entites-externes.spec.ts |
| COU-80 | Erreurs de saisie | — | Nom vide/espaces ; e-mail invalide ; API : nom vide, type 0, type inconnu, PATCH vide, PATCH type inconnu, inconnu | Ajouter désactivé (nom vide, e-mail invalide en erreur) ; 400 ; type inconnu → 400 (et non 500) ; inconnu → 404 ; [fixme] e-mail invalide refusé par l'API ? | P2 | admin/entites-externes.spec.ts |
| COU-81 | Bouton « + » du champ Type | — | « Créer un type d'entité externe » ; saisir ; Créer ; créer un correspondant ; rouvrir et saisir une variante du même type | Type créé (201), toast, modale fermée, type sélectionné, correspondant créé avec ce type, type visible dans le référentiel dédié ; doublon → 409 + message, modale ouverte, champ vierge à la réouverture | P1 | admin/entites-externes.spec.ts |
| COU-82 | Propriétés personnalisées (EAV) par l'API | Correspondant typé, correspondant sans type | Créer une propriété (doublon, vide) ; poser A puis B ; valeur sur entité sans type, entité inconnue, propriété inconnue, sans valeur ; désactiver la propriété | Libellé normalisé, 409/400 ; une seule valeur « B » (upsert), type déduit de l'entité ; 409 « n'a pas de type » ; 404 ; 404 (et non 500) ; 400 ; propriété retirée du lookup, inconnue → 404 | P2 | admin/entites-externes.spec.ts |
| COU-83 | Doublon de nom de correspondant | Correspondant « X » | Créer « X » en majuscules | [fixme — question métier] 409 attendu par la source (§17) ; la V6 accepte | P2 | admin/entites-externes.spec.ts |

### Organigrammes (`/admin/courriers/organigrammes`)

| Id | Scénario | Préconditions | Étapes | Résultat attendu | Priorité | Spec |
|---|---|---|---|---|---|---|
| COU-84 | Création d'une racine puis d'un enfant | Admin | Nom du nœud ; Ajouter ; puis enfant avec « Parent » choisi dans l'arbre | POST `{label}` puis `{label,parentId}` 201 ; « Nœud créé » ; Parent « — Racine — » / libellé du parent ; chemin `/<id>/` et `<chemin parent><id>/`, profondeur 0/1 | P1 | admin/organigrammes.spec.ts |
| COU-85 | Renommage en place | Parent + enfant | Renommer le parent (espaces de bordure) | PATCH 200 + « Modifié » ; libellé repris dans la colonne Parent de l'enfant | P1 | admin/organigrammes.spec.ts |
| COU-86 | Déplacement par la colonne Parent | A, B racines ; C sous A ; D sous C | Changer le parent de C pour B ; puis C à la racine (API) | PATCH `{parentId:B}` + « Nœud déplacé » ; chemins/profondeurs de C et D recalculés ; retour racine par l'API | P1 | admin/organigrammes.spec.ts |
| COU-87 | Déplacements interdits | A racine, C sous A, nœud désactivé | A sous C ; A sous A ; API : parent inconnu, parent désactivé, corps vide, nœud inconnu | 400 « Déplacement cyclique interdit » / « Un nœud ne peut être son propre parent » ; 400 ; 400 ; 400 ; 404 ; A inchangé | P1 | admin/organigrammes.spec.ts |
| COU-88 | Désactivation d'un nœud | A > B > C, frère S sous A | Désactiver B | « Nœud et son sous-arbre désactivés » ; B et C absents (écran, API) ; A et S présents | P1 | admin/organigrammes.spec.ts |
| COU-89 | Erreurs de saisie | Nœud désactivé | Nom vide/espaces ; API : nom vide, parent inconnu, parent désactivé, renommage vide, inconnu ; [fixme] frères homonymes | Ajouter désactivé ; 400 ×4 ; 404 ; [fixme] 409 ? | P2 | admin/organigrammes.spec.ts |

### Rôles ↔ organigramme (`/admin/courriers/role-organigramme`)

| Id | Scénario | Préconditions | Étapes | Résultat attendu | Priorité | Spec |
|---|---|---|---|---|---|---|
| COU-90 | Rattacher un rôle à un nœud ; dérivation sur le courrier | Acteur (rôle neuf « Non rattaché »), nœud | Cliquer « — » de la ligne du rôle, choisir le nœud ; enregistrer un courrier pour ce rôle | PATCH 200 + « Assignation enregistrée » ; tag « Non rattaché » retiré ; API à jour ; `mail.organigramme.label` = nœud | P1 | admin/organigrammes.spec.ts |
| COU-91 | Erreurs et détachement | Acteur, nœud actif, nœud désactivé | API : nœud inconnu, nœud désactivé, corps vide, rôle inconnu ; rattacher puis détacher (null) ; [fixme] détacher depuis l'écran | 400 ×3 ; 404 ; « Non rattaché » après détachement ; courrier sans organigramme ; [fixme] aucun contrôle de détachement à l'écran | P2 | admin/organigrammes.spec.ts |

### Types d'imputation (`/admin/courriers/types-imputation`)

| Id | Scénario | Préconditions | Étapes | Résultat attendu | Priorité | Spec |
|---|---|---|---|---|---|---|
| COU-92 | Types système 5/10/14/17 protégés | Seed | Ouvrir l'écran ; API DELETE de chacun | Tag « système », aucun bouton de désactivation ; DELETE → 409 (message « système ») ; les 4 restent actifs | P1 | admin/types-imputation.spec.ts |
| COU-93 | Création avec suivi, bascule, renommage, désactivation | Admin | Libellé + interrupteur « Traitement automatique à la lecture » ; Ajouter ; basculer l'interrupteur de ligne ; renommer ; désactiver | POST `{label,suivi:true}` 201 + toast ; formulaire remis à zéro ; pas de tag système ; PATCH `{suivi:false}` ; lookup à jour ; « Type désactivé », ligne retirée | P1 | admin/types-imputation.spec.ts |
| COU-94 | Erreurs de saisie | Type X | Vide/espaces ; variante de X ; API : vide, suivi non booléen, PATCH vide, propre casse, inconnu | Ajouter désactivé ; 409 + message ; 400 ×3 ; 200 ; 404 | P2 | admin/types-imputation.spec.ts |

### Permissions de menu (transverse — `/courriers/*` et `/admin/courriers/*`)

| Id | Scénario | Préconditions | Étapes | Résultat attendu | Priorité | Spec |
|---|---|---|---|---|---|---|
| COU-95 | Écran opérationnel sans le menu (×10 écrans) + accès direct par URL | Acteur portant un menu témoin de la section | API lecture gardée + écriture ; barre latérale sur l'écran témoin ; URL directe ; [fixme] écran « Accès refusé » | 403 « Vous n'avez pas accès à cette section. » ; entrée absente (témoin visible) ; chargement refusé 403 + toast (écrans qui chargent une liste gardée) ; [fixme] écran « Accès refusé » dès l'ouverture, en attente du lot transverse | P1 | permissions.spec.ts |
| COU-96 | Écran opérationnel avec le menu (×10) + permission Suivi DC | Acteur portant le seul menu | API lecture ; ouvrir l'écran ; Suivi DC : `/courriers/suivi` et fiche d'imputation | 200 ; titre et entrée visibles ; DC : entrée « Suivi des courriers » visible (altKeys), suivi 200, fiche d'un courrier inconnu → 404 (pas 403) | P1 | permissions.spec.ts |
| COU-97 | Écran de paramétrage sans le menu (×6) ; correspondant créé depuis l'Enregistrement | Acteur témoin ; données cibles admin | Écritures API de l'écran ; barre latérale ; URL directe puis Ajouter ; acteur « Enregistrement » : créer / modifier / désactiver un correspondant, propriété, valeur | 403 sur chaque écriture ; entrée absente ; écran affiché (lectures ouvertes) mais création refusée 403 + toast, rien créé ; Enregistrement : création 201, le reste 403, lectures 200 | P1 | permissions.spec.ts |
| COU-98 | Écran de paramétrage avec le menu (×6) | Acteur portant le seul menu | Écriture nominale ; ouvrir l'écran | 201 (POST) / 200 (PATCH) ; titre et entrée visibles | P1 | permissions.spec.ts |
| COU-99 | Écrans masqués natures/objets/confidentialités : administrateur seul | Admin ; acteur demandé avec les 3 clés masquées | Catalogue `/roles/menus` ; rôle créé ; `/auth/me` ; écritures/lecture API de l'acteur ; admin par URL ; barre latérale | Clés absentes du catalogue, retirées du rôle et des menus effectifs ; acteur : écritures 403, lecture 200 ; admin : écran + fil d'Ariane « Paramétrage Courrier », création 201 ; aucune entrée de menu | P1 | permissions.spec.ts |
