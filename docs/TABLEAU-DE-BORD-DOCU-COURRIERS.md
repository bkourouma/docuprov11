# Tableau de bord Docu-Courriers — Dossier de conception

> **Objet de ce document.** Brief autoportant destiné à Claude Code pour concevoir et implémenter
> le tableau de bord du module Docu-Courriers. Il décrit (1) ce que le module contient réellement
> aujourd'hui, (2) la sémantique métier à respecter pour que les chiffres soient justes, (3) le
> catalogue des KPI exploitables, (4) une proposition d'architecture d'écran et d'API.
>
> **Statut des affirmations.** Tout ce qui est marqué ✅ a été vérifié dans le code / la base de ce
> dépôt. Tout ce qui est marqué 💡 est une **proposition** à arbitrer. Les pièges marqués ⚠️ sont
> des comportements réels du module qui **fausseront les KPI** s'ils sont ignorés.
>
> Sources : `docs/DOCUMENTATION_MODULE_DOCU-COURRIERS.md` (spec du module source, §01–§19),
> `packages/db/prisma/models/courriers.prisma`, `apps/api/src/modules/courriers/`,
> `apps/web/app/courriers/`, `apps/web/app/admin/courriers/` — **et le dashboard existant**
> `apps/web/app/dashboards/` + `apps/api/src/modules/analytics/` (§9.1).
>
> **Lecture minimale si pressé** : §3 (pièges), §9.1 (ce qu'on réutilise), §6 (catalogue KPI),
> §12 (arbitrages).

---

## 1. Contexte et périmètre

### 1.1 Où en est le module ✅

Le module Docu-Courriers est un **portage** d'un module source ASP.NET Zero/ABP vers la stack V6
(NestJS + Prisma/PostgreSQL + Next.js/Ant Design + BullMQ). Les phases A→G sont livrées :

| Phase | Contenu | État |
|---|---|---|
| A | 18 modèles Prisma + migration (CHECK, uniques partiels, index GIN full-text) | ✅ livrée, migration appliquée |
| B | Domaine pur (machine à états, files, numérotation, auto-traitement) | ✅ livrée, testée |
| C | Services (worklists, imputations, référentiels, organigramme, recherche) | ✅ livrée |
| D | Contrôleurs REST + DTO Zod + OpenAPI + garde menu-RBAC | ✅ livrée |
| E | 9 écrans métier (§05–§13) + MailViewer + cloche de notifications | ✅ livrée |
| F | 9 écrans de paramétrage | ✅ livrée |
| G | Worker BullMQ : rappels date butoir + rappels d'échéance d'imputation | ✅ livrée |

**Base de données** : PostgreSQL 18 local (`DocuPro` sur `localhost:5432`), schéma à jour
(`prisma migrate status` → *Database schema is up to date*, 6 migrations). ✅

### 1.2 Le point de départ : rien côté courrier, mais **un dashboard existant à réutiliser** ✅

**Côté module Docu-Courriers : aucun tableau de bord, ni dans le source, ni dans le portage.**
La documentation du module (4 300+ lignes, 19 sections) ne contient **aucune** occurrence de
« tableau de bord », « dashboard », « statistiques » ou « KPI » en tant qu'écran. Une recherche dans
`apps/api/src/modules/courriers/` ne renvoie **aucun** code d'agrégation.

Deux vestiges seulement dans le source :

1. **Les badges de menu** (§04.7) — 6 compteurs rafraîchis toutes les 120 s, **personnels**
   (« mes courriers »). ⚠️ **Le portage V6 n'en implémente que 3** (voir §6, famille B).
2. **Un fichier `MailStats.cs`** cité en passant (lignes 760, 762, 763, 801 de la doc) pour ses
   filtres « en retard » et sa notion de **date d'archivage**. **Non porté**, jamais documenté en propre.

**Mais V6 possède déjà un tableau de bord pour Docu-Archives** — et c'est la ressource la plus
importante de ce projet. ✅

| Élément | Emplacement |
|---|---|
| Écran (= page d'accueil, `/` y redirige) | `apps/web/app/dashboards/page.tsx` |
| Conteneur de widget | `apps/web/app/dashboards/components/ChartCard.tsx` |
| Graphiques | `apps/web/app/dashboards/components/charts.tsx` |
| Filtre de période | `apps/web/app/dashboards/components/PeriodFilter.tsx` |
| Client API | `apps/web/app/dashboards/lib/api.ts` |
| Backend | `apps/api/src/modules/analytics/` (controller, service, dto) |
| Objectifs | `packages/db/prisma/models/analytics.prisma` → `AnalyticsTarget` |
| SQL brut (index, CHECK) | `packages/db/prisma/sql/analytics.sql` |

**Conséquence : le tableau de bord courrier est un écran neuf, mais il ne part pas de zéro.**
Il n'y a aucune fidélité au source à préserver — seulement (a) une **cohérence sémantique** avec le
workflow courrier (§3) et (b) une **réutilisation maximale** de la mécanique dashboard existante
(§9.1). Trois pièces sont même **déjà écrites et jamais branchées** (`PeriodFilter`,
`CumulativeArea`, `fetchTargets`) — c'est du gain immédiat.

⚠️ **La décision d'ACL du dashboard existant n'est PAS transposable.**
`analytics.service.ts:99` :

```ts
private aclCond(_user: AuthUser): Prisma.Sql | null {
  return null;   // décision produit assumée : chiffres globaux pour tout utilisateur connecté
}
```

Le dashboard Archives n'applique **aucun filtre d'accès**. Docu-Courriers, lui, a un périmètre
explicite (`MailScope`, §5) : reprendre ce `return null` exposerait à chaque agent les chiffres de
toute l'organisation. **C'est le point de divergence n° 1 avec l'existant.**

### 1.3 Volumétrie réelle aujourd'hui ✅

Mesuré en base le 2026-07-21 :

| Table | Lignes |
|---|---|
| `mail` | 6 |
| `mail_inputation` | 6 |
| `mail_action_log` | 2 |
| `notification` | 60 |
| `external_entity` | 61 |
| `organigramme` | 3 |
| `mail_objet` | 2 |
| `app_user_group` | 16 |

Répartition des courriers : 4 en `status=0` (Rédaction) / `type=0` (Arrivée), 1 en `status=2`
(Déchargé) / `type=1` (Départ), 1 en `status=3` (Traité) / `type=0` (Arrivée).

**Deux implications directes pour la conception :**

- ❌ **Ne pas pré-agréger.** Toute table de snapshot / vue matérialisée / job de calcul nocturne
  serait de l'ingénierie prématurée à 6 lignes. Requêtes live. Voir §9 pour le seuil de bascule.
- ⚠️ **Le tableau de bord sera vide ou absurde à la première ouverture.** Il faut (a) des
  **états vides soignés** sur chaque widget et (b) un **jeu de données de démonstration**
  pour pouvoir juger le rendu. Voir §11.

---

## 2. La matière première : le modèle de données

### 2.1 Vue d'ensemble ✅

18 tables, dont **`mail` est l'entité pivot**. Fichiers :
`packages/db/prisma/models/courriers.prisma` (17 modèles) et `notifications.prisma` (1).

```
                       ┌──────────────────┐
   Référentiels ──────►│      mail        │◄────── app_user_group (destinataire, audit)
   (nature, objet,     │  (entité pivot)  │◄────── role (destinataire collectif)
    confidentialité,   └────────┬─────────┘◄────── organigramme
    type de départ,             │
    entité externe)             ├──► mail_inputation ──► app_user_group (agent imputé)
                                ├──► mail_document ────► document (GED existante)
                                ├──► mail_scanned_document
                                ├──► mail_comment
                                ├──► mail_action_log
                                └──► mail_permission (modélisée, INACTIVE en v1)
```

### 2.2 `mail` — les colonnes exploitables pour les KPI ✅

C'est la table qui porte tout. Son état **n'est pas dans une seule colonne** : il résulte de
`status` **+ 5 drapeaux booléens + 6 dates**. Toute requête de KPI doit composer les trois.

**Identité et classement**

| Colonne | Type | Usage KPI |
|---|---|---|
| `mail_id` | PK | — |
| `title` | varchar(500) | Affichage, recherche full-text |
| `mail_date` | **date** | Date propre du document (≠ date de prise en charge) |
| `reference` | varchar(255) | Référence externe |
| `n_reference` | varchar(100) | Numéro interne — **unique par type de départ**, pas global ⚠️ |
| `mail_type` | smallint | **0 Arrivée, 1 Départ, 2 Interne** — dimension majeure |
| `status` | smallint | **0 Rédaction, 1 Rédigé, 2 Déchargé, 3 Traité, 4 Supprimé** |
| `is_deleted` | boolean | Soft-delete explicite — **à exclure partout** ⚠️ |

**Les 6 dates de cycle de vie** (toutes nullables, `timestamptz`) — c'est ici que vivent les délais :

| Date | Écrite quand | Ce qu'elle permet de mesurer |
|---|---|---|
| `date_enregistrement_courrier` | Enregistrement §05 (saisie) | **Point de départ** de tout délai de traitement |
| `date_follow_up` | Saisie formulaire | Date de relance ; filtre « en retard » du source ; filtre de la file Départ |
| `end_date_follow_up` | **jamais écrite** ⚠️ | Rien (voir §3.2) |
| `date_decharge` | Passage Déchargé **et, par effet de bord, passage Rédigé d'un Départ** ⚠️ | Date d'archivage **des Départs** |
| `date_traited` | Archivage / passage Traité | Date d'archivage **des Arrivées** ; `IS NULL` = « en cours » |
| `date_butoire` | Saisie formulaire | **Échéance** — base des rappels et des KPI de retard |

**Les 5 drapeaux de workflow** (boolean, défaut `false`) — ils définissent les files de travail :

| Drapeau | Sens | File concernée |
|---|---|---|
| `valider` | Contrôlé par le bureau d'ordre | Sortie de la file Contrôle §06 |
| `validation_direction` | Validé par la Direction | File Validation §10 |
| `validation_dg` | Validé par la DG | Circuit DG |
| `enregistrement_reponse` | Réponse enregistrée | Guichet unique |
| `decharge` | Décharge demandée | File Intégration décharge §13 |

**Les liens (dimensions d'analyse)**

| FK | Vers | Dimension |
|---|---|---|
| `destinataire_expediteur` | `app_user_group` | Agent destinataire |
| `destinataire_role_id` | `role` | Destinataire **collectif** (une fonction) |
| `organigramme_id` | `organigramme` | **Service / direction** — ⚠️ **Arrivée uniquement**, voir ci-dessous |
| `external_entity_id` | `external_entity` | Correspondant (nullable : Interne sans correspondant) |
| `mail_nature_id` | `mail_nature` | Nature |
| `mail_objet_id` | `mail_objet` | Objet type — **porte les durées de suivi (SLA)** |
| `confidentialite_id` | `mail_confidentialite` | Confidentialité |
| `mail_depart_type_id` | `mail_depart_type` | Type de départ |
| `mail_parent` | `mail` | Fil de discussion (courrier ↔ réponse) |
| `created_by` / `modified_by` | `app_user_group` | Audit — **qui a saisi** |

⚠️ **`destinataire_expediteur` et `destinataire_role_id` sont exclusifs** (contrainte CHECK
`ck_mail_destinataire`). Un courrier Arrivée est adressé à une **fonction** (rôle), un Départ à un
**agent nommé**. Toute agrégation « par destinataire » doit gérer les deux cas, sinon elle perd
silencieusement la moitié des courriers.

⚠️⚠️ **`organigramme_id` n'est renseigné QUE sur les Arrivées** — vérifié dans le code :

- `MailsService.createArrivee` appelle `deriveOrganigramme(destinataireRoleId)` →
  `role.organigramme_id` (`domain/organigramme.ts` : `resolveOrganigrammeId(x) => x ?? null`).
- **`createDepart` ne l'appelle jamais.** Les Départs ont donc `organigramme_id = NULL`.
- La valeur est un **instantané à la création** : réassigner un rôle à un autre nœud plus tard ne
  met **pas** à jour les courriers existants.
- Un rôle sans organigramme produit également `NULL` (l'écran §15 avertit déjà de ce cas).

**Trois conséquences pour tout KPI « par service » :**
1. Il ne porte en pratique que sur les **Arrivées** — l'annoncer explicitement dans le widget.
2. Il faut un bucket **« Non rattaché »** visible, jamais un `WHERE organigramme_id IS NOT NULL`
   silencieux qui ferait disparaître des courriers du total.
3. L'analyse est **historique** (le service au moment de l'enregistrement), pas le service actuel.
   C'est défendable, mais doit être écrit dans l'infobulle du widget.

→ **Question ouverte n° 8 (§12).**

### 2.3 `mail_inputation` — la charge de travail réelle ✅

L'imputation est l'affectation d'un courrier à un agent. **C'est la table qui porte la charge de
travail individuelle** — plus fine et plus juste que `mail.destinataire`.

| Colonne | Usage KPI |
|---|---|
| `mail_inputation_id` | PK |
| `user_id` → `app_user_group` | **L'agent imputé** — dimension « charge par agent » |
| `mail_inputation_type_id` | Type (validation DG, pour suivi, en copie…) |
| `instructions` | Texte libre |
| `deadline` | **Échéance de l'imputation** — base des rappels et du retard |
| `date_treated` | `NULL` = **non traitée**. Le passage global du courrier à Traité dépend de « toutes les imputations traitées » |
| `last_reminder_sent` | Anti-spam des rappels — permet de mesurer la pression de relance |
| `created_by` / `created_at` | Qui a imputé, quand → **délai d'imputation** |

**Types d'imputation « système »** aux identifiants figés (`packages/types/src/courriers.ts`) ✅ :

| Id | Libellé | Rôle |
|---|---|---|
| **5** | Validation DG | Circuit DG |
| **10** | Pour Suivi | Créée automatiquement après validation DG (+48 h) |
| **14** | Validation Direction | Circuit Direction |
| **17** | En Copie | Créée à l'enregistrement pour les destinataires en copie |

### 2.4 Les tables annexes ✅

| Table | Contenu | Usage KPI |
|---|---|---|
| `mail_action_log` | Journal métier : `action_code`, `user_group_id`, `created_at` | **Horodatage des étapes** → délais par étape, activité par agent |
| `mail_document` | Lien courrier ↔ document GED, drapeau `decharge` | **Décharge réellement intégrée** (≠ drapeau `mail.decharge`) |
| `mail_scanned_document` | File des scans, `is_traite` | Backlog de numérisation |
| `mail_comment` | Commentaires | Volume d'échanges |
| `notification` | Inbox in-app, `is_read`, `read_at` | Pression de notification, taux de lecture |
| `mail_permission` | ACL par courrier | **Inactive en v1** — ne pas exploiter |

**Codes d'action** du journal (`MailActionCode`) ✅ : 1014 Déliaison, 1015 Décharge,
1017 Validation DG, 1018 Soumission validation, 1019 Contrôle, 1021 Enregistrement réponse.

⚠️ `mail_action_log` ne compte que **2 lignes** aujourd'hui : le journal est écrit par les services
mais peu de scénarios l'ont alimenté. Les KPI qui en dépendent (délais par étape) seront donc
**pauvres au départ** — c'est une limite à assumer, pas un bug.

---

## 3. Sémantique métier à respecter — les pièges qui faussent les KPI ⚠️

**Cette section est la plus importante du document.** Chaque point ci-dessous est un comportement
réel et vérifié du module. Un tableau de bord qui les ignore affichera des chiffres faux mais
crédibles — le pire des cas.

### 3.1 `date_decharge` est polluée sur les Départs ⚠️

Le source a deux surcharges de `UpdateMailStatus`. Celle à 3 arguments écrit `DateDecharge`
**toujours**, y compris au passage à *Rédigé* d'un Départ. Le portage reproduit fidèlement ce
comportement (`domain/mail-status.ts`, `markDepartRedige`) — c'est **voulu**, pas un bug :
pour un Départ, `date_decharge` sert de **date d'archivage**.

**Conséquence KPI :** `date_decharge IS NOT NULL` **ne signifie pas** « courrier déchargé ».
Pour compter les décharges réelles, utiliser la présence d'un document de décharge :

```sql
EXISTS (SELECT 1 FROM mail_document md
        WHERE md.mail_id = m.mail_id AND md.decharge = true)
```

### 3.2 `end_date_follow_up` n'est jamais écrite ⚠️

Aucun flux ne l'alimente (confirmé dans la doc source et le portage). Elle n'est que **lue**, comme
filtre de la file Départ.

**Conséquences :**
- Aucun KPI « suivi clôturé » n'est calculable. Ne pas en proposer.
- La file Départ (`date_follow_up IS NOT NULL AND end_date_follow_up IS NULL`) ne se vide jamais
  par ce biais.
- ⚠️ **Effet de bord connu et non arbitré** : un Départ fraîchement créé (Rédigé, sans
  `date_follow_up`) **n'apparaît pas** dans la file Départ. C'est fidèle au filtre source mais
  contre-intuitif. Le tableau de bord doit donc compter les Départs **sans** reprendre ce filtre,
  sinon il sous-comptera. → **Question ouverte n° 1 (§12).**

### 3.3 Le statut `Supprimé` (4) n'est jamais affecté ⚠️

Le soft-delete passe par `is_deleted`. Ne jamais filtrer sur `status = 4` ; toujours ajouter
`is_deleted = false`.

### 3.4 La règle de visibilité générale ✅

`domain/queues.ts`, `isVisibleInLists` :

```ts
!isDeleted && (status !== Redaction || mailType === Arrivee)
```

Un **Arrivée** reste visible même en Rédaction ; les autres types ne le sont qu'une fois sortis de
Rédaction. Le tableau de bord doit **appliquer cette règle de façon cohérente** avec les écrans de
liste, sinon les totaux du dashboard ne réconcilieront pas avec les écrans — et c'est la première
chose qu'un utilisateur vérifie.

### 3.5 L'auto-traitement à la lecture écrase les délais ⚠️

Les imputations dont le type porte `suivi = true` sont marquées traitées **automatiquement à
l'ouverture du courrier** (`domain/auto-treatment.ts`). Le commentaire du code source dit l'inverse
de ce que fait le code ; le comportement effectif est bien `suivi == true`.

**Conséquence KPI :** un « délai de traitement d'imputation » peut valoir **quasi zéro** simplement
parce que l'agent a ouvert le courrier. Un délai médian anormalement bas n'est donc pas une
performance : c'est un artefact.
→ **Segmenter les KPI de délai entre imputations auto-traitées et traitées manuellement.**

### 3.6 Les imputations en retard cessent d'être relancées ⚠️ — **l'angle mort à exploiter**

`apps/worker/src/domain/mail-reminders.ts`, `shouldRemindInputation` :

```ts
// « Deadline >= now » : le source cesse de relancer une imputation déjà en retard.
if (input.deadline.getTime() < now.getTime()) return false;
```

Une imputation qui dépasse son échéance **devient silencieuse** : plus aucune notification. De même,
les paliers d'alerte de `date_butoire` sont des **valeurs exactes, pas des seuils** :

```ts
7 → PREMIERE_ALERTE | 3 → RAPPEL | 1 → DERNIERE_CHANCE | 0 → URGENCE | -1,-2,-3 → RETARD
// 6, 5, 4, 2, et au-delà de -3 : AUCUNE alerte
```

Un courrier à J-5 est muet. Un courrier à J-10 de retard est muet.

**C'est la meilleure justification métier du tableau de bord :** il est le **seul endroit** où ces
courriers réapparaissent. Ce n'est pas un widget parmi d'autres, c'est la valeur centrale de
l'écran. → Voir KPI **D1/D3** et la zone « Retards » du §7.

### 3.7 Deux dates d'archivage différentes selon le type ✅

Héritée du source (`MailStats.cs`) :

| Type | Date d'archivage |
|---|---|
| Arrivée (et Interne) | `date_traited` |
| Départ | `date_decharge` |

Tout KPI « archivés sur la période » doit faire ce `CASE`, sinon les Départs disparaissent :

```sql
CASE WHEN m.mail_type = 1 THEN m.date_decharge ELSE m.date_traited END
```

### 3.8 Le SLA est configuré mais dormant ⚠️ — **opportunité**

`mail_objet` porte `duree_suivi_externe` et `duree_suivi_interne` (en **jours**). Vérifié par
recherche exhaustive dans le code : ces deux colonnes sont **uniquement lues et écrites par le CRUD**
(DTO Zod, service, écran de paramétrage). **Aucun calcul métier ne les utilise.**

C'est une **configuration inerte** : l'utilisateur peut la régler, elle ne produit rien.

**Le tableau de bord peut en être le premier consommateur** — c'est le moyen de passer de KPI
descriptifs (« combien ») à des KPI de performance (« dans les délais ou non »), sans ajouter la
moindre colonne. → Voir KPI **C4**.
⚠️ Prérequis : à ce jour `mail_objet` ne contient que **2 lignes**, et rien ne garantit que les
durées soient renseignées (défaut `0`). Le widget SLA doit gérer explicitement le cas
« durée non configurée » plutôt que de traiter `0` comme une échéance immédiate.
→ **Question ouverte n° 2 (§12).**

### 3.9 Récapitulatif des règles de filtrage à appliquer partout

```sql
-- Socle commun de toute requête du tableau de bord
WHERE m.is_deleted = false
  AND (m.status <> 0 OR m.mail_type = 0)   -- règle de visibilité §3.4
```

---

## 4. Ce que le paramétrage rend possible — les dimensions d'analyse

Le menu **« Paramétrage courrier »** compte 9 écrans, dont **3 sont masqués** dans la barre latérale
(`HIDDEN_MENU_KEYS` dans `apps/api/src/modules/roles/menu-catalog.ts`) : natures, objets,
confidentialités. Les routes existent et les données restent exploitables. ✅

| Écran (route) | Référentiel | Dimension d'analyse offerte | Visible |
|---|---|---|---|
| `/admin/courriers/organigrammes` | `organigramme` (arbre, materialized-path) | **Service / direction** — la dimension la plus structurante | ✅ |
| `/admin/courriers/role-organigramme` | `role.organigramme_id` | Rattachement rôle → service | ✅ |
| `/admin/courriers/types-entites-externes` | `external_entity_type` | Catégorie de correspondant | ✅ |
| `/admin/courriers/entites-externes` | `external_entity` (61 lignes) | **Correspondant** | ✅ |
| `/admin/courriers/types-imputation` | `mail_inputation_type` (+ drapeau `suivi`) | Nature du circuit | ✅ |
| `/admin/courriers/types-depart` | `mail_depart_type` | Type de départ (+ numérotation) | ✅ |
| `/admin/courriers/natures` | `mail_nature` | Nature du courrier | ⚠️ masqué |
| `/admin/courriers/objets` | `mail_objet` **+ durées de suivi** | Objet type **et SLA** | ⚠️ masqué |
| `/admin/courriers/confidentialites` | `mail_confidentialite` | Niveau de confidentialité | ⚠️ masqué |

**Points d'attention :**

- 💡 Les 3 référentiels masqués restent des **dimensions valides** (les colonnes sont peuplées à la
  saisie). Mais proposer un filtre « par nature » alors que l'écran de gestion est masqué crée une
  impasse : l'utilisateur voit une dimension qu'il ne peut pas administrer.
  → **Question ouverte n° 3 (§12).**
- ✅ `organigramme` est un **arbre en materialized-path** (`path`, `depth`, index sur `path`). Un
  filtre « service » doit inclure les **descendants** via `path LIKE :prefix || '%'`, pas seulement
  le nœud exact — sinon le filtre sur une direction ne remonte rien de ses services.
- ✅ Tous les référentiels portent `is_active` avec un **unique partiel sur les actifs** : la
  désactivation remplace la suppression. Des courriers historiques peuvent donc pointer vers un
  référentiel **inactif** — les agrégations ne doivent pas filtrer sur `is_active = true`, sinon
  elles perdent l'historique. C'est un KPI d'hygiène en soi (voir **G5**).

---

## 5. Périmètre d'accès — contrainte structurante ✅

Le module distingue **deux permissions alternatives** (`domain/mail-scope.ts`,
`apps/api/src/modules/roles/menu-catalog.ts`) :

```ts
export type MailScope = 'all' | 'imputed' | 'none';

// « Suivi permanent » l'emporte quand les deux sont accordées.
if (menuKeys.includes(MENU_SUIVI))    return 'all';      // /courriers/suivi
if (menuKeys.includes(MENU_SUIVI_DC)) return 'imputed';  // /courriers/suivi-dc
return 'none';
```

| Scope | Clé de menu | Périmètre |
|---|---|---|
| `all` | `/courriers/suivi` | **Tous** les courriers |
| `imputed` | `/courriers/suivi-dc` | Uniquement ceux où l'utilisateur porte une imputation |
| `none` | — | Liste vide |

**Conséquence majeure pour le tableau de bord :**

Ce n'est **pas** un écran unique. Le même écran doit rendre :

- pour un scope `all` (bureau d'ordre, direction) → une **vue pilotage** : volumes, délais,
  répartition par service, classement des agents ;
- pour un scope `imputed` (agent) → une **vue « mon activité »** : mes imputations en cours, mes
  retards, mes échéances.

Afficher un classement des agents à un agent est à la fois une **fuite d'information** et un
contresens managérial. Le scope doit être **appliqué côté serveur** (jamais un simple masquage
d'UI), exactement comme le font déjà `MailsService.listSuivi` / `listValidationDirection`.

💡 **Proposition** : une nouvelle clé de menu `/courriers/tableau-de-bord` (section `Docu-Courriers`)
garde l'accès à l'écran, et le **scope calculé** décide du contenu. Un agent sans aucune des deux
clés de suivi obtient un tableau de bord vide — cohérent avec `MailScope = 'none'`.

---

## 6. Catalogue des KPI

Conventions : `now()` en UTC (toutes les dates sont `timestamptz`). Le **socle commun** du §3.9 est
implicite dans toutes les requêtes. `P` = période sélectionnée.

### Famille A — Volumétrie et flux

| # | KPI | Définition | Piège |
|---|---|---|---|
| **A1** | Courriers enregistrés sur P | `count(*) WHERE date_enregistrement_courrier BETWEEN P` | Utiliser la date d'**enregistrement**, pas `mail_date` (date du document, souvent antérieure) |
| **A2** | Répartition par type | `group by mail_type` (Arrivée / Départ / Interne) | Le type Interne existe mais n'a **aucun écran dédié** ✅ — il peut être à 0 |
| **A3** | Répartition par statut | `group by status` | Le statut 4 n'est jamais utilisé (§3.3) |
| **A4** | **Stock en cours** | `count(*) WHERE date_traited IS NULL` | C'est la définition officielle des files « à traiter » |
| **A5** | Courriers archivés sur P | `count(*)` sur la date d'archivage **selon le type** | ⚠️ `CASE` du §3.7 obligatoire |
| **A6** | Taux de traitement | A5 / A1 sur la même période | Un taux > 100 % est normal (on solde du stock ancien) — ne pas le borner |
| **A7** | **Évolution du flux** | Série temporelle entrées vs sorties, granularité jour/semaine/mois | `date_trunc` + série de dates générée, sinon les périodes vides disparaissent du graphe |
| **A8** | **Backlog net** | Cumul (entrées − sorties) dans le temps | Le KPI qui montre si l'organisation décroche |

### Famille B — Files de travail (la « tour de contrôle »)

⚠️ **Attention : le source avait 6 badges, V6 n'en implémente que 3.** Vérifié —
`MailsService.badgeCounts()` renvoie exactement `{ controle, validation, suivi }`.
Les compteurs Parapheur, Intégration décharge et Scans **n'existent pas encore**.

**Règle d'or reprise du code existant** (commentaire de `badgeCounts`) : *chaque compteur compte
exactement ce que sa liste affiche*. Le dashboard doit s'y tenir, sinon les chiffres ne réconcilient
pas avec les écrans — et c'est la première chose qu'un utilisateur vérifie.

Voici les `where` **réels** des écrans, à réutiliser tels quels :

| # | File | `where` exact (vérifié dans `mails.service.ts`) | Écran cible | Badge V6 ? |
|---|---|---|---|---|
| **B1** | À contrôler | `isDeleted:false, valider:false` + visibilité + **`OR[destinataireExpediteur = moi, destinataireRoleId = mon rôle]`** | `/courriers/controle` | ✅ `controle` |
| **B2** | Parapheur | `isDeleted:false` + visibilité + `inputations.some({ userId: moi, dateTreated: null, mailInputationTypeId ≠ 17 })` | `/courriers/parapheur` | ❌ absent |
| **B3** | Validation Direction | `isDeleted:false, valider:true, dateTraited:null` — **sans** filtre `validation_direction`, **sans** visibilité, **sans** scope | `/courriers/validation` | ✅ `validation` |
| **B4** | Validation DG | imputation `type = 5` non traitée `AND valider` | — | ❌ absent |
| **B5** | Intégration décharge | `isDeleted:false, mailType:1, documents:{ none: { decharge: true } }` (méthode `listDechargesEnAttente`, `take:200`) | `/courriers/integration-decharge` | ❌ absent |
| **B6** | Scans en attente | `mail_scanned_document.is_traite = false` | `/courriers/documents-scannes` | ❌ absent |
| **B7** | En cours (Suivi) | `isDeleted:false, dateTraited:null` + visibilité + **scope** (§5) | `/courriers/suivi` | ✅ `suivi` |

**Pièges vérifiés, chacun source d'un écart de chiffres :**

- ⚠️ **B1 et B2 sont PERSONNELS**, pas globaux. `listControle` filtre sur le destinataire (agent
  nommé **ou** porteur du rôle destinataire, via `?? -1` comme sentinelle « ne matche rien »).
  Un dashboard de pilotage (scope `all`) voudra la **version globale** de B1/B2 — c'est donc un
  **nouveau calcul**, pas une réutilisation. L'écart avec le badge est normal mais doit être **libellé**
  (« à contrôler — tous services » ≠ « mes courriers à contrôler »).
- ⚠️ **B3 n'a délibérément pas de filtre `validation_direction`** : le drapeau est posé en même temps
  que `dateTraited`, donc le filtrer masquerait un courrier validé-mais-non-traité. Ne pas
  « corriger » cette apparente omission.
- ⚠️ **B3 n'applique pas la règle de visibilité** (§3.4) alors que B1/B2/B7 l'appliquent.
  Incohérence réelle de l'existant : à signaler, et à **trancher** avant de figer les chiffres
  (→ question ouverte n° 9).
- ⚠️ **B5 se base sur l'absence de document de décharge** (`documents: { none: { decharge: true } }`),
  **pas** sur le drapeau `mail.decharge` — cohérent avec §3.1.
- ⚠️ **B2** : le filtre exclut le type **En Copie (17)**, pour ne compter que les imputations
  *actionnables*. En SQL, écrire un `EXISTS`, jamais un `JOIN` (un courrier à plusieurs imputations
  serait compté plusieurs fois).

💡 **Valeur ajoutée** par rapport aux badges : afficher pour chaque file **l'âge du plus ancien
élément**. Une file de 3 courriers dont le plus ancien a 40 jours est plus alarmante qu'une file de
30 courriers du jour. Aucun badge ne le montre aujourd'hui.

### Famille C — Délais et performance

Le cœur analytique. **Utiliser la médiane et le P90, jamais la moyenne** : sur de petits volumes avec
des valeurs extrêmes, la moyenne est ininterprétable. PostgreSQL : `percentile_cont(0.5)` et
`percentile_cont(0.9)` `WITHIN GROUP (ORDER BY …)`.

| # | KPI | Mesure | Piège |
|---|---|---|---|
| **C1** | Délai de prise en charge | `date_enregistrement_courrier − mail_date` | `mail_date` est un `date`, l'autre un `timestamptz` → caster |
| **C2** | Délai de contrôle | `mail_action_log(1019).created_at − date_enregistrement_courrier` | ⚠️ Journal quasi vide (2 lignes) — KPI pauvre au départ |
| **C3** | **Délai de traitement global** | date d'archivage (§3.7) − `date_enregistrement_courrier` | Le KPI phare. `CASE` obligatoire |
| **C4** | **Respect du SLA** | comparer C3 à `mail_objet.duree_suivi_*` (jours) | ⚠️ §3.8 : durées souvent à `0`/non configurées → exclure explicitement, ne pas traiter `0` comme « échéance immédiate ». Choisir externe vs interne selon `mail_type` |
| **C5** | Délai de traitement d'imputation | `date_treated − created_at` | ⚠️ §3.5 : **segmenter auto-traitées / manuelles**, sinon le chiffre ment |
| **C6** | Délai par étape | Écarts successifs dans `mail_action_log` | Même limite que C2 |
| **C7** | Délais par service / par agent | C3 groupé par `organigramme_id` / `user_id` | Masquer les groupes à effectif < 5 : un « délai médian » sur 1 dossier n'a pas de sens |

### Famille D — Retards et risques (**la zone à plus forte valeur**, cf. §3.6)

| # | KPI | Définition | Note |
|---|---|---|---|
| **D1** | **Courriers en retard** | `date_butoire < now() AND date_traited IS NULL` | Le chiffre d'alerte principal |
| **D2** | Échéances à venir | `date_butoire` dans les 7 jours `AND date_traited IS NULL` | Préventif |
| **D3** | **Imputations en retard** | `deadline < now() AND date_treated IS NULL` | ⚠️ **Zone de silence** : plus aucune relance n'est envoyée (§3.6). Le dashboard est le seul filet |
| **D4** | Répartition par palier | Buckets J-7 / J-3 / J-1 / J0 / retard | Reprendre exactement les paliers de `ReminderLevel` — cohérence avec les notifications reçues |
| **D5** | **Ancienneté du backlog** | Buckets < 7 j / 7–15 / 15–30 / > 30 j sur `date_traited IS NULL` | Indépendant de `date_butoire` — **couvre les courriers sans échéance**, invisibles de D1 |
| **D6** | Top retards | Table triée par ancienneté, actionnable | Lien direct vers le courrier |
| **D7** | Services / agents les plus en retard | D1+D3 groupés | ⚠️ Réservé au scope `all` (§5) |

💡 **D5 est structurant** : un courrier sans `date_butoire` est **absent de D1** — il n'a pas
d'échéance, donc il n'est jamais « en retard », donc il peut vieillir indéfiniment sans alerte.
D5 est le seul KPI qui le rattrape. Croiser avec **G1**.

### Famille E — Acteurs et charge de travail

| # | KPI | Définition | Note |
|---|---|---|---|
| **E1** | Charge par agent | imputations ouvertes `group by user_id` | La mesure de charge la plus juste |
| **E2** | Charge par service | idem `group by organigramme_id` | ⚠️ Inclure les descendants (§4) **et** un bucket « Non rattaché ». **Arrivées uniquement** (§2.2) |
| **E3** | Débit par agent | imputations traitées sur P | À croiser avec E1 |
| **E4** | Répartition de la charge | Écart-type / ratio max-min entre agents | Révèle les déséquilibres |
| **E5** | **Courriers sans imputation** | `NOT EXISTS (mail_inputation)` et non traités | **Personne ne s'en occupe** — risque pur |
| **E6** | Activité de saisie | `group by created_by` sur P | Qui alimente le système |

### Famille F — Correspondants et contenu

| # | KPI | Définition | Piège |
|---|---|---|---|
| **F1** | Top correspondants | `group by external_entity_id` (61 entités) | ⚠️ **Doublons possibles** — voir ci-dessous |
| **F2** | Répartition par type d'entité | `group by external_entity_type_id` | Le type est nullable |
| **F3** | Répartition par nature / objet / confidentialité | `group by` FK | ⚠️ Référentiels masqués (§4) |
| **F4** | Départs par type de départ | `group by mail_depart_type_id` | Pilote aussi la numérotation §19 |
| **F5** | Taux de réponse | Courriers ayant ≥ 1 réponse via `mail_parent` | — |
| **F6** | Délai de réponse | `date_enregistrement` de la réponse − celle du parent | — |

⚠️ **F1 — les correspondants peuvent être en double.** Vérifié : `createExternalEntity` est le
**seul** `create` du service des référentiels qui **ne vérifie pas l'unicité du libellé** (tous les
autres passent par `findLabelConflict`/`normaliseLabel` et renvoient 409). De plus, l'entité peut
être créée depuis **deux points d'entrée** : l'écran d'administration **et** l'écran d'enregistrement
(`@RequireMenu` en OR sur `/admin/courriers/entites-externes` **ou** `/courriers/enregistrement`).

Un « Top correspondants » peut donc afficher « MINISTERE DES FINANCES » et « Ministère des Finances »
comme deux lignes distinctes, et **fractionner** le volume réel.

💡 Deux options : (a) regrouper à l'affichage sur le libellé normalisé
(`lower(replace(label,' ',''))`, la même normalisation que les autres référentiels), ou (b) exposer
un KPI d'hygiène **« correspondants en doublon probable »** (voir **G8**) et laisser l'utilisateur
fusionner. (b) est plus honnête : (a) masque le problème sans le résoudre.

### Famille G — Hygiène des données (méta-KPI)

Famille souvent oubliée, à fort retour : elle explique **pourquoi** les autres KPI sont faux et donne
des actions correctives immédiates.

| # | KPI | Détection | Pourquoi ça compte |
|---|---|---|---|
| **G1** | Courriers **sans échéance** | `date_butoire IS NULL AND date_traited IS NULL` | Invisibles de tout le suivi par échéance (cf. D5) |
| **G2** | Imputations sans deadline | `deadline IS NULL AND date_treated IS NULL` | Jamais relancées |
| **G3** | Scans anciens non traités | `is_traite = false AND date_scanned < now() − 30j` | Backlog de numérisation oublié |
| **G4** | Objets sans durée de suivi | `duree_suivi_externe = 0 AND duree_suivi_interne = 0` | **Rend C4 (SLA) incalculable** |
| **G5** | Référentiels inactifs encore référencés | jointure sur `is_active = false` | Signale un référentiel désactivé trop tôt |
| **G6** | Courriers supprimés | `is_deleted = true` | Contrôle d'usage du soft-delete |
| **G7** | Notifications non lues (ancienneté) | `is_read = false` sur `notification` (60 lignes) | Les alertes ne sont-elles pas lues ? |
| **G8** | **Correspondants en doublon probable** | même `lower(replace(label,' ',''))` sur plusieurs `external_entity_id` actifs | Fractionne F1 (§ famille F) |
| **G9** | Courriers sans rattachement organisationnel | `organigramme_id IS NULL AND mail_type = 0` | Rôle destinataire non rattaché (§15) → invisible de E2 |

### Famille H — Activité et audit

| # | KPI | Définition |
|---|---|---|
| **H1** | Actions par code sur P | `group by action_code` sur `mail_action_log` |
| **H2** | Actions par acteur | `group by user_group_id` |
| **H3** | Volume de notifications émises | `count(*)` sur `notification` par jour |
| **H4** | Taux de lecture des notifications | `is_read = true` / total, et délai `read_at − created_at` |

⚠️ H1/H2 restent pauvres tant que `mail_action_log` n'est pas alimenté par plus de scénarios.

### Récapitulatif : les 8 KPI à retenir si l'on ne devait en garder que 8 💡

| Priorité | KPI | Pourquoi |
|---|---|---|
| 1 | **D1 + D3** — retards courriers & imputations | La zone de silence du §3.6 : valeur unique du dashboard |
| 2 | **B1–B6** — les 6 files | Actionnable immédiatement, réconcilie avec les écrans |
| 3 | **A4 / A8** — stock et backlog net | L'organisation décroche-t-elle ? |
| 4 | **D5** — ancienneté du backlog | Rattrape ce que D1 ne voit pas |
| 5 | **C3** — délai de traitement (médiane/P90) | Le KPI de performance de référence |
| 6 | **E1 / E5** — charge par agent, courriers orphelins | Répartition et angles morts |
| 7 | **A7** — flux entrées/sorties | Tendance |
| 8 | **G1 / G4** — hygiène bloquant les autres KPI | Rend le reste fiable |

---

## 7. Architecture de l'écran proposée 💡

Route : `/courriers/tableau-de-bord`. Principe : **densité décroissante et lecture en Z** — l'alerte
d'abord, l'analyse ensuite, le détail en bas.

```
┌───────────────────────────────────────────────────────────────────────────┐
│ FILTRES (barre collante)                                                  │
│ Période [7j|30j|90j|perso] · Type · Service · Correspondant · Granularité  │
├───────────────────────────────────────────────────────────────────────────┤
│ ZONE 1 — ALERTES  (rouge/orange, uniquement si > 0)                       │
│ [Courriers en retard D1] [Imputations en retard D3] [Sans imputation E5]  │
│ → si tout est à zéro : une ligne verte discrète, pas 3 tuiles vides       │
├───────────────────────────────────────────────────────────────────────────┤
│ ZONE 2 — TOUR DE CONTRÔLE  (6 tuiles cliquables → écrans)                 │
│ [À contrôler] [Parapheur] [Valid. Direction] [Valid. DG] [Décharge][Scans]│
│ chaque tuile : compteur + âge du plus ancien                              │
├───────────────────────────────────────────────────────────────────────────┤
│ ZONE 3 — CHIFFRES CLÉS  (4 statistiques + variation vs période précédente)│
│ [Enregistrés A1] [Traités A5] [En cours A4] [Délai médian C3]             │
├───────────────────────────────────────────────────────────────────────────┤
│ ZONE 4 — FLUX (2/3)                    │ ZONE 5 — RÉPARTITION (1/3)       │
│ Barres entrées/sorties + courbe        │ Donut par statut                 │
│ de backlog net (A7/A8)                 │ Barres par type                  │
├────────────────────────────────────────┴──────────────────────────────────┤
│ ZONE 6 — RETARDS                                                          │
│ Paliers J-7/J-3/J-1/J0/retard (D4) │ Ancienneté du backlog (D5)           │
│ Table « top retards » actionnable (D6)                                    │
├───────────────────────────────────────────────────────────────────────────┤
│ ZONE 7 — CHARGE  (scope `all` uniquement)                                 │
│ Table agents : ouvertes / traitées / en retard / délai médian (E1,E3,C7)  │
│ Barres par service (E2)                                                   │
├───────────────────────────────────────────────────────────────────────────┤
│ ZONE 8 — CORRESPONDANTS │ ZONE 9 — HYGIÈNE (repliée par défaut)           │
│ Top 10 entités (F1)     │ Liste compacte G1–G7 avec liens correctifs      │
└───────────────────────────────────────────────────────────────────────────┘
```

**Adaptation au scope (§5) :**

| Zone | scope `all` | scope `imputed` |
|---|---|---|
| 1 Alertes | Global | Mes retards |
| 2 Files | Compteurs globaux | Mes files |
| 3 Chiffres | Global | Mon activité |
| 4–6 | Complet | Restreint à mes courriers |
| **7 Charge** | ✅ | ❌ **masquée** (fuite d'info) |
| 8–9 | ✅ | ❌ masquées |

**Règles de conception :**

- **Tout compteur est cliquable** et mène à l'écran filtré correspondant. Un dashboard qui ne
  permet pas d'agir sur ce qu'il signale n'est qu'un rapport.
- **États vides soignés** : à 6 courriers en base, c'est l'état par défaut. Un widget vide doit dire
  ce qu'il montrera, pas afficher « 0 » ou un graphe cassé.
- **Cohérence des totaux** avec les écrans de liste (règle §3.4) — sinon perte de confiance immédiate.
- **Ne jamais afficher une moyenne** de délai sans médiane/P90 à côté.

---

## 8. Contrat d'API proposé 💡

**Principe : un endpoint par zone**, pas un gros `/dashboard` monolithique — chaque widget charge
indépendamment, une agrégation lente n'empêche pas l'affichage du reste.

⚠️ **Aligner la forme sur le module `analytics` existant, qui utilise `POST` + filtres dans le
corps** (`POST /analytics/overview` avec `@HttpCode(200)`), et **non** `GET` + query params.
Raison : le filtre est un objet structuré, et c'est la convention déjà en place dans ce dépôt.

Base : `/courriers/dashboard`. Filtre commun dans le corps (miroir de `analyticsFilterSchema`) :

```ts
{ dateFrom?: string;            // 'YYYY-MM-DD'
  dateTo?: string;
  mailType?: 0 | 1 | 2;
  organigrammeId?: number;
  externalEntityId?: number;
  granularity?: 'day' | 'week' | 'month' | 'quarter' | 'year';   // défaut 'day'
  basis?: 'date_enregistrement_courrier' | 'mail_date' | 'created_at' }  // défaut enregistrement
```

| Verbe | Route | Retour | KPI |
|---|---|---|---|
| POST | `/courriers/dashboard/alertes` | retards, imputations en retard, orphelins | D1, D3, E5 |
| POST | `/courriers/dashboard/files` | 7 compteurs + âge du plus ancien | B1–B7 |
| POST | `/courriers/dashboard/synthese` | 4 chiffres clés + variation | A1, A4, A5, C3 |
| POST | `/courriers/dashboard/flux` | série temporelle entrées/sorties/backlog | A7, A8 |
| POST | `/courriers/dashboard/repartition` | `dimension` dans le corps | A2, A3, F1–F4 |
| POST | `/courriers/dashboard/delais` | médiane/P90 par étape + SLA | C1–C4 |
| POST | `/courriers/dashboard/retards` | paliers + ancienneté + top | D4, D5, D6 |
| POST | `/courriers/dashboard/charge` | par agent et par service — **scope `all`** | E1–E4, C7 |
| POST | `/courriers/dashboard/hygiene` | compteurs G1–G9 | G |

**À respecter :**

- ✅ Le **scope est résolu côté serveur** via `mailScopeFromMenuKeys` — jamais reçu du client.
  Réutiliser `MailsService.mailScope(user)`, qui **relit les menus en base** à chaque appel (le JWT
  ne les porte pas) et court-circuite à `'all'` pour un admin. `charge` renvoie **403** (ou un corps
  vide explicite) pour un scope `imputed`.
- ✅ Nouvelle clé de menu dans **les deux fichiers qui doivent rester synchronisés** :
  `apps/web/app/components/nav.ts` (section `Docu-Courriers`) **et**
  `apps/api/src/modules/roles/menu-catalog.ts` + seed `ALL_MENU_KEYS`.
  💡 Contrairement à `/dashboards` (forcé visible pour tous, cas particulier dans `AuthShell.tsx:62`
  et `CommandPalette.tsx:87`), la clé courrier doit être une **permission assignable normale**.
- ⚠️ **Piège de routage vérifié** : tous les `@Controller('courriers*')` s'aplatissent dans un seul
  routeur Express, **dans l'ordre du tableau `controllers` du module**. Le `@Get(':id')` glouton de
  `MailsController` doit rester enregistré **en dernier**. → Déclarer `DashboardController`
  **avant** `MailsController` dans `courriers.module.ts`.
- ✅ OpenAPI **écrit à la main** dans `specs/001-archivage-qr/contracts/openapi.yaml`
  (pas de `@nestjs/swagger`) — ajouter les 9 chemins + schémas.
- ✅ Validation **Zod + `ZodValidationPipe`** (pas class-validator), via
  `@Body(new ZodValidationPipe(schema))`. Le pipe exige `input = output` : utiliser
  `z.coerce.number()` et **jamais** `.transform()`.

💡 **Où placer le code ?** Deux options :
- **Nouveau `DashboardController`/`DashboardService` dans `modules/courriers/`** — recommandé :
  garde la cohésion du module, l'accès au `MailScope`, et évite de polluer `analytics` (dont le
  `aclCond` volontairement nul serait un contresens ici).
- Étendre `modules/analytics/` — à éviter, sauf si l'on veut un jour un dashboard transverse
  archives + courriers. Dans ce cas, la table `analytics_target` a un CHECK `scope IN
  (global|programme|type)` qui nécessiterait une migration pour accueillir des objectifs courrier.

---

## 9. Contraintes techniques et conventions V6 à respecter ✅

### 9.1 Réutiliser le dashboard existant — inventaire précis 💡

**Tout ce qui suit existe et fonctionne.** Ne rien réécrire.

**Graphiques** — `@ant-design/plots` `^2.6.8` (G2 v5). **Pas de recharts, pas d'echarts.**
Import obligatoire en client-only, sinon le SSR casse :

```tsx
const Pie = dynamic(() => import('@ant-design/plots').then((m) => m.Pie),
  { ssr: false, loading }) as ComponentType<Record<string, unknown>>;
```

Tous les graphes passent `autoFit`, `animate={false}`, et lisent leurs couleurs de `useChartTheme()`.

**Composants directement réutilisables**

| Composant | Contrat | Note |
|---|---|---|
| `ChartCard` | `{ title, subtitle?, extra?, loading?, empty?, emptyText?, height=300, children }` | Réserve `minHeight` (pas de saut de mise en page), `Skeleton` pendant le chargement, `EmptyState` si vide. Défaut : *« Aucune donnée pour cette période. »* — **exactement ce qu'il faut pour le §1.3** |
| `PageHeader` | `{ title, description, icon, breadcrumb?, actions? }` | Tuile d'icône 44 px, `motion.header` |
| `PeriodFilter` | `Segmented` (today/7d/30d/mois/trimestre/année/perso) + `RangePicker` si `perso` | ⚠️ **Écrit mais jamais monté** — à brancher, gain immédiat |
| `CumulativeArea` | Courbe cumulée | ⚠️ **Écrite mais jamais montée** — candidate directe pour le backlog net (A8) |
| `CardsSkeleton` | `count={6}` | Premier chargement uniquement |

**Mise en page** : `Row gutter={[16,16]}` + `Col xs={24} lg={12}`, animations via
`motion.div variants={staggerContainer}` (`app/theme/motion.ts`), conteneur en
`className="dash-readable"` (force le contraste des textes secondaires, `globals.css:170`).

**Formatage** — `app/theme/charts.ts` : `fmtInt` (fr-FR), `fmtPct`, `fmtBytes`, `fmtDateFr`
(`JJ/MM/AAAA` à l'écran, `YYYY-MM-DD` sur le fil), et `useChartTheme()` → palette 8 couleurs
compatible daltonisme, variantes claire/sombre, respect de `prefers-reduced-motion`.

⚠️ **`Statistic` d'Ant Design n'est utilisé nulle part dans le dépôt.** Les nombres sont composés à
la main : `Typography.Text` + `className="da-mono"` (Geist Mono, `tabular-nums`) + une variable de
couleur du thème. Le dashboard courrier ayant besoin de **vraies tuiles KPI** (le dashboard Archives
n'en a qu'une, bricolée dans le slot `actions` du `PageHeader`), il faut **trancher** : suivre la
convention `da-mono`, ou introduire `Statistic` délibérément — et si oui, créer un composant
`KpiCard` partagé plutôt que de le dupliquer 4 fois. → **Question ouverte n° 10.**

**Patterns SQL à copier** de `analytics.service.ts` (100 % `$queryRaw` + `Prisma.sql`) :

- Conditions composables : `filterConds()` → `Prisma.Sql[]`, puis
  `Prisma.join(conds, ' AND ')` ou `Prisma.empty`.
- `Prisma.raw` **uniquement** pour des noms de colonnes issus d'une **liste blanche**
  (ex. `dateCol()` mappe `basis` → colonne). Les valeurs utilisateur restent **toujours** des
  paramètres liés.
- Tous les compteurs d'une zone en **une seule requête** :
  `count(*) FILTER (WHERE …)::int`.
- Séries temporelles : `generate_series(date_trunc(...), ..., ${step}::interval)` en `LEFT JOIN`
  sur un `GROUP BY date_trunc` → **remplissage des périodes vides** (sinon les trous disparaissent
  du graphe), plus un comptage « baseline » de tout ce qui précède la fenêtre pour que la courbe
  cumulée soit juste.
- Top-N : le SQL renvoie tout trié, le TS coupe au Top 8, somme le reste dans `'Autres'` et garde la
  tranche `NULL` (`'— Sans type —'`) épinglée en dernier. **À reprendre pour les buckets
  « Non rattaché » du §2.2.**
- Rollup d'arbre par materialized-path : `s.path LIKE r.path || '%'` (le `/` final évite que `/3/`
  matche `/30/`) — directement applicable à `organigramme`.
- `overview()` lance ses 8 requêtes en un seul `Promise.all`.

**État de l'existant à connaître** : la page `/dashboards` n'affiche que **4 graphiques**, alors que
l'API renvoie déjà `kpis`, `timeline`, `objective` et `pipeline`. Les filtres y sont **figés en dur**
(`const [period] = useState(...)`, sans setter : `30d` / `created_at` / `day`). Autrement dit, le
backend Archives est plus riche que son écran — le dashboard courrier peut viser mieux dès le départ.

**Client HTTP** — `apps/web/app/lib/api.ts` : `apiJson<T>(path, init?)`, jeton Bearer depuis
`localStorage`, un 401 purge le jeton et redirige vers `/login`. Convention du dépôt : chaque
fonctionnalité a son propre `<feature>/lib/api.ts` qui **recopie à la main** les interfaces de
réponse du backend, avec un commentaire pointant la source de vérité. Chargement des données :
`useMemo` (filtre) → `useCallback` (`load()`) → `useEffect`. **Ni SWR ni React Query** dans ce dépôt.

⚠️ `downloadExport` partagé est **GET-only** ; `/analytics/export` étant en POST, `dashboards/lib/api.ts`
réimplémente le téléchargement de blob. Même contrainte si des exports courrier sont ajoutés.

### 9.2 Conventions transverses du dépôt

| Sujet | Règle |
|---|---|
| Validation | **Zod** + `ZodValidationPipe` — jamais class-validator |
| OpenAPI | Fichier **écrit à la main**, à mettre à jour |
| Énumérations | **Pas d'enum Prisma** — `smallint` + CHECK, constantes TS dans `packages/types` |
| Tenant | **Mono-tenant** — aucune colonne `TenantId` |
| Audit | FK explicites `created_by` / `modified_by` → `app_user_group` |
| Soft-delete | `is_deleted` **uniquement sur `mail`**, à filtrer manuellement |
| Schéma Prisma | Multi-fichiers : `packages/db/prisma/models/*.prisma` |
| Domaine | Logique pure **framework-free** dans `modules/courriers/domain/` + tests ts-jest |
| Client web | `lib/courriers.ts` (client typé) — réutiliser, ne pas dupliquer |
| Dates | **UTC** partout (`timestamptz`) |

### 9.3 ⚠️ Bug d'exécution déjà rencontré, à ne pas reproduire

`pg_advisory_xact_lock()` renvoie `void` → `$queryRaw` échoue (« Failed to deserialize column of
type 'void' », Prisma P2010) et produit un **500 invisible au typecheck**.

> **Règle : `$executeRaw` pour toute instruction SQL qui ne renvoie pas de lignes,
> `$queryRaw` uniquement pour celles qui en renvoient.**

Pertinent ici : les agrégations du dashboard seront écrites en SQL brut (Prisma `groupBy` ne sait
faire ni `date_trunc`, ni `percentile_cont`, ni les buckets conditionnels). Utiliser
`$queryRaw` avec `Prisma.sql` et des **paramètres liés** (jamais d'interpolation de chaîne).

### 9.4 Performance et volumétrie

- ✅ Index déjà présents sur `mail` : `status`, `mail_type`, `external_entity_id`,
  `destinataire_expediteur`, `destinataire_role_id`, `mail_parent`, `date_butoire`, `created_at`,
  et les FK référentielles. `mail_inputation` : `mail_id`, `user_id`, `mail_inputation_type_id`.
  `mail_scanned_document` : `is_traite`. `organigramme` : `path`. **La couverture est bonne.**
- 💡 Index potentiellement utile plus tard : partiel sur `date_traited IS NULL` (le filtre le plus
  fréquent du dashboard). À ajouter **seulement si** une mesure le justifie. Le dépôt a déjà ce
  pattern : `packages/db/prisma/sql/analytics.sql` contient des index partiels
  (`ix_document_missing_type ... WHERE col IS NULL`) pour les compteurs d'anomalies — exactement
  la forme dont la famille **G** aurait besoin. Conventions de nommage : `ux_*` unique,
  `ck_*` contrainte, `ix_*` index. Fichier appliqué de façon **idempotente** via
  `prisma db execute --file … --schema prisma`.
- ❌ **Pas de pré-agrégation, pas de vue matérialisée, pas de job de calcul** à ce stade (6 lignes).
  C'est aussi le choix du dashboard Archives : `analytics.prisma` ne contient **qu'une seule table**,
  `AnalyticsTarget` (des **objectifs**, pas des résultats) ; le réalisé est **toujours calculé live**.
- ❌ **Aucun cache nulle part** : ni `CacheModule`, ni `cache-manager`, ni `@nestjs/schedule` dans
  `apps/` (vérifié). Chaque requête recalcule ; la seule mitigation est l'indexation.
- 💡 **Seuil de bascule proposé** : au-delà de ~100 000 courriers **ou** si un endpoint dépasse
  ~500 ms mesurées, envisager un cache court (60 s) puis une table de snapshot alimentée par BullMQ.
  Le point d'accroche existe déjà : `apps/worker/src/index.ts` utilise `queue.upsertJobScheduler(...)`
  (idempotent au redémarrage) pour les rappels.
- ✅ Redis est en **5.0.14.1** ; BullMQ 5.78 recommande ≥ 6.2.0 et l'affiche en avertissement. Les
  jobs répétables fonctionnent malgré tout (vérifié pour les rappels). Ce n'est pas un blocage,
  mais à garder en tête si un jour un job de snapshot est ajouté.

---

## 10. Tests et validation ✅

Reprendre le pattern éprouvé du module :

1. **Domaine pur d'abord** — mettre la logique testable (buckets d'ancienneté, paliers de retard,
   calcul SLA, choix de la date d'archivage §3.7) dans `modules/courriers/domain/dashboard-*.ts`,
   sans I/O, avec un `.spec.ts`. C'est ce qui a permis de valider les phases B et G.
2. **Requêtes SQL** — vérifier chaque agrégat contre un compte manuel sur le jeu de démonstration.
3. **Réconciliation** — vérifier que chaque compteur de file (B1–B6) **égale** le nombre de lignes de
   l'écran correspondant. C'est le test qui attrape les oublis de `is_deleted` et de la règle §3.4.
4. **Scope** — tester explicitement `all`, `imputed` et `none`.

⚠️ Rappels d'environnement vérifiés : il n'existe **pas de script `typecheck`** (utiliser `build`) ;
les captures d'écran du navigateur peuvent expirer ; **un seul serveur de dev web** doit tourner
(deux `next dev` sur le même `.next` provoquent des `ChunkLoadError` récurrents).

---

## 11. Plan de livraison proposé 💡

| Lot | Contenu | Justification |
|---|---|---|
| **D1** | Domaine pur + tests : buckets, paliers, SLA, date d'archivage | Verrouille la sémantique avant toute UI |
| **D2** | Jeu de données de démonstration (~200 courriers réalistes, étalés dans le temps, avec retards, imputations, correspondants variés) | **Sans lui, rien n'est jugeable ni démontrable** à 6 lignes |
| **D3** | Endpoints `alertes` + `files` + `synthese` + clé de menu (nav.ts **et** menu-catalog.ts) + OpenAPI | Le socle actionnable |
| **D4** | Écran : zones 1–3, avec un composant `KpiCard` partagé + branchement de `PeriodFilter` (déjà écrit, §9.1) | **Livrable déjà utile en production** |
| **D5** | Endpoints + widgets `flux`, `repartition` (zones 4–5) | L'analyse de tendance |
| **D6** | `retards` + `delais` (zone 6) — active le SLA dormant (§3.8) | La plus forte valeur ajoutée |
| **D7** | `charge` (zone 7, scope `all`) | Nécessite l'arbitrage sur la restitution nominative |
| **D8** | `hygiene` (zone 9) | Améliore la fiabilité de tout le reste |

💡 **D2 est le lot le plus sous-estimé.** Sans données crédibles, ni le rendu, ni les performances,
ni la pertinence des seuils ne peuvent être évalués — et les arbitrages du §12 resteront théoriques.

---

## 12. Questions ouvertes — à arbitrer avant implémentation ⚠️

| # | Question | Enjeu | Recommandation 💡 |
|---|---|---|---|
| **1** | **Départs** : reprendre le filtre source (qui masque les Départs sans `date_follow_up`, §3.2) ou compter tous les Départs ? | Sous-comptage silencieux des Départs | **Compter tous les Départs** dans le dashboard, et signaler l'écart avec l'écran §12 |
| **2** | **SLA (§3.8)** : activer les durées de suivi dormantes ? Que faire des objets à durée `0` ? | Rend possible les KPI de performance C4 | **Activer**, en excluant explicitement les durées non configurées et en exposant G4 comme action corrective |
| **3** | **Référentiels masqués** (nature, objet, confidentialité) : les proposer comme dimensions ? | Impasse UX : dimension visible, gestion inaccessible | Les afficher **en lecture seule** ; si l'objet devient porteur du SLA, envisager de **démasquer** son écran |
| **4** | **Restitution nominative** (E1/E3/C7, zone 7) : classement par agent ? | Sujet social/managérial, pas seulement technique | Par défaut **par service** ; le détail par agent réservé au scope `all` et explicitement validé |
| **5** | **Rafraîchissement** : polling (comme les badges, 120 s) ou manuel ? | Charge serveur vs fraîcheur | **Manuel + à l'ouverture** au début ; polling seulement sur la zone 1 si le besoin apparaît |
| **6** | **Exports** (Excel/PDF) du tableau de bord ? | La plomberie existe (`POST /analytics/export` + `exportRows()` de `@archivage/exports`), mais aucun export n'a été construit côté courrier | **Hors périmètre v1**, réactivable à faible coût ensuite |
| **7** | **Période par défaut** | Cadre toute la lecture | **30 derniers jours**, avec les zones 1 et 2 **toujours sur le stock total** (un retard n'appartient pas à une période) |
| **8** | **Dimension « service »** alors que `organigramme_id` n'existe que sur les Arrivées (§2.2) | Un widget « par direction » qui ignore 100 % des Départs | L'afficher **libellé « Arrivées uniquement »**, avec bucket « Non rattaché ». Alternative plus lourde : dériver l'organigramme aussi à la création d'un Départ (**changement de comportement métier** — à valider) |
| **9** | **Incohérence de visibilité de la file Validation** : `listValidationDirection` n'applique pas la règle §3.4 contrairement aux autres files | Le compteur du dashboard ne réconciliera avec l'écran que si l'on reproduit l'incohérence | **Reproduire l'existant** (priorité à la réconciliation), et signaler l'écart séparément plutôt que de le corriger en douce |
| **10** | **Tuiles KPI** : suivre la convention `da-mono` ou introduire `Statistic` d'AntD (absent du dépôt) ? | Cohérence visuelle de toute l'application | Créer **un composant `KpiCard` partagé** (valeur + libellé + variation + lien), quel que soit le choix interne |
| **11** | Le dashboard doit-il aussi **ajouter les 4 badges manquants** (Parapheur, Décharge, Scans) au menu ? | Cohérence entre le menu et l'écran | 💡 Oui, **une fois les compteurs écrits** — la logique sera déjà là, le coût marginal est faible |

⚠️ **Point 7 précisé** : les zones « alertes » et « files » mesurent un **stock**, pas un flux. Les
soumettre au filtre de période serait une erreur de conception classique — un courrier en retard
depuis 3 mois disparaîtrait d'un filtre « 30 derniers jours », c'est-à-dire exactement celui qu'il
faut voir.

---

## 13. Résumé pour Claude Code

> **Mission.** Concevoir et implémenter le tableau de bord du module Docu-Courriers, écran neuf
> (aucun équivalent dans le module source), route `/courriers/tableau-de-bord`.
>
> **Ce qui existe déjà** : module courrier complet phases A→G (18 tables, ~30 routes sur
> `MailsController` + 4 contrôleurs annexes, 18 écrans), base PostgreSQL à jour, worker de rappels
> opérationnel — **et un dashboard Docu-Archives entièrement fonctionnel à réutiliser** (§1.2, §9.1).
>
> **Ce qu'il faut lire en premier** : le **§3** (pièges sémantiques). Sans lui, les chiffres seront
> faux mais crédibles — le pire des cas.
>
> **Les 7 décisions structurantes :**
> 1. **Réutiliser, ne pas réinventer (§9.1)** : `@ant-design/plots`, `ChartCard`, `PageHeader`,
>    `useChartTheme`, les patterns SQL de `analytics.service.ts`. `PeriodFilter` et `CumulativeArea`
>    sont **déjà écrits et jamais branchés**.
> 2. **Mais ne PAS reprendre son ACL** : `analytics.service.ts` assume `aclCond → null` (chiffres
>    globaux pour tous). Docu-Courriers a un périmètre (`MailScope`, §5) : `all` → pilotage,
>    `imputed` → « mon activité », résolu **côté serveur**.
> 3. **Les retards (§3.6)** sont la valeur centrale : le job de rappel devient **silencieux** dès
>    l'échéance dépassée, et les paliers sont des valeurs exactes (J-7/J-3/J-1/J0) et non des
>    seuils. Le dashboard est le **seul** filet de sécurité.
> 4. **Réconcilier avec les écrans (§6 famille B)** : reprendre les `where` réels. Attention,
>    V6 n'implémente que **3 badges sur 6**, et les files Contrôle/Parapheur sont **personnelles**
>    — une version globale est un **nouveau calcul**, à libeller comme tel.
> 5. **Deux dates d'archivage** selon le type (§3.7) — `CASE` obligatoire, sinon les Départs
>    disparaissent des statistiques. Et **`organigramme_id` n'existe que sur les Arrivées** (§2.2).
> 6. **Le SLA est configuré mais inerte (§3.8)** — l'activer fait passer le dashboard du descriptif
>    au qualitatif, sans ajouter une seule colonne.
> 7. **6 courriers en base (§1.3)** — pas de pré-agrégation, mais un **jeu de démonstration** est
>    indispensable pour juger quoi que ce soit.
>
> **Livrer par lots (§11)**, en commençant par le domaine pur et testé (D1) et les données de
> démonstration (D2). **Arbitrer le §12 (11 questions) avant d'écrire l'UI** — les questions 8, 9
> et 10 changent la forme des widgets.
