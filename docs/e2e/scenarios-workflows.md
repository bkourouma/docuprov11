# Scénarios E2E : Docu-Flow (workflows)

Lot 4. Écrans couverts : conception (liste, éditeur, modèles, langage naturel), lancement, boîte de tâches, suivi
des instances (liste, détail, administration), garde-fous des agents (plafonds et arrêt d'urgence, outils
autorisés, évaluation), déclencheurs.

Conventions :

- Les specs sont sous `apps/e2e/tests/workflows/` ; la colonne « Spec » donne le chemin relatif à `apps/e2e/`.
- Les données sont créées par l'API (`_helpers/wf-api.ts`, `_helpers/users.ts`, `_helpers/agents.ts`). Chaque test
  nomme ses objets avec `uniq()`.
- Les utilisateurs de test ont un rôle aux menus exacts : conception (`/workflows/conception`), lancement
  (`/workflows/lancer`), administration (`/workflows/administration`). La boîte n'a pas de menu : son périmètre est
  l'assignation.
- La pile E2E n'a aucun fournisseur d'IA. Les parties qui en dépendent sont testées par leur état « sans IA » :
  - l'étape agent revient à un humain ;
  - la génération en langage naturel répond 409 ;
  - le run d'évaluation se termine en erreur.
- Le plafond global et l'arrêt d'urgence global sont partagés par toute la pile, et le répartiteur des
  déclencheurs lit l'arrêt global. Aucun test ne les modifie ; ils agissent seulement sur des lignes propres à un
  workflow.
- Priorités : P1 = parcours et droits essentiels ; P2 = erreurs de saisie et cas secondaires ; P3 = non
  automatisé (`test.fixme`, avec sa raison).

## Parcours de bout en bout

| Id | Scénario | Préconditions | Étapes | Résultat attendu | Priorité | Spec |
|---|---|---|---|---|---|---|
| WF-01 | Concevoir, publier, lancer, traiter à deux valideurs avec renvoi en correction, suivre jusqu'au terme | Lanceur (menu lancer), valideurs V1 et V2 (sans menu) ; définition « circuit de validation » créée par l'API en brouillon | 1. Admin : publier dans l'éditeur. 2. Lanceur : lancer, saisir la demande. 3. V1 : rejeter. 4. Lanceur : corriger. 5. V1 : approuver (passage 2). 6. V2 : approuver le visa. 7. Lanceur : ouvrir le détail. | Statut « Terminée » ; étapes franchies et journal complets ; le filtre « Validations » montre 2 « a accepté la validation » ; la ligne apparaît dans le suivi | P1 | tests/workflows/parcours/circuit-validation.spec.ts |
| WF-02 | Refus sans voie de correction : suspension puis reprise | Circuit publié, instance au visa final | V2 rejette le visa ; le lanceur clique « Reprendre » | Instance « Suspendue », puis tâche « Visa final (passage 2) » rouverte | P1 | tests/workflows/parcours/circuit-validation.spec.ts |
| WF-03 | Annulation par le lanceur | Instance en attente du valideur | Le lanceur annule dans le détail | Instance « Annulée », tâches annulées, boîte du valideur vide | P1 | tests/workflows/parcours/circuit-validation.spec.ts |
| WF-04 | « Ne pas approuver » distinct du refus | Instance à l'étape de validation | Le valideur choisit « Ne pas approuver » avec un commentaire | Événement `validation.rejected` (pas `task.rejected`) ; tâche de correction ouverte ; résultat `{approved:false, comment}` | P1 | tests/workflows/parcours/circuit-validation.spec.ts |

## Conception : liste des définitions

| Id | Scénario | Préconditions | Étapes | Résultat attendu | Priorité | Spec |
|---|---|---|---|---|---|---|
| WF-10 | Liste, recherche, filtre de statut | Une définition publiée et un brouillon | Rechercher le préfixe, filtrer « Publié » | Seule la publiée reste ; statuts affichés | P1 | tests/workflows/conception/definitions.spec.ts |
| WF-11 | Créer un workflow par l'écran | Admin | « Nouveau workflow », saisir le nom, « Créer et ouvrir » | 201 ; l'éditeur s'ouvre sur un brouillon | P1 | tests/workflows/conception/definitions.spec.ts |
| WF-12 | Nom vide ou déjà utilisé | Une définition existante | Créer sans nom, puis avec le nom existant | Messages « Le nom est obligatoire… » puis 409 « Ce nom est déjà utilisé… » ; rien n'est créé | P2 | tests/workflows/conception/definitions.spec.ts |
| WF-13 | Archiver depuis la liste | Définition publiée | « Archiver », confirmer | Statut « Archivé » ; absente des lançables ; lancement 409 | P2 | tests/workflows/conception/definitions.spec.ts |
| WF-14 | Refus sans menu conception | Utilisateur avec le seul menu lancer | Ouvrir la conception ; appeler l'API | Écran « Accès refusé » ; API 403 | P1 | tests/workflows/conception/definitions.spec.ts |

## Conception : éditeur

| Id | Scénario | Préconditions | Étapes | Résultat attendu | Priorité | Spec |
|---|---|---|---|---|---|---|
| WF-15 | Palette, liaison en vue liste, enregistrement, publication | Brouillon à une étape | Ajouter « Validation », relier en vue liste, enregistrer, publier | Problème « Étape jamais utilisée » puis disparu ; « Brouillon enregistré à hh:mm. » ; version 1 publiée | P1 | tests/workflows/conception/editeur.spec.ts |
| WF-16 | Relier deux étapes dans le canevas | Brouillon à deux étapes non reliées | Glisser de la poignée de « Début » vers « Contrôle » | Transition « Transition de « Début » vers « Contrôle » » visible et enregistrée | P2 | tests/workflows/conception/editeur.spec.ts |
| WF-17 | Graphe non publiable | Brouillon avec une étape orpheline | Ouvrir l'éditeur ; publier par l'API | Problème expliqué en français, lien vers l'étape ; « Publier » désactivé ; API 422 `UNREACHABLE_STEP` | P1 | tests/workflows/conception/editeur.spec.ts |
| WF-18 | « Vérifier » un brouillon correct | Brouillon valide | « Vérifier » | Message « Vérification réussie… » | P2 | tests/workflows/conception/editeur.spec.ts |
| WF-19 | Nom d'étape vide | Brouillon | Vider le nom, enregistrer | Aucun PUT ; message « Enregistrement impossible, complétez d'abord : … » | P2 | tests/workflows/conception/editeur.spec.ts |
| WF-20 | Version publiée en lecture seule ; nouveau brouillon | Définition publiée | « Plus » puis « Créer un brouillon à partir de cette version » | Brouillon version 2 créé ; liste des versions à jour | P2 | tests/workflows/conception/editeur.spec.ts |
| WF-21 | Quitter avec des modifications non enregistrées | Brouillon modifié | Cliquer le fil d'Ariane | Confirmation « Quitter sans enregistrer ? » ; « Rester » garde l'éditeur | P2 | tests/workflows/conception/editeur.spec.ts |
| WF-22 | Concepteur non administrateur | Concepteur sans administration | Ouvrir l'éditeur ; appeler l'API | Ni lien « Outils autorisés » ni interrupteur « faible risque » ; API 403 sur le faible risque et les outils | P1 | tests/workflows/conception/editeur.spec.ts |

## Conception : modèles et langage naturel

| Id | Scénario | Préconditions | Étapes | Résultat attendu | Priorité | Spec |
|---|---|---|---|---|---|---|
| WF-23 | Brouillon depuis un modèle | Admin | « Depuis un modèle », choisir « Demande avec liste de vérification » | Nouveau brouillon ouvert dans l'éditeur (archivé en fin de test) | P2 | tests/workflows/conception/modeles-langage-naturel.spec.ts |
| WF-24 | « Décrire le besoin » sans IA | Pile sans IA | Décrire le besoin, « Générer le brouillon » | 409 ; message « L'IA est désactivée pour ce client… » ; aucune définition créée | P1 | tests/workflows/conception/modeles-langage-naturel.spec.ts |

## Lancement

| Id | Scénario | Préconditions | Étapes | Résultat attendu | Priorité | Spec |
|---|---|---|---|---|---|---|
| WF-30 | Catalogue lançable et lancement | Définitions publiée, brouillon et archivée | Rechercher, lancer la publiée avec des données JSON | Seule la publiée est proposée ; 201 ; « Workflow lancé. » ; détail « En attente » avec le contexte | P1 | tests/workflows/lancer/lancer.spec.ts |
| WF-31 | Erreurs de saisie | Définition publiée | JSON invalide, tableau, objet lié incomplet, clé vide | Quatre messages dédiés ; aucun POST | P2 | tests/workflows/lancer/lancer.spec.ts |
| WF-32 | Idempotence | Instance lancée avec une clé | Relancer avec la même clé ; un autre lanceur reprend la clé | 200 et retour à l'instance existante ; l'autre lanceur reçoit 409 et un message, puis « Régénérer » permet de lancer | P2 | tests/workflows/lancer/lancer.spec.ts |
| WF-33 | Refus sans menu lancer | Concepteur ; utilisateur sans menu | Ouvrir « Lancer » ; appeler l'API | Écran « Accès refusé… » ; POST 403 (le concepteur lit le catalogue, sans lancer) | P1 | tests/workflows/lancer/lancer.spec.ts |

## Boîte de tâches

| Id | Scénario | Préconditions | Étapes | Résultat attendu | Priorité | Spec |
|---|---|---|---|---|---|---|
| WF-34 | Liste et filtres | Deux éléments assignés | Filtrer par statut et par texte, réinitialiser | Filtrage correct ; « Aucun résultat pour ces filtres » | P1 | tests/workflows/boite/boite.spec.ts |
| WF-35 | Prise en charge et formulaire déclaré | Formulaire à champ obligatoire | « Prendre en charge », terminer sans le champ, puis avec | « Le champ « Objet » est obligatoire. » puis tâche terminée | P1 | tests/workflows/boite/boite.spec.ts |
| WF-36 | Checklist | Étape checklist à élément obligatoire | Terminer sans cocher, puis cocher | Message d'élément obligatoire puis tâche terminée | P2 | tests/workflows/boite/boite.spec.ts |
| WF-37 | Décision manuelle | Étape décision à choix | Terminer sans choix, puis choisir « finances » | « Choisissez une décision. » puis branche finances ouverte | P2 | tests/workflows/boite/boite.spec.ts |
| WF-38 | Délégation par l'écran | Deux utilisateurs | Se déléguer (refusé), déléguer à l'autre, qui termine | 422 pour soi-même ; « Tâche déléguée. » ; le délégué termine | P1 | tests/workflows/boite/boite.spec.ts |
| WF-39 | Délégation invalide | Élément ouvert | Destinataire vide, puis inconnu | Message de champ ; 422 « destinataire introuvable… » | P2 | tests/workflows/boite/boite.spec.ts |
| WF-40 | Tâche d'autrui | Élément assigné à A | B puis l'admin tentent d'agir | 404 pour les deux | P1 | tests/workflows/boite/boite.spec.ts |
| WF-41 | Assignation à un rôle | Deux membres du rôle | Le membre 1 prend, le membre 2 tente de terminer | Visible par les deux ; 409 pour le second | P1 | tests/workflows/boite/boite.spec.ts |
| WF-42 | Instance suspendue | Instance suspendue | Ouvrir l'élément ; agir par l'API | « Le workflow est suspendu… » ; API 409 | P2 | tests/workflows/boite/boite.spec.ts |
| WF-43 | Version périmée | Instance modifiée entre-temps | Terminer avec l'ancienne version, puis après actualisation | 409 « Actualisation… » puis 200 | P2 | tests/workflows/boite/boite.spec.ts |
| WF-44 | Étape agent sans IA | Étape agent « suggère » | Ouvrir l'élément, terminer le résultat JSON | Tâche humaine (pas de proposition) ; `agent.escalated` journalisé ; instance terminée | P1 | tests/workflows/boite/boite.spec.ts |
| WF-45 | Échéance dépassée mise en évidence | Étape à échéance d'une heure | Figer l'horloge du navigateur deux heures après l'échéance, ouvrir la boîte | Carte mise en évidence (`wfb-card--overdue`) avec « En retard de 2 h » | P2 | tests/workflows/boite/boite.spec.ts |
| WF-46 | Relance et escalade par le worker | Worker et minuteries | Attendre la relance | Non automatisé : la minuterie s'arme au moins une heure après le début de l'étape et seule une écriture directe en base (`wf_timer.fire_at`) la déclencherait, ce que les fixtures n'offrent pas | P3 | tests/workflows/boite/boite.spec.ts |

## Suivi des instances

| Id | Scénario | Préconditions | Étapes | Résultat attendu | Priorité | Spec |
|---|---|---|---|---|---|---|
| WF-50 | « Mes instances » | Lanceur avec deux instances, autre lanceur avec une | Ouvrir le suivi, filtrer « Terminée » | Seules ses instances, avec le nom du workflow ; API restreinte | P1 | tests/workflows/suivi/instances.spec.ts |
| WF-51 | Refus sans lancer ni administration | Concepteur | Ouvrir le suivi et l'administration | Écrans refusés ; API 403 | P1 | tests/workflows/suivi/instances.spec.ts |
| WF-52 | Détail lu par l'assigné, refusé au tiers | Assigné non lanceur ; tiers | Ouvrir le détail ; annuler par l'API | L'assigné lit sans action (annulation 403) ; tiers 404 et « Instance introuvable ou hors de votre périmètre. » | P1 | tests/workflows/suivi/instances.spec.ts |
| WF-53 | Identifiant invalide | Aucune | Ouvrir `/workflows/instances/abc` | « Instance introuvable », aucun appel API | P2 | tests/workflows/suivi/instances.spec.ts |
| WF-54 | Administration : suspendre puis reprendre | Instance d'un autre utilisateur | « Suspendre » avec motif, puis « Reprendre » | « Instance suspendue. » puis « Instance reprise. » ; journal à jour | P1 | tests/workflows/suivi/instances.spec.ts |
| WF-55 | Lanceur contre l'instance d'un autre lanceur | Deux lanceurs | Annuler ou suspendre par l'API ; ouvrir l'administration | 404 ; liste vide ; administration refusée | P1 | tests/workflows/suivi/instances.spec.ts |
| WF-56 | Redirection | Aucune | Ouvrir `/workflows` | Arrivée sur la boîte de tâches | P2 | tests/workflows/suivi/instances.spec.ts |
| WF-57 | Journal : compteur et ordre | Instance avec plusieurs événements | Basculer « Plus récent d'abord », choisir « Instance » | Compteur « N événements affichés sur N. » ; ordre inversé | P2 | tests/workflows/suivi/instances.spec.ts |

## Garde-fous : plafonds et arrêt d'urgence

| Id | Scénario | Préconditions | Étapes | Résultat attendu | Priorité | Spec |
|---|---|---|---|---|---|---|
| WF-65 | État des agents sans IA | Pile sans IA | Ouvrir « Plafonds et arrêt d'urgence » | « IA désactivée (mode : …) » ; arrêt global inactif ; carte « Plafond global » | P1 | tests/workflows/garde-fous/plafonds.spec.ts |
| WF-66 | Plafond d'un workflow | Workflow publié sans plafond | Choisir le workflow, saisir montant, seuil et devise invalides, puis valides | Trois messages, aucun PUT ; puis « Plafond enregistré : … », carte « Dans le budget » ; devise en minuscules refusée par l'API (400) | P1 | tests/workflows/garde-fous/plafonds.spec.ts |
| WF-67 | Arrêt d'urgence d'un workflow | Workflow avec une ligne de budget | Ouvrir l'arrêt, mauvais mot, motif, « arret », confirmer ; puis lever | Bouton bloqué tant que le mot ne correspond pas ; « Arrêt d'urgence activé… », motif affiché ; arrêt global intact ; levée confirmée | P1 | tests/workflows/garde-fous/plafonds.spec.ts |
| WF-68 | Arrêt global : confirmation bloquée | Admin | Ouvrir l'arrêt global, saisir un autre mot, annuler | Bouton désactivé ; aucun POST ; arrêt global inactif | P2 | tests/workflows/garde-fous/plafonds.spec.ts |
| WF-69 | Refus sans administration | Concepteur et lanceur | Ouvrir l'écran ; appeler statut, budget, arrêt | Écran « Accès refusé… » ; 403 partout | P1 | tests/workflows/garde-fous/plafonds.spec.ts |
| WF-78 | Activer puis lever l'arrêt global | Projet `etat-global` (exécuté seul, après le projet principal) | Activer depuis « Plafond global » avec motif et « ARRÊT », vérifier, lever | « Arrêt d'urgence activé… », alerte globale, « Arrêt global : actif », API à jour ; puis levée et « Arrêt global : inactif » ; état initial restauré dans tous les cas | P2 | tests/workflows/garde-fous/plafonds.global.spec.ts |

## Garde-fous : outils autorisés

| Id | Scénario | Préconditions | Étapes | Résultat attendu | Priorité | Spec |
|---|---|---|---|---|---|---|
| WF-70 | Outil non autorisé puis autorisé | Brouillon dont l'étape agent utilise `rechercher_documents` | Publier par l'API ; écran des outils : « Autoriser les outils utilisés… », plafond 3, enregistrer ; publier dans l'éditeur | 422 `AGENT_TOOL_NOT_GRANTED` ; alerte et liste des outils manquants ; « Autorisations enregistrées : 1 outil(s) autorisé(s). » ; version 1 publiée | P1 | tests/workflows/garde-fous/outils.spec.ts |
| WF-71 | Explication dans l'éditeur | Même brouillon | « Vérifier », puis lien « Outils autorisés » | Problème « Outil non autorisé pour ce workflow » expliqué ; navigation vers l'écran des outils | P2 | tests/workflows/garde-fous/outils.spec.ts |
| WF-72 | Plafond d'appels invalide | Même brouillon | Cocher, saisir 0, puis 2,5 ; annuler | Messages par ligne, enregistrement désactivé ; retour à l'état enregistré ; API 400 pour 0 | P2 | tests/workflows/garde-fous/outils.spec.ts |
| WF-73 | Concepteur sans administration | Concepteur | Ouvrir l'écran ; lire le catalogue et les autorisations | Message « réservé aux administrateurs » ; API 403 | P1 | tests/workflows/garde-fous/outils.spec.ts |

## Garde-fous : évaluation et autonomie

| Id | Scénario | Préconditions | Étapes | Résultat attendu | Priorité | Spec |
|---|---|---|---|---|---|---|
| WF-74 | Créer un jeu d'évaluation | Workflow publié à étape agent | « Nouveau jeu… » sans nom, précision 70 %, puis 90 % | Messages de nom et de plancher, aucun POST ; jeu créé (étape `analyse`, 0,9) ; API 422 sous le plancher | P1 | tests/workflows/garde-fous/evaluation-autonomie.spec.ts |
| WF-75 | Lancer une évaluation sans IA | Jeu actif avec un cas | « Lancer une évaluation », confirmer | 202 ; run « En erreur » avec « IA désactivée : run interrompu au cas n° 1. » ; étape non éligible | P1 | tests/workflows/garde-fous/evaluation-autonomie.spec.ts |
| WF-76 | Niveau « autonome » refusé | Brouillon à étape autonome | Vérifier ; marquer « faible risque » ; vérifier ; retirer le marquage | `AUTONOMY_REQUIRES_LOW_RISK`, puis `AGENT_AUTONOMY_NOT_ELIGIBLE` (« aucun jeu d'évaluation… ») et « Niveau autonome non éligible » à l'écran ; publication 422 ; retrait accepté | P1 | tests/workflows/garde-fous/evaluation-autonomie.spec.ts |
| WF-77 | Retrait du « faible risque » bloqué par une étape autonome publiée | Run d'évaluation réussi | Retirer le marquage | Non automatisé : sans IA, aucun run ne réussit | P3 | tests/workflows/garde-fous/evaluation-autonomie.spec.ts |

## Déclencheurs

| Id | Scénario | Préconditions | Étapes | Résultat attendu | Priorité | Spec |
|---|---|---|---|---|---|---|
| WF-80 | Catalogue et cycle de vie d'un déclencheur | Workflow publié | Lire le catalogue ; créer inactif ; ouvrir l'éditeur ; activer et renommer ; supprimer | `mail.arrived` au catalogue ; bloc « Déclencheurs » (nom, « Inactif », événement, lanceur) ; changer le type est refusé (400) ; suppression, puis 404 | P1 | tests/workflows/declencheurs/declencheurs.spec.ts |
| WF-81 | Conditions invalides, workflow archivé | Workflow publié puis archivé | Créer avec champ sans `subject.`, champ inconnu, valeur mal typée, type inconnu ; puis sur l'archivé | 422 avec la raison ; 400 pour le type ; 422 pour l'archivé ; rien n'est enregistré | P2 | tests/workflows/declencheurs/declencheurs.spec.ts |
| WF-82 | Droits et anti-élévation | Lanceur seul, concepteur seul, concepteur et lanceur | Appeler les routes ; désigner l'admin ; modifier le déclencheur de l'admin | 403 sans conception ; 422 si le lanceur désigné n'a pas le menu lancer ; 403 pour désigner un autre compte ou modifier celui d'un autre | P1 | tests/workflows/declencheurs/declencheurs.spec.ts |
| WF-83 | Courrier Arrivée réel | Déclencheur sur un rôle destinataire de test ; workflow témoin sur un autre rôle | Enregistrer trois courriers (visé, autre rôle, visé) | Deux instances, liées au déclencheur et aux courriers visés ; aucune pour l'autre rôle ; `lastFiredAt` renseigné | P1 | tests/workflows/declencheurs/declencheurs.spec.ts |
| WF-84 | Déclencheur inactif | Déclencheur inactif ; témoin actif sur le même rôle | Courrier, attente du témoin, activation, second courrier | Une seule instance, pour le second courrier | P2 | tests/workflows/declencheurs/declencheurs.spec.ts |
