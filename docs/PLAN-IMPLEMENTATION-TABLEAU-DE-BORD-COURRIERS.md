# Plan d'implémentation — Tableau de bord Docu-Courriers

> ## Statut de ce document — à lire avant tout
>
> Ce plan est **dérivé du dossier de conception** `docs/TABLEAU-DE-BORD-DOCU-COURRIERS.md`.
> Il **n'a pas** été vérifié contre le code de `D:\DocuPro-V6` ni contre la base PostgreSQL :
> il a été produit sans accès au dépôt. Par conséquent :
>
> - Tout élément dépendant du code — `where` exacts, orthographe des colonnes, chemins de
>   fichiers, noms de méthodes, index existants — est repris **tel que le dossier l'affirme**
>   et porte le marqueur **⟨vérif⟩**. Ce ne sont pas des faits confirmés par moi.
> - Les chiffres cités (6 courriers, 61 entités, 2 lignes `mail_objet`, etc.) sont ceux **mesurés
>   par l'auteur du dossier le 2026-07-21** (§1.3), non revérifiés.
> - Le SQL ci-dessous est **écrit d'après le schéma décrit au §2** du dossier. Il est à
>   **exécuter contre la base réelle** avant d'être considéré comme correct.
>
> **Première action du développeur : dérouler la check-list « À vérifier dans le code » (§1.4)**,
> qui liste les affirmations dont dépend la validité du reste. Si l'une est fausse, l'arbitrage
> ou le SQL correspondant change.
>
> ---
>
> ### ✅ Check-list §1.4 déroulée le 2026-07-21 — résultats
>
> **Toutes les affirmations du dossier sont confirmées** contre le code réel. Les marqueurs ⟨vérif⟩
> restants dans le document ne signalent donc plus un doute, sauf mention contraire ci-dessous.
>
> **Deux erreurs du plan lui-même ont été corrigées :**
>
> 1. **§5.7 — PK de `mail_inputation_type`.** Le SQL écrivait `mit.id` ; la colonne réelle est
>    `mail_inputation_type_id` (`packages/db/prisma/models/courriers.prisma`). Corrigé sur place.
> 2. **§10 — critère d'acceptation `bucketPalier(-5) ∈ J4–J7`.** Incohérent avec le SQL du §5.8,
>    qui calcule `date_butoire - now()` et classe `j < 0` en retard. En notation métier, « J-5 »
>    désigne *cinq jours restants*, soit la **valeur `+5`**. La sémantique retenue (et testée) est
>    celle du SQL, alignée sur `daysUntil()` du worker : **positif = échéance future**.
>    `bucketPalier(5) = 'j4_j7'` et `bucketPalier(-5) = 'retard'`.
>
> **Confirmé par lecture directe du code** : `badgeCounts()` → `{controle, validation, suivi}`
> (3 badges sur 6) ; `listValidationDirection` = `{isDeleted:false, valider:true, dateTraited:null}`
> — sans visibilité ni filtre `validation_direction`, ce qui **valide l'arbitrage 9** ;
> `controleWhere` est bien personnel (destinataire nommé **ou** rôle destinataire) ;
> `organigramme.path` porte un slash final (`/1/14/57/`), donc le rollup `LIKE path || '%'` du §5.9
> est correct tel quel — `subtreePattern()` existe déjà dans `HierarchyService` et peut être réutilisé ;
> orthographe des colonnes `date_traited` (mail) / `date_treated` (imputation) / `date_butoire` /
> `is_traite` / `duree_suivi_*` conforme ; ids système d'imputation 5/10/14/17 et drapeau `suivi`
> conformes.
>
> ---
>
> ### ✅ Correctifs post-livraison (2026-07-21)

Deux défauts relevés à la revue des lots D1–D8, corrigés :

1. **Liens morts vers un écran masqué.** Le bloc SLA et l'indicateur G4 renvoyaient vers
   `/admin/courriers/objets`, qui est dans `HIDDEN_MENU_KEYS` : non assignable à un rôle, donc un
   cul-de-sac pour tout non-admin. Le filtrage est désormais fait **côté serveur**
   (`DashboardService.lienUtilisable`) et non dans l'écran : le jour où cet écran sera démasqué
   (arbitrage 3), les liens réapparaîtront sans intervention. Nouveau champ
   `sla.lienConfiguration: string | null`. Deux tests figent la règle.

2. **Permission accordée à aucun rôle.** La clé `/courriers/tableau-de-bord` avait été ajoutée au
   catalogue et au seed, mais un seed ne rétro-attribue rien : l'écran restait invisible sauf pour
   l'admin. Script `packages/db/prisma/grant-dashboard-menu.ts`
   (`db:grant:dashboard`, options `--dry-run` / `--revoke`), **appliqué** :

   | Rôle | Accès | Périmètre |
   |---|---|---|
   | Agents de Service Courrier | ✅ | `all` |
   | Secrétaire Général | ✅ | `all` |
   | Cellule d'appui | ✅ | `imputed` |
   | Chef de la cellule d'appui | ❌ volontairement | `none` — l'écran serait structurellement vide |

   Critère retenu : seuls les rôles disposant déjà d'une permission de suivi. Accorder l'accès à un
   rôle sans périmètre lui ouvrirait un écran vide — une fausse promesse, pas un droit.

---

### ⚠️ Découverte du lot D2 — A4 et A5 se contredisent sur les Départs
>
> **Mesuré sur le jeu de démonstration : 92 « en cours » (A4) + 128 « archivés » (A5) = 220 pour
> 200 courriers.** 20 Départs sont comptés **dans les deux**.
>
> Cause : un Départ reçoit `date_decharge` dès son passage à « Rédigé » (quirk §3.1). Or §3.7 fait
> de `date_decharge` **la date d'archivage du Départ**. Un Départ simplement rédigé est donc
> « archivé » au sens de A5, tout en restant `date_traited IS NULL` — donc « en cours » au sens de
> A4. Les deux définitions du plan sont individuellement correctes et mutuellement incompatibles.
>
> **À trancher avant les lots D5/D6** (ces deux KPI alimentent les zones 3 et 4) :
>
> | Option | Effet | Coût |
> |---|---|---|
> | **(a)** A4 devient « `dateArchivage(...) IS NULL` » | Cohérent avec A5 ; un Départ rédigé sort du stock | A4 ne réconcilie plus avec la file Suivi (qui filtre `date_traited`) |
> | **(b)** A5 utilise `date_traited` pour tous les types | Cohérent avec A4 et les files | Contredit §3.7 et la sémantique du source ; les Départs jamais archivés en pratique |
> | **(c)** A4/A5 restent tels quels, mais l'écran **sépare Arrivées et Départs** | Aucune définition faussée | Deux séries au lieu d'une ; plus honnête, plus verbeux |
>
> 💡 **Recommandation : (c).** Les deux flux n'ont pas le même cycle de vie ; les additionner dans
> un même compteur « en cours » est ce qui crée l'ambiguïté, pas les définitions elles-mêmes.
>
> ---
>
> **Reste marqué ⟨à valider⟩ (métier, pas technique)** : l'affectation externe/interne du SLA
> (§5.7, C4) — retenu par défaut : Interne → `duree_suivi_interne`, Arrivée/Départ →
> `duree_suivi_externe`. La règle est isolée dans `dureeApplicable()` pour qu'un changement d'avis
> soit un one-liner testé.

---

## 1. Décisions arrêtées

### 1.1 Les 11 arbitrages du §12

Convention : **[technique]** = tranché ici (correction / cohérence / performance) ;
**[à valider]** = impact métier, social ou budgétaire, décision qui appartient au commanditaire.

| # | Décision | Nature |
|---|---|---|
| 1 | **Compter tous les Départs** (`mail_type = 1`, socle commun), sans reprendre le filtre source qui masque les Départs sans `date_follow_up`. Libeller l'écart avec l'écran Départ. | [technique] |
| 2 | **Construire la logique SLA (C4)** avec gestion explicite du « non configuré » (jamais `0` = échéance immédiate), mais **livrer le widget derrière un état vide G4** tant que `mail_objet.duree_suivi_*` n'est pas renseigné. Rendre la notation SLA *visible* comme mesure de performance : | [technique] pour le « comment » ; **[à valider]** pour l'activation |
| 3 | **Dimensions nature / objet / confidentialité en lecture seule** (référentiels masqués). Démasquer l'écran `objets` si l'objet devient porteur du SLA : | [technique] pour la lecture seule ; **[à valider]** pour le démasquage |
| 4 | **Restitution nominative (zone 7)** : par défaut **par service** ; détail par agent réservé au scope `all` **et** derrière un drapeau explicite. La décision d'exposer un classement nominatif de performance | **[à valider] — ne m'appartient pas** |
| 5 | **Rafraîchissement manuel + à l'ouverture.** Pas de polling au départ (aucun cache dans le dépôt, §9.4 ; tout est recalculé live). Cache court avant tout polling ultérieur, et seulement sur la zone 1. | [technique] |
| 6 | **Exports Excel/PDF hors périmètre v1.** Réactivables ensuite à faible coût (`exportRows`, §12-6). | [technique] ; une question ouverte pour toi : cf. §1.3 |
| 7 | **Période par défaut : 30 jours** pour les widgets de flux/analytique ; les widgets de **stock** (zones 1, 2, et ancienneté D5) **ignorent la période**. Un retard n'appartient pas à une fenêtre temporelle. | [technique] |
| 8 | Dimension « service » affichée **« Arrivées uniquement »** + bucket **« Non rattaché »**, jamais un `WHERE organigramme_id IS NOT NULL` silencieux. Dériver `organigramme_id` aussi à la création d'un Départ = **changement de comportement métier** | **[à valider]** |
| 9 | File Validation Direction : **reproduire l'incohérence de visibilité** (le `where` réel de `listValidationDirection`) pour que le compteur réconcilie avec l'écran, **et** exposer l'écart comme méta-KPI d'hygiène. Ne pas « corriger » en douce. | [technique] |
| 10 | **Un composant `KpiCard` partagé** (valeur + libellé + variation + lien). En interne, **suivre la convention `da-mono`**, ne pas introduire `Statistic` d'AntD (absent du dépôt). | [technique] |
| 11 | **Ajouter les 4 badges manquants** (Parapheur, Validation DG, Décharge, Scans) au menu — mais **séquencé dans le lot `files`**, pas bloquant v1. Confirmer d'abord lesquels des 6 badges existent (le dossier dit 3/6). | [technique] |

### 1.2 Choix structurant ajouté (absent du dossier) — règle de réconciliation

Le dossier fait deux choix **opposés** sans énoncer la règle : l'arbitrage 1 **corrige** la source
(compter tous les Départs), l'arbitrage 9 **reproduit** la source (miroir de l'incohérence
Validation). Règle posée pour trancher tous les cas présents et futurs :

- **Compteurs de files (famille B / zone 2)** = **miroir exact** des écrans. Ils reprennent le
  `where` réel, quirks compris, parce que l'utilisateur les recoupe visuellement. Le test de
  réconciliation (§9) ne vaut que sur cette famille.
- **Compteurs de stock et d'analyse (familles A, C, D, E, F, G)** = **définition correcte**,
  libellés explicites (« tous services », « stock total »).

Sous cette règle : arbitrage 1 (Départs total → famille A) = tous les Départs ✓ ;
arbitrage 9 (file Validation → famille B) = miroir de l'écran ✓. La contradiction disparaît.

### 1.3 Ce qui reste à valider par toi (métier / social / budget)

1. ~~**Restitution nominative par agent** (arbitrage 4)~~ → **TRANCHÉ le 2026-07-21 : nominatif.**
   Implémenté en D7. Deux garde-fous conservés, qui ne relevaient pas de cet arbitrage : accès
   réservé au périmètre global (sinon fuite d'information), et délai médian tu sous 5 dossiers
   (un percentile sur deux dossiers ne mesure rien, et un classement le rendrait tranchant).
2. **Modifier `createDepart`** pour poser `organigramme_id` sur les Départs (arbitrage 8) —
   changement de comportement métier, effets en aval, à décider après vérification code.
3. **Rendre visible la notation SLA** et **démasquer l'écran `objets`** (arbitrages 2 et 3) —
   deux hochements de tête légers ; le SLA fait passer le dashboard du descriptif au qualitatif.
4. **Exports** (arbitrage 6) — un livrable Excel/PDF pour un destinataire précis (COMEX, bailleur)
   changerait-il le périmètre v1 ? Sinon, hors v1.

### 1.4 À vérifier dans le code AVANT de coder (check-list bloquante)

Chaque décision et chaque requête ci-dessous repose sur une affirmation du dossier non revérifiée.
Priorités de vérification, par ordre d'impact :

- [ ] **Les `where` exacts** de `MailsService.listControle`, `listParapheur`,
  `listValidationDirection`, `listDechargesEnAttente`, `listSuivi`, `badgeCounts`
  (`apps/api/src/modules/courriers/mails.service.ts`) → toute la famille B et la règle §1.2 en dépendent. ⟨vérif⟩
- [ ] **`badgeCounts()` renvoie bien `{ controle, validation, suivi }`** et rien d'autre (3 badges / 6). ⟨vérif⟩
- [ ] **`organigramme_id` posé uniquement par `createArrivee`** (`deriveOrganigramme` /
  `domain/organigramme.ts`), jamais par `createDepart` → arbitrages 8, KPI E2/G9. ⟨vérif⟩
- [ ] **`mail_objet.duree_suivi_externe` / `duree_suivi_interne` lues par aucun calcul métier**,
  2 lignes, défaut `0` → arbitrage 2, KPI C4 / G4. ⟨vérif⟩
- [ ] **`end_date_follow_up` n'est jamais écrite** → exclusion de tout KPI « suivi clôturé », comptage Départ. ⟨vérif⟩
- [ ] **`date_decharge` écrite aussi au passage Rédigé d'un Départ** (`domain/mail-status.ts`,
  `markDepartRedige`) → décharge réelle via `mail_document.decharge`, pas via `date_decharge`. ⟨vérif⟩
- [ ] **Résolution du scope** : `MailScope`, `mailScopeFromMenuKeys`, clés `MENU_SUIVI` /
  `MENU_SUIVI_DC` (`domain/mail-scope.ts` + `menu-catalog.ts`), et que `mailScope(user)`
  **relit les menus en base** (le JWT ne les porte pas). ⟨vérif⟩
- [ ] **Orthographe réelle des colonnes** : `date_traited` (sur `mail`) vs `date_treated` (sur
  `mail_inputation`), `date_butoire`, `is_traite`, `duree_suivi_*` — le SQL du §5 les utilise telles quelles. ⟨vérif⟩
- [ ] **Colonnes de libellé** de `organigramme`, `external_entity`, `mail_nature`, `mail_objet`,
  `mail_confidentialite`, `mail_depart_type` (nom exact de la colonne texte affichée). ⟨vérif⟩
- [ ] **Types d'imputation** : ids système 5 / 10 / 14 / 17 (`packages/types/src/courriers.ts`) et
  le drapeau `mail_inputation_type.suivi` qui pilote la segmentation C5. ⟨vérif⟩

---

## 2. Périmètre v1 — KPI retenus et écartés

### 2.1 Retenus

| Famille | KPI retenus | Remarque |
|---|---|---|
| A — Volumétrie/flux | A1, A2, A3, A4, A5, A6, A7, A8 | Tous calculables depuis dates/type/statut de `mail` |
| B — Files | B1, B2, B3, B4, B5, B6, B7 | B1/B2 en **version globale** pour scope `all` (nouveau calcul) ; B4/B5/B6 = **nouveaux compteurs** (pas de badge V6) |
| C — Délais | C1, **C3**, C4, C5 | C3 = KPI phare. C4 **gated** derrière G4. C5 **segmenté** auto/manuel |
| D — Retards | D1, D2, D3, D4, D5, D6, D7 | Cœur de valeur (§3.6 du dossier). D7 en zone 7 (scope `all`) |
| E — Acteurs | E1, E2, E3, E5 | E2 avec descendants + « Non rattaché », Arrivées uniquement |
| F — Correspondants | F1, F2, F3, F4 | F3 en **lecture seule** ; F1 affiché brut + doublons signalés via G8 |
| G — Hygiène | G1…G9 | Zone repliée ; rend le reste fiable |

### 2.2 Retenus mais dégradés au départ (états vides soignés obligatoires)

- **C2 (délai de contrôle)** — calculé mais **non mis en avant** : `mail_action_log` = 2 lignes ⟨vérif⟩.
- **C4 (SLA)** — inactif tant que les durées valent `0` ; le widget affiche « SLA non configuré — N objets sans durée » (lien vers G4).
- **Zone 7 (charge) et D7** — quasi vides à 6 courriers ; visibles seulement en scope `all`.

### 2.3 Écartés de la v1 — avec la raison

| KPI | Raison de l'exclusion |
|---|---|
| **C6** — délai par étape | Dépend de `mail_action_log` (2 lignes) ; redondant avec C2 déjà dégradé. Sans valeur tant que le journal n'est pas alimenté |
| **E4** — répartition de charge (écart-type / ratio) | Statistique de dispersion **ininterprétable à faible effectif** ; à dériver plus tard sur volume réel |
| **E6** — activité de saisie | Audit de saisie, hors pilotage opérationnel v1 ; différable sans coût |
| **F5 / F6** — taux et délai de réponse | Hors des 8 priorités ; données de fil (`mail_parent`) probablement rares ; différable |
| **H1–H4** — activité et audit | H1/H2 dépendent du journal (2 lignes) ⟨vérif⟩ ; H3/H4 relèvent d'une future vue d'audit, pas du tableau de bord de pilotage |

Principe de sobriété appliqué : un KPI non calculable de façon fiable **aujourd'hui** est écarté
explicitement plutôt que porté à moitié.

---

## 3. Modèle de données

### 3.1 Réutilisé tel quel — aucune migration nécessaire pour la v1

D'après le §2 du dossier ⟨vérif sur `packages/db/prisma/models/courriers.prisma`⟩, toutes les
colonnes nécessaires existent déjà :

- `mail` : `status`, `mail_type`, `is_deleted` ; dates `date_enregistrement_courrier`,
  `date_follow_up`, `date_decharge`, `date_traited`, `date_butoire`, `mail_date` ; drapeaux
  `valider`, `validation_direction`, `validation_dg`, `decharge` ; FK `destinataire_expediteur`,
  `destinataire_role_id`, `organigramme_id`, `external_entity_id`, `mail_objet_id`,
  `mail_nature_id`, `confidentialite_id`, `mail_depart_type_id`, `mail_parent`, `created_by`.
- `mail_inputation` : `user_id`, `mail_inputation_type_id`, `deadline`, `date_treated`, `created_at`, `created_by`.
- `mail_document` : `mail_id`, `decharge`. — `mail_scanned_document` : `is_traite`, `date_scanned`.
- `mail_objet` : `duree_suivi_externe`, `duree_suivi_interne`. — `mail_inputation_type` : `suivi`.
- `notification` : `is_read`, `read_at`, `created_at`. — `mail_action_log` : `action_code`, `user_group_id`, `created_at`.
- `organigramme` : `path` (materialized-path). — Référentiels : `is_active`.

**Index existants** (§9.4 ⟨vérif⟩) : `mail(status, mail_type, external_entity_id,
destinataire_expediteur, destinataire_role_id, mail_parent, date_butoire, created_at)` + FK ;
`mail_inputation(mail_id, user_id, mail_inputation_type_id)` ; `mail_scanned_document(is_traite)` ;
`organigramme(path)`. **Couverture jugée suffisante pour la v1.**

### 3.2 Aucune colonne, aucune vue, aucun job

Confirmé par la volumétrie (6 courriers, §1.3) : **pas de pré-agrégation, pas de vue matérialisée,
pas de cache, pas de job de snapshot**. Toutes les requêtes sont **live**. C'est aussi le choix du
dashboard Archives (§9.4).

### 3.3 Seule migration éventuelle — un index partiel, et seulement si mesuré

À n'ajouter **que si** un endpoint dépasse ~500 ms mesurées (§9.4). Le filtre le plus fréquent du
dashboard est `date_traited IS NULL`. Convention de nommage `ix_*`, appliqué de façon **idempotente**
(le dépôt utilise déjà ce pattern dans `packages/db/prisma/sql/analytics.sql` ⟨vérif⟩), via
`prisma db execute --file … --schema prisma` (pas `migrate dev`).

```sql
-- packages/db/prisma/sql/dashboard-courriers.sql   (idempotent, à n'appliquer que si justifié)
CREATE INDEX IF NOT EXISTS ix_mail_en_cours
  ON mail (date_butoire)
  WHERE date_traited IS NULL AND is_deleted = false;

CREATE INDEX IF NOT EXISTS ix_mail_inputation_ouverte
  ON mail_inputation (deadline)
  WHERE date_treated IS NULL;

CREATE INDEX IF NOT EXISTS ix_mail_scanned_non_traite
  ON mail_scanned_document (date_scanned)
  WHERE is_traite = false;
```

Aucune contrainte `ck_*` ni index unique `ux_*` nouveau n'est requis par le tableau de bord.

---

## 4. Contrat d'API

Base : `/courriers/dashboard`. **`POST` + filtre dans le corps** (miroir de `analyticsFilterSchema`,
§8 ⟨vérif⟩), `@HttpCode(200)`. Un endpoint par zone : une agrégation lente n'empêche pas l'affichage
du reste. Emplacement : **nouveau `DashboardController` / `DashboardService` dans
`apps/api/src/modules/courriers/`** (garde la cohésion et l'accès au `MailScope`).

### 4.1 Filtre commun (Zod)

```ts
// apps/api/src/modules/courriers/dto/dashboard-filter.dto.ts
import { z } from 'zod';

export const dashboardFilterSchema = z.object({
  dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dateTo:   z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  mailType: z.coerce.number().int().min(0).max(2).optional(),      // 0 Arrivée | 1 Départ | 2 Interne
  organigrammeId:   z.coerce.number().int().positive().optional(),
  externalEntityId: z.coerce.number().int().positive().optional(),
  granularity: z.enum(['day', 'week', 'month', 'quarter', 'year']).default('day'),
  basis: z.enum(['date_enregistrement_courrier', 'mail_date', 'created_at'])
          .default('date_enregistrement_courrier'),
}).strict();

export type DashboardFilter = z.infer<typeof dashboardFilterSchema>;
```

`repartition` ajoute au corps `dimension` :

```ts
export const repartitionFilterSchema = dashboardFilterSchema.extend({
  dimension: z.enum(['statut', 'type', 'correspondant', 'type_entite',
                     'nature', 'objet', 'confidentialite', 'type_depart']),
}).strict();
```

> **Contraintes de convention (§8/§9.2) :** `ZodValidationPipe` via
> `@Body(new ZodValidationPipe(schema))` ; le pipe exige `input = output` → **`z.coerce.number()`,
> jamais `.transform()`**. Pas de class-validator.

### 4.2 Routes

| Verbe | Route | Garde `@RequireMenu` | KPI | Réponse (type) |
|---|---|---|---|---|
| POST | `/courriers/dashboard/alertes` | `MENU_DASHBOARD` | D1, D3, E5 | `AlertesResponse` |
| POST | `/courriers/dashboard/files` | `MENU_DASHBOARD` | B1–B7 | `FilesResponse` |
| POST | `/courriers/dashboard/synthese` | `MENU_DASHBOARD` | A1, A4, A5, C3 | `SyntheseResponse` |
| POST | `/courriers/dashboard/flux` | `MENU_DASHBOARD` | A7, A8 | `FluxResponse` |
| POST | `/courriers/dashboard/repartition` | `MENU_DASHBOARD` | A2, A3, F1–F4 | `RepartitionResponse` |
| POST | `/courriers/dashboard/delais` | `MENU_DASHBOARD` | C1, C3, C4, C5 | `DelaisResponse` |
| POST | `/courriers/dashboard/retards` | `MENU_DASHBOARD` | D4, D5, D6 | `RetardsResponse` |
| POST | `/courriers/dashboard/charge` | `MENU_DASHBOARD` | E1–E3, C7 | `ChargeResponse` ou **403** si scope `imputed` |
| POST | `/courriers/dashboard/hygiene` | `MENU_DASHBOARD` | G1–G9 | `HygieneResponse` |

> **`MENU_DASHBOARD`** = nouvelle clé `/courriers/tableau-de-bord`, **permission assignable
> normale** (≠ `/dashboards` forcé visible pour tous, cas particulier de `AuthShell.tsx` /
> `CommandPalette.tsx` ⟨vérif⟩). À déclarer **dans les deux fichiers synchronisés** :
> `apps/web/app/components/nav.ts` (section Docu-Courriers) **et**
> `apps/api/src/modules/roles/menu-catalog.ts` + seed `ALL_MENU_KEYS`. ⟨vérif⟩

> ⚠️ **Ordre de routage (§8 ⟨vérif⟩)** : tous les `@Controller('courriers*')` s'aplatissent dans un
> seul routeur ; le `@Get(':id')` glouton de `MailsController` doit rester **enregistré en dernier**.
> → Déclarer `DashboardController` **avant** `MailsController` dans `courriers.module.ts`.

### 4.3 Formes de réponse (TypeScript)

```ts
// apps/api/src/modules/courriers/dto/dashboard-response.ts  (source de vérité ; recopiée côté web)
export interface Oldest { count: number; oldestDays: number | null; }        // compteur + âge du plus ancien
export interface Delta  { value: number; previous: number | null; }          // valeur + période précédente

export interface AlertesResponse {
  scope: 'all' | 'imputed';
  courriersEnRetard: number;         // D1
  imputationsEnRetard: number;       // D3
  sansImputation: number;            // E5
}

export interface FilesResponse {
  scope: 'all' | 'imputed';
  aControler: Oldest;                // B1 (global si all, perso si imputed)
  parapheur: Oldest;                 // B2
  validationDirection: Oldest;       // B3 — reproduit l'incohérence de visibilité (arbitrage 9)
  validationDg: Oldest;              // B4
  decharge: Oldest;                  // B5
  scans: Oldest;                     // B6
  enCours: Oldest;                   // B7
}

export interface SyntheseResponse {
  enregistres: Delta;                // A1
  traites: Delta;                    // A5
  enCours: number;                   // A4 (stock, hors période)
  delaiMedianJours: number | null;   // C3 (médiane)
  delaiP90Jours: number | null;      // C3 (P90)
}

export interface FluxPoint { bucket: string; entrees: number; sorties: number; backlogNet: number; }
export interface FluxResponse { granularity: string; points: FluxPoint[]; }   // A7 + A8

export interface Slice { label: string; value: number; }
export interface RepartitionResponse { dimension: string; slices: Slice[]; }  // A2/A3/F1–F4 ; 'Autres' + '— Sans … —'

export interface DelaisResponse {
  priseEnCharge: { medianeJours: number | null; p90Jours: number | null };   // C1
  traitementGlobal: { medianeJours: number | null; p90Jours: number | null };// C3
  sla: { configure: boolean; dansLesDelais: number; horsDelais: number };     // C4 (configure=false → widget vide)
  imputation: {                                                               // C5 segmenté
    auto:    { medianeJours: number | null; n: number };
    manuel:  { medianeJours: number | null; n: number };
  };
}

export interface Bucket { label: string; count: number; }
export interface TopRetard { mailId: number; title: string; joursRetard: number; }
export interface RetardsResponse { paliers: Bucket[]; anciennete: Bucket[]; top: TopRetard[]; }  // D4/D5/D6

export interface AgentCharge {
  userId: number; label: string;
  ouvertes: number; traitees: number; enRetard: number; delaiMedianJours: number | null; // E1/E3/C7
}
export interface ServiceCharge { organigrammeId: number | null; label: string; ouvertes: number; } // E2
export interface ChargeResponse { agents: AgentCharge[]; services: ServiceCharge[]; }               // effectif < 5 masqué

export interface HygieneResponse {                 // G1–G9, tous des compteurs
  sansEcheance: number; imputationsSansDeadline: number; scansAnciens: number;
  objetsSansDuree: number; referentielsInactifsReferences: number; supprimes: number;
  notificationsNonLues: number; correspondantsDoublon: number; courriersSansRattachement: number;
}
```

### 4.4 Fragment OpenAPI (à ajouter à la main)

Fichier : `specs/001-archivage-qr/contracts/openapi.yaml` (pas de `@nestjs/swagger`) ⟨vérif⟩.
Extrait pour un endpoint ; répliquer le motif pour les 9 chemins.

```yaml
components:
  schemas:
    DashboardFilter:
      type: object
      additionalProperties: false
      properties:
        dateFrom: { type: string, format: date }
        dateTo:   { type: string, format: date }
        mailType: { type: integer, enum: [0, 1, 2] }
        organigrammeId:   { type: integer, minimum: 1 }
        externalEntityId: { type: integer, minimum: 1 }
        granularity: { type: string, enum: [day, week, month, quarter, year], default: day }
        basis:
          type: string
          enum: [date_enregistrement_courrier, mail_date, created_at]
          default: date_enregistrement_courrier
    AlertesResponse:
      type: object
      required: [scope, courriersEnRetard, imputationsEnRetard, sansImputation]
      properties:
        scope: { type: string, enum: [all, imputed] }
        courriersEnRetard:   { type: integer }
        imputationsEnRetard: { type: integer }
        sansImputation:      { type: integer }
paths:
  /courriers/dashboard/alertes:
    post:
      tags: [Docu-Courriers — Tableau de bord]
      summary: Compteurs d'alerte (retards courriers, retards d'imputation, orphelins)
      requestBody:
        required: false
        content:
          application/json:
            schema: { $ref: '#/components/schemas/DashboardFilter' }
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema: { $ref: '#/components/schemas/AlertesResponse' }
        '401': { description: Non authentifié }
```

---

## 5. Requêtes SQL

> **Conventions (§9.2/§9.3)** : SQL brut via **`$queryRaw` + `Prisma.sql`** avec **paramètres
> liés** (jamais d'interpolation). `Prisma.raw` **uniquement** pour un nom de colonne issu d'une
> **liste blanche** (`basis` / `dimension`). **`$executeRaw`** pour toute instruction ne renvoyant
> pas de lignes (rappel du bug `void → P2010`). Prisma `groupBy` ne sait faire ni `date_trunc`, ni
> `percentile_cont`, ni les buckets conditionnels : tout est en SQL.
>
> Les colonnes sont orthographiées **d'après le dossier** — `date_traited` (mail) ≠ `date_treated`
> (imputation), `date_butoire`, `is_traite`, `duree_suivi_*`. **⟨vérif⟩ avant exécution.**

### 5.1 Socle commun (§3.9) et fragments partagés

```sql
-- Socle de visibilité, présent dans TOUTE requête (sauf indication contraire)
--   m.is_deleted = false
--   AND (m.status <> 0 OR m.mail_type = 0)         -- §3.4 : Arrivée visible même en Rédaction

-- Date d'archivage selon le type (§3.7)
--   CASE WHEN m.mail_type = 1 THEN m.date_decharge ELSE m.date_traited END

-- Décharge réellement intégrée (§3.1) — NE PAS utiliser date_decharge ni le drapeau mail.decharge
--   EXISTS (SELECT 1 FROM mail_document md WHERE md.mail_id = m.mail_id AND md.decharge = true)

-- Fenêtre de période sur la colonne "basis" (liste blanche via Prisma.raw)
--   AND <basis> >= $dateFrom::timestamptz AND <basis> < ($dateTo::date + 1)::timestamptz
```

Le **scope** (§5) est un fragment `Prisma.Sql` injecté par `MailsService.mailScope(user)` :

```sql
-- scope = 'all'      → (pas de condition supplémentaire)
-- scope = 'imputed'  → AND EXISTS (SELECT 1 FROM mail_inputation mi
--                                    WHERE mi.mail_id = m.mail_id AND mi.user_id = $userId)
-- scope = 'none'     → AND false
```

### 5.2 `alertes` — D1, D3, E5 (une requête, **hors période**, scope appliqué)

```sql
SELECT
  count(*) FILTER (
    WHERE m.date_butoire < now() AND m.date_traited IS NULL
  )::int AS courriers_en_retard,                                        -- D1
  ( SELECT count(*)::int FROM mail_inputation mi
      JOIN mail mm ON mm.mail_id = mi.mail_id
     WHERE mm.is_deleted = false
       AND mi.deadline < now() AND mi.date_treated IS NULL
       /* + scope sur mm */ ) AS imputations_en_retard,                 -- D3 (zone de silence §3.6)
  count(*) FILTER (
    WHERE m.date_traited IS NULL
      AND NOT EXISTS (SELECT 1 FROM mail_inputation mi WHERE mi.mail_id = m.mail_id)
  )::int AS sans_imputation                                             -- E5
FROM mail m
WHERE m.is_deleted = false
  AND (m.status <> 0 OR m.mail_type = 0)
  /* + scope */ ;
```

### 5.3 `files` — B1…B7 (compteurs + âge du plus ancien)

> **Reproduire les `where` réels ⟨vérif⟩** (règle §1.2). B1/B2 sont **personnels** dans le code ;
> pour un dashboard scope `all`, on calcule la **version globale** (sans le filtre destinataire) et
> on la **libelle** « tous services ». B3 **n'applique pas** la visibilité (arbitrage 9) — reproduit
> tel quel. B2/B4 utilisent `EXISTS` sur `mail_inputation`, **jamais un JOIN** (double comptage).

```sql
-- Version scope 'all'. Chaque compteur = count + âge du plus ancien (jours).
WITH base AS (
  SELECT m.*
  FROM mail m
  WHERE m.is_deleted = false
)
SELECT
  -- B1 À contrôler (global) : valider = false + visibilité
  count(*) FILTER (WHERE valider = false AND (status <> 0 OR mail_type = 0))::int
    AS a_controler,
  max(EXTRACT(day FROM now() - date_enregistrement_courrier))
    FILTER (WHERE valider = false AND (status <> 0 OR mail_type = 0))::int
    AS a_controler_oldest,

  -- B2 Parapheur (global) : imputation actionnable non traitée, type <> 17 (En Copie)
  count(*) FILTER (WHERE (status <> 0 OR mail_type = 0) AND EXISTS (
      SELECT 1 FROM mail_inputation mi
       WHERE mi.mail_id = base.mail_id AND mi.date_treated IS NULL
         AND mi.mail_inputation_type_id <> 17))::int
    AS parapheur,

  -- B3 Validation Direction : valider = true AND date_traited IS NULL — SANS visibilité (reproduit)
  count(*) FILTER (WHERE valider = true AND date_traited IS NULL)::int
    AS validation_direction,

  -- B4 Validation DG (nouveau) : imputation type 5 non traitée AND valider
  count(*) FILTER (WHERE valider = true AND EXISTS (
      SELECT 1 FROM mail_inputation mi
       WHERE mi.mail_id = base.mail_id AND mi.mail_inputation_type_id = 5
         AND mi.date_treated IS NULL))::int
    AS validation_dg,

  -- B5 Intégration décharge (nouveau) : Départ sans document de décharge (§3.1)
  count(*) FILTER (WHERE mail_type = 1 AND NOT EXISTS (
      SELECT 1 FROM mail_document md
       WHERE md.mail_id = base.mail_id AND md.decharge = true))::int
    AS decharge,

  -- B7 En cours (Suivi) : date_traited IS NULL + visibilité (+ scope hors 'all')
  count(*) FILTER (WHERE date_traited IS NULL AND (status <> 0 OR mail_type = 0))::int
    AS en_cours
FROM base;

-- B6 Scans en attente : table distincte
SELECT count(*)::int AS scans,
       max(EXTRACT(day FROM now() - date_scanned))::int AS scans_oldest
FROM mail_scanned_document WHERE is_traite = false;
```

### 5.4 `synthese` — A1, A5, A4, C3

```sql
-- A1 enregistrés sur P / A5 archivés sur P (CASE §3.7) / C3 médiane+P90 du délai global
WITH archives AS (
  SELECT m.*,
         (CASE WHEN m.mail_type = 1 THEN m.date_decharge ELSE m.date_traited END) AS date_archivage
  FROM mail m
  WHERE m.is_deleted = false AND (m.status <> 0 OR m.mail_type = 0)
)
SELECT
  count(*) FILTER (WHERE date_enregistrement_courrier >= $1::timestamptz
                     AND date_enregistrement_courrier < ($2::date + 1))::int AS enregistres,     -- A1
  count(*) FILTER (WHERE date_archivage >= $1::timestamptz
                     AND date_archivage < ($2::date + 1))::int               AS traites,          -- A5
  percentile_cont(0.5) WITHIN GROUP (
    ORDER BY EXTRACT(day FROM date_archivage - date_enregistrement_courrier))
    FILTER (WHERE date_archivage IS NOT NULL)                                AS delai_median,     -- C3
  percentile_cont(0.9) WITHIN GROUP (
    ORDER BY EXTRACT(day FROM date_archivage - date_enregistrement_courrier))
    FILTER (WHERE date_archivage IS NOT NULL)                                AS delai_p90
FROM archives;

-- A4 stock (hors période, requête séparée)
SELECT count(*)::int AS en_cours
FROM mail m
WHERE m.is_deleted = false AND (m.status <> 0 OR m.mail_type = 0)
  AND m.date_traited IS NULL;
```

### 5.5 `flux` — A7 / A8 (série remplie + baseline pour le cumul)

```sql
-- $3 = granularité ('day'|'week'|...) injectée via Prisma.raw (liste blanche)
WITH bornes AS (SELECT $1::timestamptz AS d0, ($2::date + 1)::timestamptz AS d1),
serie AS (
  SELECT generate_series(date_trunc($3, (SELECT d0 FROM bornes)),
                         (SELECT d1 FROM bornes), ('1 ' || $3)::interval) AS bucket
),
faits AS (
  SELECT date_trunc($3, m.date_enregistrement_courrier) AS b_in,
         date_trunc($3, (CASE WHEN m.mail_type = 1 THEN m.date_decharge ELSE m.date_traited END)) AS b_out
  FROM mail m
  WHERE m.is_deleted = false AND (m.status <> 0 OR m.mail_type = 0)
),
-- baseline : tout ce qui précède la fenêtre, pour que le cumul démarre juste
base AS (
  SELECT
    (SELECT count(*) FROM faits WHERE b_in  < (SELECT d0 FROM bornes))::int
  - (SELECT count(*) FROM faits WHERE b_out < (SELECT d0 FROM bornes))::int AS backlog_initial
)
SELECT s.bucket,
       (SELECT count(*) FROM faits WHERE b_in  = s.bucket)::int AS entrees,
       (SELECT count(*) FROM faits WHERE b_out = s.bucket)::int AS sorties,
       ((SELECT backlog_initial FROM base)
        + SUM((SELECT count(*) FROM faits WHERE b_in = s.bucket)
            - (SELECT count(*) FROM faits WHERE b_out = s.bucket))
          OVER (ORDER BY s.bucket))::int AS backlog_net                     -- A8
FROM serie s ORDER BY s.bucket;
```

### 5.6 `repartition` — A2/A3/F1–F4 (dimension en liste blanche)

```sql
-- $col = Prisma.raw d'une colonne autorisée : mail_type | status | external_entity_id
--        | external_entity_type_id | mail_nature_id | mail_objet_id | confidentialite_id | mail_depart_type_id
-- Le TS coupe au Top 8, somme le reste dans 'Autres', épingle la tranche NULL en dernier.
SELECT <col> AS cle, count(*)::int AS valeur
FROM mail m
WHERE m.is_deleted = false AND (m.status <> 0 OR m.mail_type = 0)
  AND m.date_enregistrement_courrier >= $1::timestamptz
  AND m.date_enregistrement_courrier < ($2::date + 1)
GROUP BY <col>
ORDER BY valeur DESC;
```

> **F1 doublons de correspondants (arbitrage : signaler, pas masquer)** — la répartition par
> `external_entity_id` reste **brute** ; la détection de doublons est portée par G8, avec la même
> normalisation que les autres référentiels : `lower(replace(<label>, ' ', ''))` ⟨vérif nom de colonne⟩.

### 5.7 `delais` — C1, C3, C4, C5

```sql
-- C1 prise en charge : date_enregistrement_courrier - mail_date (cast : mail_date est un `date`)
SELECT
  percentile_cont(0.5) WITHIN GROUP (
    ORDER BY EXTRACT(day FROM date_enregistrement_courrier - mail_date::timestamptz)) AS mediane,
  percentile_cont(0.9) WITHIN GROUP (
    ORDER BY EXTRACT(day FROM date_enregistrement_courrier - mail_date::timestamptz)) AS p90
FROM mail m
WHERE m.is_deleted = false AND (m.status <> 0 OR m.mail_type = 0)
  AND m.date_enregistrement_courrier IS NOT NULL AND m.mail_date IS NOT NULL;

-- C5 délai d'imputation, SEGMENTÉ auto / manuel (§3.5) : le drapeau suivi du TYPE décide
SELECT mit.suivi AS auto_traitee,
       percentile_cont(0.5) WITHIN GROUP (
         ORDER BY EXTRACT(day FROM mi.date_treated - mi.created_at)) AS mediane,
       count(*)::int AS n
FROM mail_inputation mi
JOIN mail_inputation_type mit
  ON mit.mail_inputation_type_id = mi.mail_inputation_type_id                  -- ✅ vérifié 2026-07-21
JOIN mail mm ON mm.mail_id = mi.mail_id AND mm.is_deleted = false
WHERE mi.date_treated IS NOT NULL
GROUP BY mit.suivi;
```

```sql
-- C4 SLA (§3.8) : comparer C3 à la durée de l'objet, en JOURS. Externe/interne selon mail_type.
--   mail_type 2 (Interne) -> duree_suivi_interne ; sinon -> duree_suivi_externe   ⟨interprétation à valider⟩
--   Exclure explicitement durée NULL ou 0 (non configurée) — jamais "échéance immédiate".
WITH d AS (
  SELECT m.mail_id,
         EXTRACT(day FROM (CASE WHEN m.mail_type = 1 THEN m.date_decharge ELSE m.date_traited END)
                          - m.date_enregistrement_courrier) AS delai_jours,
         (CASE WHEN m.mail_type = 2 THEN o.duree_suivi_interne ELSE o.duree_suivi_externe END) AS duree
  FROM mail m
  JOIN mail_objet o ON o.mail_objet_id = m.mail_objet_id                       -- ⟨vérif nom colonne PK⟩
  WHERE m.is_deleted = false AND (m.status <> 0 OR m.mail_type = 0)
    AND m.date_traited IS NOT NULL
)
SELECT
  count(*) FILTER (WHERE duree IS NOT NULL AND duree > 0)                       > 0 AS configure,
  count(*) FILTER (WHERE duree > 0 AND delai_jours <= duree)::int              AS dans_les_delais,
  count(*) FILTER (WHERE duree > 0 AND delai_jours >  duree)::int              AS hors_delais
FROM d;
```

### 5.8 `retards` — D4 (paliers), D5 (ancienneté), D6 (top)

```sql
-- D4 paliers : bornes calées sur ReminderLevel (§3.6). Les valeurs de notification sont EXACTES
--   (7/3/1/0/-1..-3) ; le dashboard affiche des TRANCHES pour ne pas perdre 6,5,4,2 (voir §6).
SELECT
  count(*) FILTER (WHERE j <  0)::int              AS en_retard,      -- < J0
  count(*) FILTER (WHERE j =  0)::int              AS aujourd_hui,    -- J0
  count(*) FILTER (WHERE j BETWEEN 1 AND 3)::int   AS j1_j3,
  count(*) FILTER (WHERE j BETWEEN 4 AND 7)::int   AS j4_j7,
  count(*) FILTER (WHERE j >  7)::int              AS au_dela
FROM (
  SELECT EXTRACT(day FROM m.date_butoire - now())::int AS j
  FROM mail m
  WHERE m.is_deleted = false AND (m.status <> 0 OR m.mail_type = 0)
    AND m.date_traited IS NULL AND m.date_butoire IS NOT NULL
) t;

-- D5 ancienneté du backlog : indépendant de date_butoire (rattrape les courriers SANS échéance)
SELECT
  count(*) FILTER (WHERE age_j <  7)::int               AS moins_7,
  count(*) FILTER (WHERE age_j BETWEEN 7  AND 15)::int  AS entre_7_15,
  count(*) FILTER (WHERE age_j BETWEEN 16 AND 30)::int  AS entre_15_30,
  count(*) FILTER (WHERE age_j > 30)::int               AS plus_30
FROM (
  SELECT EXTRACT(day FROM now() - m.date_enregistrement_courrier)::int AS age_j
  FROM mail m
  WHERE m.is_deleted = false AND (m.status <> 0 OR m.mail_type = 0)
    AND m.date_traited IS NULL
) t;

-- D6 top retards : actionnable, lien direct vers le courrier
SELECT m.mail_id, m.title,
       EXTRACT(day FROM now() - m.date_butoire)::int AS jours_retard
FROM mail m
WHERE m.is_deleted = false AND (m.status <> 0 OR m.mail_type = 0)
  AND m.date_traited IS NULL AND m.date_butoire < now()
ORDER BY jours_retard DESC
LIMIT 20;
```

### 5.9 `charge` — E1, E2, E3, C7 (scope `all` uniquement, masquage effectif < 5)

```sql
-- E1 ouvertes / E3 traitées / retards / C7 délai médian, PAR AGENT. Le TS masque les effectifs < 5.
SELECT mi.user_id,
       count(*) FILTER (WHERE mi.date_treated IS NULL)::int                       AS ouvertes,   -- E1
       count(*) FILTER (WHERE mi.date_treated IS NOT NULL)::int                   AS traitees,   -- E3
       count(*) FILTER (WHERE mi.date_treated IS NULL AND mi.deadline < now())::int AS en_retard,
       percentile_cont(0.5) WITHIN GROUP (
         ORDER BY EXTRACT(day FROM mi.date_treated - mi.created_at))
         FILTER (WHERE mi.date_treated IS NOT NULL)                               AS delai_median -- C7
FROM mail_inputation mi
JOIN mail mm ON mm.mail_id = mi.mail_id AND mm.is_deleted = false
GROUP BY mi.user_id;

-- E2 charge par service : rollup materialized-path (descendants) + bucket "Non rattaché".
--   Arrivées uniquement (organigramme_id NULL sur les Départs, §2.2).
SELECT o.organigramme_id,                                                          -- ⟨vérif colonnes⟩
       count(*) FILTER (WHERE mi.date_treated IS NULL)::int AS ouvertes
FROM organigramme o
LEFT JOIN mail m ON m.organigramme_id IN (
    SELECT s.organigramme_id FROM organigramme s WHERE s.path LIKE o.path || '%')   -- '/' final : /3/ ≠ /30/
  AND m.is_deleted = false AND m.mail_type = 0
LEFT JOIN mail_inputation mi ON mi.mail_id = m.mail_id
GROUP BY o.organigramme_id
UNION ALL
SELECT NULL, count(*) FILTER (WHERE mi.date_treated IS NULL)::int
FROM mail m LEFT JOIN mail_inputation mi ON mi.mail_id = m.mail_id
WHERE m.is_deleted = false AND m.mail_type = 0 AND m.organigramme_id IS NULL;       -- "Non rattaché"
```

### 5.10 `hygiene` — G1…G9 (une requête, compteurs `FILTER`)

```sql
SELECT
  (SELECT count(*) FROM mail m WHERE m.is_deleted = false
      AND m.date_butoire IS NULL AND m.date_traited IS NULL)::int                AS sans_echeance,        -- G1
  (SELECT count(*) FROM mail_inputation mi WHERE mi.deadline IS NULL
      AND mi.date_treated IS NULL)::int                                          AS imput_sans_deadline,  -- G2
  (SELECT count(*) FROM mail_scanned_document
      WHERE is_traite = false AND date_scanned < now() - interval '30 days')::int AS scans_anciens,       -- G3
  (SELECT count(*) FROM mail_objet
      WHERE duree_suivi_externe = 0 AND duree_suivi_interne = 0)::int            AS objets_sans_duree,    -- G4
  (SELECT count(*) FROM mail m WHERE m.is_deleted = true)::int                   AS supprimes,            -- G6
  (SELECT count(*) FROM notification WHERE is_read = false)::int                 AS notifs_non_lues,      -- G7
  (SELECT count(*) FROM mail m WHERE m.is_deleted = false
      AND m.organigramme_id IS NULL AND m.mail_type = 0)::int                    AS sans_rattachement;    -- G9
-- G5 (référentiels inactifs référencés) et G8 (correspondants en doublon) : requêtes dédiées
--   G8 : GROUP BY lower(replace(<label>,' ','')) HAVING count(DISTINCT external_entity_id) > 1  ⟨vérif label⟩
```

---

## 6. Logique de domaine pure à isoler et tester

Framework-free, dans `apps/api/src/modules/courriers/domain/`, avec `.spec.ts` (ts-jest).
**Aucune I/O** : ces fonctions prennent des valeurs et renvoient des valeurs — c'est ce qui rend le
tableau de bord testable sans base.

- `dashboard-archivage.ts` → `dateArchivage(mailType, dateDecharge, dateTraited)` : le `CASE` §3.7,
  isolé et testé (Départ → décharge ; Arrivée/Interne → traité).
- `dashboard-buckets.ts` → `bucketAnciennete(ageJours)` : `<7 | 7–15 | 16–30 | >30` (D5) ;
  `bucketPalier(joursAvantButoir)` : `retard | J0 | J1–J3 | J4–J7 | au-delà` (D4).
  **Note de conception à tester** : les niveaux de *notification* (§3.6) sont des **valeurs exactes**
  (7/3/1/0/-1..-3), pas des seuils ; les buckets du dashboard sont des **tranches** qui, elles,
  couvrent aussi 6/5/4/2. Un test doit figer que « J-5 » — cinq jours **restants**, donc la valeur
  `+5` — tombe dans `j4_j7` bien qu'il ne déclenche aucune relance, et qu'un retard de cinq jours
  (valeur `-5`) tombe en `retard`. **Convention : positif = échéance future**, alignée sur le SQL
  du §5.8 et sur `daysUntil()` du worker.
- `dashboard-sla.ts` → `evalSla(delaiJours, dureeExterne, dureeInterne, mailType)` :
  renvoie `{ configure, dansLesDelais }` ; **`duree = 0 | null` ⇒ `configure = false`** (jamais
  « échéance immédiate »). Choix externe/interne selon `mailType`.
- `dashboard-delta.ts` → `variation(courant, precedent)` : la variation vs période précédente
  (zone 3), en gérant `precedent = 0` (pas de division par zéro, renvoyer `null`).
- `top-n.ts` → `regrouperTopN(rows, 8)` : Top 8 + `'Autres'` + tranche `NULL` (`'— Sans … —'`)
  épinglée en dernier. Réutilisable par `repartition` et par les buckets « Non rattaché ».

Ces cinq modules sont le **lot D1** : ils verrouillent la sémantique avant toute UI, exactement
comme les phases B et G du module l'ont fait.

---

## 7. Découpage front

Route : `/courriers/tableau-de-bord`. Répertoire : `apps/web/app/courriers/tableau-de-bord/`.

### 7.1 Arborescence

```
apps/web/app/courriers/tableau-de-bord/
├── page.tsx                     # assemble les zones, lit le scope, orchestre load()
├── lib/api.ts                   # recopie les interfaces de réponse (source: dto/dashboard-response.ts)
├── components/
│   ├── KpiCard.tsx              # NOUVEAU, partagé — valeur (da-mono) + libellé + variation + lien
│   ├── ZoneAlertes.tsx          # D1/D3/E5 ; ligne verte si tout = 0
│   ├── ZoneFiles.tsx            # 6 tuiles cliquables + âge du plus ancien
│   ├── ZoneSynthese.tsx         # 4 KpiCard + variation
│   ├── ZoneFlux.tsx             # barres entrées/sorties + CumulativeArea (backlog net)
│   ├── ZoneRepartition.tsx      # donut statut + barres type (Pie/Bar de @ant-design/plots)
│   ├── ZoneRetards.tsx          # paliers + ancienneté + table top
│   ├── ZoneCharge.tsx           # scope `all` uniquement — non monté si `imputed`
│   ├── ZoneCorrespondants.tsx   # top 10 F1
│   └── ZoneHygiene.tsx          # repliée par défaut, liens correctifs
```

### 7.2 Réutilisé vs nouveau

| Réutilisé tel quel (§9.1 ⟨vérif⟩) | Nouveau |
|---|---|
| `ChartCard`, `PageHeader`, `CardsSkeleton` | `KpiCard` (partagé, convention `da-mono`) |
| `PeriodFilter` (**écrit, jamais monté** — à brancher) | Les 10 composants de zone ci-dessus |
| `CumulativeArea` (**écrite, jamais montée** — pour A8) | `lib/api.ts` de la feature |
| `useChartTheme`, `fmtInt`/`fmtPct`/`fmtDateFr` (`app/theme/charts.ts`) | Le `DashboardController`/`Service` côté API |
| `@ant-design/plots` `^2.6.8` (import `dynamic` `ssr:false`, `autoFit`, `animate={false}`) | |
| Motif `useMemo`(filtre) → `useCallback`(`load`) → `useEffect` (ni SWR ni React Query) | |

### 7.3 Adaptation au scope (§5/§7) — résolue par le **contenu servi**, jamais par masquage d'UI

Le serveur renvoie `scope` dans chaque réponse. Le front s'y adapte :

| Zone | `all` | `imputed` |
|---|---|---|
| 1 Alertes / 2 Files / 3 Chiffres | global | « mon activité » |
| 4–6 Flux / Répartition / Retards | complet | restreint à mes courriers |
| 7 Charge | montée | **non montée** (l'API renvoie 403/vide) |
| 8 Correspondants / 9 Hygiène | montées | non montées |

### 7.4 États vides (à 6 courriers, c'est l'état par défaut)

- Zone 1 : si D1 = D3 = E5 = 0 → **une ligne verte discrète**, pas trois tuiles « 0 ».
- `ChartCard` porte déjà `empty` + `emptyText` (défaut « Aucune donnée pour cette période. ») :
  chaque widget vide **dit ce qu'il montrera**, n'affiche pas « 0 » ni un graphe cassé.
- Widget SLA (C4) non configuré → « SLA non configuré — N objets sans durée » + lien vers G4.
- Tout compteur est **cliquable** vers l'écran filtré correspondant.

---

## 8. Jeu de données de démonstration (lot D2 — le plus sous-estimé)

**Sans lui, ni le rendu, ni les performances, ni la pertinence des seuils ne sont jugeables** à
6 lignes (§1.3), et les arbitrages du §1.3 restent théoriques.

- **Volume** : ~200 courriers étalés sur ~6 mois, répartition réaliste ~60 % Arrivées / ~30 %
  Départs / ~10 % Internes ; un sous-ensemble volontairement **en retard** (`date_butoire`
  passée, `date_traited` NULL), un sous-ensemble **sans échéance** (pour exercer D5/G1), quelques
  **imputations en retard non relancées** (pour D3), des **correspondants en doublon** (« Ministère
  des Finances » vs « MINISTERE DES FINANCES », pour G8/F1), quelques **objets avec durée de suivi
  renseignée** (pour activer C4) et d'autres à `0` (pour G4).
- **Réalisme des dates** : respecter la chronologie (`mail_date` ≤ `date_enregistrement_courrier` ≤
  archivage) et la cohérence statut/drapeaux/dates du §2.2, sinon les KPI de délai deviennent absurdes.
- **Forme du script** : un **seed idempotent et étiqueté**, `packages/db/prisma/seed-dashboard-demo.ts`,
  qui insère avec un marqueur reconnaissable (préfixe de `reference`, p. ex. `DEMO-`), pour un retrait
  ciblé. **Ne jamais** toucher aux données réelles ni lancer `migrate dev`.
- **Réversibilité** : une commande de nettoyage `DELETE … WHERE reference LIKE 'DEMO-%'` (et cascades
  sur `mail_inputation` / `mail_document` / `mail_scanned_document` / `notification` liées),
  exécutée en `$executeRaw`. Documenter la commande dans le README du seed.

---

## 9. Plan de tests

1. **Domaine pur d'abord** (lot D1) : `.spec.ts` sur `dashboard-archivage`, `dashboard-buckets`,
   `dashboard-sla`, `dashboard-delta`, `top-n`. C'est ce qui a validé les phases B et G.
2. **Requêtes SQL** : chaque agrégat vérifié contre un **compte manuel** sur le jeu de démonstration.
3. **Réconciliation compteur ↔ écran** — le test qui attrape les oublis de `is_deleted` et de la
   règle §3.4 :
   - **B1 (global)** ne réconcilie **pas** avec le badge `controle` (personnel) : l'écart est
     **attendu** et libellé. Ce qui doit réconcilier, c'est la **variante personnelle** de B1 avec
     l'écran `/courriers/controle`.
   - **B3** doit égaler l'écran `/courriers/validation` **y compris son incohérence de visibilité**
     (arbitrage 9) — c'est le test qui prouve qu'on a bien *reproduit* et non *corrigé*.
   - **B7** doit égaler `/courriers/suivi` pour un même scope.
   - **Non réconciliable par nature** (à documenter) : familles A/C/D/E/F/G — ce sont des mesures
     de stock/analyse, pas des files ; il n'existe pas d'écran-miroir. La règle §1.2 le formalise.
4. **Scope** : tester explicitement `all`, `imputed`, `none`. `charge` doit renvoyer 403/vide en
   `imputed`. Un utilisateur `none` obtient un tableau de bord vide cohérent.

> Rappels d'environnement (§10 ⟨vérif⟩) : **pas de script `typecheck`** (utiliser `build`) ;
> **un seul `next dev`** à la fois (deux sur le même `.next` → `ChunkLoadError`).

---

## 10. Découpage en lots livrables et critères d'acceptation

| Lot | Contenu | Critères d'acceptation vérifiables |
|---|---|---|
| **D1** | Domaine pur + tests (§6) | ✅ **LIVRÉ 2026-07-21.** Tous les `.spec.ts` passent (213/213) ; `bucketPalier(5)` ∈ `j4_j7` **et** `bucketPalier(-5)` = `retard` (cf. correctif ci-dessous) ; `evalSla(_,_,0,0).configure = false` |
| **D2** | Seed de démonstration (§8) | ✅ **LIVRÉ 2026-07-21.** 200 courriers `DEMO-` ; idempotent (2ᵉ passage : 0 créé) ; invariants à 0 (chronologie, XOR destinataire, dates futures, CHECK) ; base réelle intacte ; `--clean` réversible |
| **D3** | `alertes` + `files` + `synthese` + clé `MENU_DASHBOARD` (nav.ts **et** menu-catalog.ts) + OpenAPI | ✅ **LIVRÉ 2026-07-21.** 3 endpoints → 200 ; `DashboardController` avant `MailsController`, `GET /courriers/:id` intact ; **réconciliation prouvée contre la base réelle** : B3 = 76 = écran Validation, B7 = 96 = écran Suivi, B5 = 35 = décharges-en-attente ; 225/225 tests ; OpenAPI 57 chemins / 43 schémas, 0 `$ref` manquante. Clé réelle : `MENU_DASHBOARD_COURRIERS` = `/courriers/tableau-de-bord` |
| **D4** | Écran zones 1–3 + `KpiCard` partagé + branchement de `PeriodFilter` | ✅ **LIVRÉ 2026-07-21.** Route `/courriers/tableau-de-bord` compile (3660 modules, 0 erreur) et sert 200 ; build web vert ; `PeriodFilter` branché (il ne l'était nulle part) ; tuiles cliquables ; contrat API ↔ interfaces TS vérifié champ par champ contre les réponses réelles. ⚠️ **Rendu visuel NON vérifié** : le Chrome piloté joint Internet mais aucune adresse de ce poste (proxy) — à contrôler à l'œil avant mise en production. `KpiCard` placé dans `app/components/` (et non dans la feature) car réellement partagé |
| **D5** | `flux` + `repartition` (zones 4–5) | ✅ **LIVRÉ 2026-07-21.** Prouvé contre la base : **22 seaux vides conservés** sur une fenêtre creuse (05/01→05/02), 0 discontinuité, cumul exact sur tous les points, `backlogInitial` = 52 ; **total conservé sur les 9 dimensions**, Top 8 + « Autres » + tranche nulle épinglée ; dimension hors liste blanche → 400 ; 232/232 tests (dont 17 sur le dashboard) ; OpenAPI 59 chemins / 48 schémas. **Correctif en cours de route** : `generate_series` incluait sa borne haute → un seau au-delà de la période (33 au lieu de 32), filtré par `s.bucket < toExcl` |
| **D6** | `retards` + `delais` (zone 6), activation du SLA (§3.8) | ✅ **LIVRÉ 2026-07-21.** D4/D5/D6 rendus ; C3 médiane **et** P90 avec effectif affiché ; **C4 activé** (24 dans les délais / 6 hors / 9 non évalués) et *gated* derrière G4 quand aucune durée n'est exploitable ; invariant vérifié en base : paliers (80) + sansEcheance (17) = ancienneté (97) ; 238/238 tests ; OpenAPI 61 chemins / 53 schémas. **Les bornes de tranches ne sont PAS réécrites en SQL** : le SQL agrège par jour, `bucketPalier`/`bucketAnciennete` (domaine testé, lot D1) décident — les deux définitions ne peuvent pas diverger |
| **D7** | `charge` (zone 7, scope `all`) | ✅ **LIVRÉ 2026-07-21.** Arbitrage 4 tranché par le commanditaire : **restitution NOMINATIVE**. 403 hors périmètre global (porté par le service, pas par l'écran) ; délai médian tu sous 5 dossiers (15/16 agents concernés sur le jeu de démo) ; rollup service avec descendants + tranche « Non rattaché » (60 imputations qu'un `IS NOT NULL` aurait fait disparaître) ; 245/245 tests ; OpenAPI 63 chemins / 58 schémas, 9 routes dashboard |
| **D8** | `hygiene` (zone 9) + ajout des badges manquants au menu (arbitrage 11) | ✅ **LIVRÉ 2026-07-21.** G1–G9 rendus, chacun avec sa **conséquence** et son écran de correction ; **3 badges ajoutés** (Parapheur 9, Décharge 34, Scans 0), tous **réconciliés avec leurs écrans** ; 241/241 tests ; OpenAPI 62 chemins / 55 schémas. **Validation DG écarté** : le compteur existe mais aucune entrée de menu ne peut le porter (pas d'écran dédié — déjà le cas dans le module source). ⚠️ **G8 a un angle mort assumé** : la normalisation du dépôt (`lower(replace(label,' ',''))`) ignore la casse et les espaces mais **pas les accents** — « Coopérative » et « Cooperative » ne sont pas vus comme doublons. C'est fidèle à l'index anti-doublon existant, qui a la même limite |

Ordonnancement : **D1 → D2** d'abord (sémantique + matière à juger), puis le socle actionnable
**D3 → D4** (déjà livrable), puis l'analyse **D5 → D6**, enfin **D7** (sous réserve d'arbitrage) et
**D8**.

---

## 11. Risques et pièges à ne pas reproduire

- **Chiffres faux mais crédibles** (§3) — le pire des cas. Appliquer le socle commun (§5.1) partout,
  le `CASE` d'archivage (§3.7), la décharge réelle via `mail_document` (§3.1), et **segmenter C5**
  auto/manuel (§3.5) sinon un délai médian anormalement bas passe pour une performance.
- **Ne pas « corriger » les quirks des files** (B3 sans visibilité, B3 sans filtre
  `validation_direction`) : la réconciliation prime (arbitrage 9, règle §1.2).
- **`date_decharge ≠ décharge réelle`** (§3.1) : la présence d'un document `decharge = true` fait foi.
- **`organigramme_id` sur Arrivées seulement** (§2.2) : jamais de `WHERE organigramme_id IS NOT NULL`
  silencieux ; bucket « Non rattaché » visible ; widget libellé « Arrivées uniquement ».
- **`end_date_follow_up` jamais écrite** (§3.2) : aucun KPI « suivi clôturé » ; compter les Départs
  **sans** reprendre le filtre source.
- **Rollup d'arbre** : `s.path LIKE o.path || '%'` avec le `/` final, sinon `/3/` capture `/30/`.
- **Séries temporelles** : `generate_series` + baseline pré-fenêtre, sinon périodes vides absentes
  et cumul faux.
- **Bug `void → P2010`** (§9.3) : `$executeRaw` pour le SQL sans lignes, `$queryRaw` sinon ;
  paramètres liés toujours, `Prisma.raw` seulement pour une colonne en **liste blanche**.
- **Ordre des contrôleurs** : `DashboardController` avant `MailsController` (`@Get(':id')` glouton).
- **Deux `next dev`** sur le même `.next` → `ChunkLoadError` ; **pas de script `typecheck`**.
- **Redis 5.0.14.1** (§9.4) : sous le minimum recommandé par BullMQ ; sans importance tant qu'aucun
  job de snapshot n'est ajouté — à garder en tête si le seuil de bascule (>100k courriers ou >500 ms)
  est un jour franchi.

---

*Fin du plan. Rappel : ce document est dérivé du dossier de conception et non vérifié contre le
code ; dérouler la check-list §1.4 est la première action avant toute implémentation.*
