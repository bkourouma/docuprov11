# Les deux permissions de Suivi courrier — spécification portable

> Objet : décrire complètement le fonctionnement des permissions
> **« Suivi permanent courrier (tous les courriers) »** et
> **« Suivi des courriers DC (mes imputations uniquement) »** visibles dans
> `/admin/roles`, afin de pouvoir les réimplémenter à l'identique dans une autre
> application.
>
> Référence d'implémentation : DocuPro V6 (NestJS + Prisma + Next.js). Le
> document donne d'abord la règle métier, puis le code réel, puis un guide de
> portage indépendant du framework.

---

## 1. Le problème que ces permissions résolvent

L'écran **« Suivi des courriers »** liste les courriers **encore ouverts** (non
traités), avec leurs échéances et leurs relances. Deux populations très
différentes ont besoin de cet écran :

| Population | Besoin | Risque si on leur donne tout |
|---|---|---|
| Bureau d'ordre, secrétariat de direction, contrôleur de gestion | Piloter **l'ensemble** du flux courrier, relancer n'importe quel service | — |
| Agent / chargé de dossier (« DC ») | Voir **seulement les courriers qui lui ont été imputés** | Fuite d'information : il verrait le courrier de toute l'organisation, y compris ce qui ne le concerne pas |

La solution retenue n'est **pas** un filtre à l'écran (contournable) ni deux
écrans distincts (duplication), mais **deux permissions alternatives qui ouvrent
le même écran avec un périmètre de données différent**, tranché côté serveur.

C'est le point central à reproduire : **le périmètre est une propriété du
compte, calculée par le serveur à chaque requête ; il n'est jamais envoyé par le
client et n'est jamais modifiable à l'écran.**

---

## 2. Les deux permissions

Elles sont déclarées dans le catalogue de permissions de menu, section
`Docu-Courriers` — fichier [menu-catalog.ts](apps/api/src/modules/roles/menu-catalog.ts:27) :

```ts
export const MENU_SUIVI    = '/courriers/suivi';     // Suivi permanent — tous les courriers
export const MENU_SUIVI_DC = '/courriers/suivi-dc';  // Suivi DC — mes imputations uniquement
```

| Clé | Libellé dans `/admin/roles` | Périmètre accordé |
|---|---|---|
| `/courriers/suivi` | Suivi permanent courrier (tous les courriers) | `all` — tous les courriers de la base |
| `/courriers/suivi-dc` | Suivi des courriers DC (mes imputations uniquement) | `imputed` — uniquement ceux où l'utilisateur porte une imputation |
| *(aucune des deux)* | — | `none` — l'écran est inaccessible, les compteurs valent 0 |

### 2.1. `suivi-dc` n'est pas une route — c'est une clé « fantôme »

Dans ce système, une permission = une clé de menu = généralement une route.
`/courriers/suivi-dc` fait exception : **aucune page ne répond à cette URL**.
C'est une *permission de périmètre*, assignable en paramétrage, qui réutilise
l'entrée de sidebar « Suivi des courriers ».

La clé est volontairement choisie **distincte de tout chemin réel** pour qu'aucun
routeur ne puisse l'atteindre par accident.

### 2.2. Les libellés portent le périmètre

Les libellés du catalogue disent explicitement le périmètre
(`(tous les courriers)` / `(mes imputations uniquement)`) : sans cela, l'écran de
paramétrage des rôles afficherait deux cases à cocher voisines rigoureusement
indiscernables, et un administrateur cocherait la mauvaise.

---

## 3. La règle de résolution du périmètre

### 3.1. Le type

```ts
export type MailScope = 'all' | 'imputed' | 'none';
```

### 3.2. L'algorithme — [mail-scope.ts](apps/api/src/modules/courriers/domain/mail-scope.ts)

```ts
export function mailScopeFromMenuKeys(menuKeys: readonly string[]): MailScope {
  if (menuKeys.includes(MENU_SUIVI))    return 'all';      // priorité au plus large
  if (menuKeys.includes(MENU_SUIVI_DC)) return 'imputed';
  return 'none';
}
```

Trois décisions de conception à conserver au portage :

1. **Les deux permissions sont ALTERNATIVES, pas cumulatives.** Si un rôle a les
   deux cases cochées, `all` gagne. Le raisonnement : un cumul qui donnerait
   `imputed` serait un *retrait* de droit par ajout de permission — comportement
   contre-intuitif et source de tickets.
2. **Aucune des deux ⟹ `none`**, jamais un défaut permissif. La liste est vide et
   les compteurs valent 0, plutôt qu'« ouverte par défaut ».
3. **Admin et rôle système obtiennent `all` naturellement**, parce qu'ils
   possèdent toutes les clés du catalogue (voir §3.3) — pas par un `if isAdmin`
   dupliqué dans la fonction.

### 3.3. Les « menus effectifs » dont part le calcul — [menu-access.ts](apps/api/src/modules/auth/menu-access.ts)

```ts
export function effectiveMenuKeys(isAdmin: boolean, role: RoleMenusLike | null): string[] {
  const fullAccess = isAdmin || !!(role && role.isActive && role.isSystem);
  const granted = fullAccess
    ? MENU_KEYS                                   // toutes les clés du catalogue
    : ['/', ...(role && role.isActive ? role.menus.map((m) => m.menuKey) : [])];
  return [...new Set(granted)];
}
```

Points importants :

- un rôle **désactivé** (`isActive = false`) ne donne aucune clé → périmètre `none` ;
- la même fonction sert à l'affichage du menu (`/auth/me`) **et** à
  l'autorisation serveur, ce qui interdit toute dérive entre ce que l'écran
  montre et ce que l'API laisse passer.

### 3.4. Recalcul systématique depuis la base, jamais depuis le JWT

```ts
async mailScope(user: AuthUser): Promise<MailScope> {
  if (user.isAdmin) return 'all';
  const row = await this.prisma.appUser.findUnique({
    where: { userId: user.userId },
    select: {
      isAdmin: true,
      role: { select: { isActive: true, isSystem: true, menus: { select: { menuKey: true } } } },
    },
  });
  return mailScopeFromMenuKeys(effectiveMenuKeys(row?.isAdmin ?? false, row?.role ?? null));
}
```

Le JWT **ne porte pas** les menus : un droit retiré doit prendre effet
immédiatement, sans attendre l'expiration du jeton ni une reconnexion. C'est un
aller-retour base par requête, assumé (requête indexée sur la PK).

Cette méthode est **publique** et partagée : les listes, les badges et le tableau
de bord doivent résoudre le périmètre *exactement* de la même façon, sinon les
compteurs et les listes divergent.

---

## 4. Le sens exact de « mes imputations »

Une **imputation** est l'affectation d'un courrier à un acteur, avec des
instructions et une échéance (table `mail_inputation`).

```prisma
model MailInputation {
  mailInputationId     Int       @id @default(autoincrement())
  instructions         String?
  deadline             DateTime?
  dateTreated          DateTime?   // null = imputation non traitée
  mailInputationTypeId Int
  userId               Int         @map("user_id")  // FK → app_user_group (acteur imputé)
  mailId               Int
}
```

Deux subtilités déterminantes :

1. **L'acteur imputé est un `app_user_group`, pas un `app_user`.** Dans V6,
   l'identité effective est le couple utilisateur × rattachement (le
   `userGroupId` porté par le JWT). Le filtre compare donc
   `mail_inputation.user_id = user.userGroupId`. Dans une application où
   l'acteur est simplement l'utilisateur, on compare à l'`userId` — mais il faut
   trancher ce point **avant** de coder, parce que le filtre entier en dépend.

2. **Toute imputation compte, traitée ou non.** Le périmètre `imputed` ne filtre
   pas sur `dateTreated` : c'est **l'existence du lien** qui ouvre l'accès. Sinon
   un courrier disparaîtrait de la vue de l'agent au moment précis où il vient de
   le traiter, alors qu'il en assure encore le suivi.
   *(À ne pas confondre avec la file « Courriers imputés / parapheur », qui, elle,
   filtre sur `dateTreated = null` — c'est une file d'action, pas un périmètre.)*

3. **Garde-fou `?? -1`** : si l'utilisateur n'a pas d'identité d'acteur
   (`userGroupId = null`), le filtre compare à `-1`, identifiant qui n'existe
   jamais → liste vide. Jamais de `undefined` glissé dans le `where`, qui ferait
   *disparaître la condition* et ouvrirait tout le corpus.

---

## 5. Les points d'application

Le périmètre s'applique à **quatre** endroits. Les oublier, c'est laisser une
porte ouverte.

### 5.1. La garde de route (accès à l'écran)

L'endpoint accepte **l'une ou l'autre** des deux clés :

```ts
// Les deux permissions de suivi sont alternatives : l'une comme l'autre ouvre l'écran,
// le périmètre des données est tranché ensuite par le service.
@RequireMenu(MENU_SUIVI, MENU_SUIVI_DC)
@Get('suivi')
listSuivi(@Query() q: PaginationQueryDto, @CurrentUser() user: AuthUser) {
  return this.mails.listSuivi(user, q);
}
```

La garde ([menu-permission.guard.ts](apps/api/src/modules/auth/menu-permission.guard.ts))
autorise si **au moins une** clé requise figure dans les menus effectifs :

```ts
if (requiredMenus.some((key) => effective.includes(key))) return true;
throw new ForbiddenException("Vous n'avez pas accès à cette section.");
```

**La garde ne fait qu'ouvrir la porte ; elle ne restreint pas les données.** La
restriction est le rôle du service (§5.2).

### 5.2. La liste (filtrage des données)

```ts
async listSuivi(user: AuthUser, opts?) {
  return this.paginateInScope(
    await this.mailScope(user),
    user,
    { isDeleted: false, dateTraited: null, ...this.visibility() },
    opts,
  );
}

private paginateInScope(scope, user, where, opts) {
  if (scope === 'none') {
    return Promise.resolve({ total: 0, page: …, pageSize: …, rows: [] }); // liste vide, pas d'erreur
  }
  return this.paginate(
    scope === 'imputed'
      ? { ...where, inputations: { some: { userId: user.userGroupId ?? -1 } } }
      : where,
    opts,
  );
}
```

Noter que `scope === 'all'` **n'ajoute rien** au `where` : le périmètre global
est l'absence de restriction personnelle, pas une condition supplémentaire.

### 5.3. Le badge du menu

Un compteur qui compte des courriers que l'utilisateur ne peut pas ouvrir est un
leurre. Le badge « Suivi » applique donc **exactement** le même filtre que la
liste :

```ts
const scope = await this.mailScope(user);
const suiviWhere = {
  isDeleted: false,
  dateTraited: null,
  ...this.visibility(),
  ...(scope === 'imputed' ? { inputations: { some: { userId: user.userGroupId ?? -1 } } } : {}),
};
const suivi = scope === 'none' ? 0 : await this.prisma.mail.count({ where: suiviWhere });
```

### 5.4. Le tableau de bord

Le tableau de bord courrier lit en SQL brut. Le périmètre y devient un fragment
injecté dans le **socle commun** de toutes les requêtes :

```ts
private scopeCond(scope: MailScope, user: AuthUser): Prisma.Sql {
  if (scope !== 'imputed') return Prisma.empty;
  return Prisma.sql` AND EXISTS (SELECT 1 FROM mail_inputation mi_s
    WHERE mi_s.mail_id = m.mail_id AND mi_s.user_id = ${user.userGroupId ?? -1})`;
}

private socle(f: DashboardFilterDto, scope: MailScope, user: AuthUser): Prisma.Sql {
  return Prisma.sql`m.is_deleted = false${this.filtres(f)}${this.scopeCond(scope, user)}`;
}
```

Chaque endpoint du tableau de bord commence par
`const scope = await this.mails.mailScope(user);` et **court-circuite sur
`none`** (réponse vide, aucune requête émise).

Le périmètre est **délibérément absent du DTO de filtre** : il ne peut donc pas
être forgé par le client.

#### Widgets réservés au périmètre global

Un widget peut exiger un périmètre minimal :

```ts
{
  id: 'charge',
  titre: 'Charge de travail',
  description: 'Charge par agent et par service. Réservé au suivi permanent.',
  menuRequis: MENU_DASHBOARD_COURRIERS,
  scopeRequis: 'all',   // restitution NOMINATIVE : jamais hors périmètre global
}

export function widgetAutorise(def, menuKeys, scope, isAdmin): boolean {
  if (!isAdmin && !menuKeys.includes(def.menuRequis)) return false;
  if (def.scopeRequis === 'all' && scope !== 'all') return false;
  if (scope === 'none') return false;
  return true;
}
```

Et la restriction est **doublée côté endpoint**, pour qu'un appel direct ne
contourne pas ce que l'écran ne montre pas :

```ts
async charge(user: AuthUser, f: DashboardFilterDto): Promise<ChargeResponse> {
  const scope = await this.mails.mailScope(user);
  if (scope !== 'all') {
    throw new ForbiddenException(
      'La charge de travail n’est consultable qu’avec la permission de suivi permanent.',
    );
  }
  …
}
```

### 5.5. Ce qui n'est **pas** soumis au périmètre

- **La file Validation** : gardée par son seul menu `/courriers/validation`, elle
  n'applique pas le périmètre de suivi (décision explicite, commentée dans le
  contrôleur).
- **Le parapheur / « Courriers imputés »** : toujours personnel par nature
  (imputation **non traitée** adressée à l'utilisateur), indépendamment des deux
  permissions.
- **La recherche courrier**, l'enregistrement, le départ : gardés par leurs
  propres menus.

---

## 6. Le comportement d'interface

### 6.1. Une seule entrée de sidebar, deux clés qui l'ouvrent

Le menu déclare la clé principale et ses **clés alternatives** — [nav.ts](apps/web/app/components/nav.ts:119) :

```ts
{
  key: '/courriers/suivi',
  label: 'Suivi des courriers',
  icon: 'pending',
  keywords: ['suivi', 'échéance', 'relance'],
  altKeys: ['/courriers/suivi-dc'],   // ← ouvre la même entrée
}
```

Filtrage de la sidebar :

```ts
const visible = section.items.filter(
  (item) => !allowed || allowed.has(item.key) || item.altKeys?.some((k) => allowed.has(k)),
);
```

Le même mécanisme `altKeys` est appliqué à la palette de commandes, afin qu'un
utilisateur « DC » puisse aussi atteindre l'écran par la recherche.

**Sans `altKeys`, un utilisateur porteur de la seule permission DC verrait sa
sidebar vide de l'entrée Suivi alors que l'API l'autorise.** C'est le bug le plus
probable au portage.

### 6.2. Le périmètre est affiché, jamais modifiable

L'API renvoie le `scope` calculé, et l'écran l'explique :

```tsx
const texte =
  scope === 'all'      ? 'Périmètre : tous les courriers'
: scope === 'imputed'  ? 'Périmètre : les courriers où vous êtes imputé'
                       : 'Aucun périmètre de suivi accordé';
// Tooltip : « Le périmètre découle de vos permissions de suivi ; il n'est pas modifiable ici. »
```

Renvoyer le `scope` au client sert **uniquement à l'affichage** : il n'est jamais
relu par le serveur.

---

## 7. Modèle de données minimal requis

Pour porter le mécanisme, il faut au minimum :

| Table | Rôle | Colonnes utiles |
|---|---|---|
| `app_user` | comptes | `user_id`, `is_admin`, `role_id` |
| `role` | rôles | `role_id`, `is_active`, `is_system` |
| `role_menu` | permissions accordées au rôle | `role_id`, `menu_key` |
| `mail` | courriers | `mail_id`, `is_deleted`, `date_traited`, `status`, `mail_type` |
| `mail_inputation` | affectations | `mail_id`, `user_id` (acteur), `date_treated` |

`menu_key` est une **chaîne libre validée contre un catalogue applicatif** — c'est
ce qui permet d'introduire une clé fantôme comme `/courriers/suivi-dc` sans
migration de schéma.

Index recommandé : `mail_inputation(user_id, mail_id)` — c'est la condition
`EXISTS` du périmètre `imputed`, évaluée sur chaque requête de liste, de badge et
de tableau de bord.

---

## 8. Guide de portage — implémentation pas à pas

### Étape 1 — Déclarer les deux clés dans le catalogue

```ts
export const MENU_SUIVI    = '/courriers/suivi';
export const MENU_SUIVI_DC = '/courriers/suivi-dc';  // clé fantôme : AUCUNE route ne doit y répondre

MENU_CATALOG.push(
  { key: MENU_SUIVI,    label: 'Suivi permanent courrier (tous les courriers)',      section: 'Courrier' },
  { key: MENU_SUIVI_DC, label: 'Suivi des courriers DC (mes imputations uniquement)', section: 'Courrier' },
);
```

Vérifier que les deux clés sont **assignables** (présentes dans l'écran des
rôles) et que la sauvegarde d'un rôle les valide contre le catalogue.

### Étape 2 — Écrire la fonction pure de résolution

```ts
type MailScope = 'all' | 'imputed' | 'none';

function mailScopeFromMenuKeys(menuKeys: readonly string[]): MailScope {
  if (menuKeys.includes(MENU_SUIVI))    return 'all';
  if (menuKeys.includes(MENU_SUIVI_DC)) return 'imputed';
  return 'none';
}
```

Fonction **pure** = testable sans base ni HTTP. Ne pas y mêler l'admin ni le
chargement de la base.

### Étape 3 — Exposer un unique point de résolution serveur

Une seule méthode `mailScope(user)`, appelée par **tous** les consommateurs
(liste, badge, tableau de bord, exports). Elle recharge le rôle depuis la base à
chaque appel.

### Étape 4 — Appliquer le périmètre dans la couche données

ORM :

```ts
if (scope === 'none')    return EMPTY_PAGE;
if (scope === 'imputed') where.inputations = { some: { userId: actorId ?? -1 } };
// scope === 'all' : aucune condition ajoutée
```

SQL équivalent, paramètre lié :

```sql
SELECT m.*
FROM mail m
WHERE m.is_deleted = false
  AND m.date_traited IS NULL
  AND (m.status <> 'Redaction' OR m.mail_type = 'Arrivee')   -- règle de visibilité générale
  -- fragment injecté SEULEMENT si scope = 'imputed' :
  AND EXISTS (SELECT 1 FROM mail_inputation mi
              WHERE mi.mail_id = m.mail_id AND mi.user_id = $1)
ORDER BY m.mail_id DESC;
```

### Étape 5 — Garder l'endpoint avec les DEUX clés

```ts
@RequireMenu(MENU_SUIVI, MENU_SUIVI_DC)   // sémantique OU
```

### Étape 6 — Aligner tous les compteurs sur la liste

Tout badge, KPI ou export du même écran doit passer par le même `where`. Un
compteur non aligné est une fuite d'information (« il existe 47 courriers » alors
que l'utilisateur n'en voit que 3).

### Étape 7 — Adapter la navigation (`altKeys`)

L'entrée de menu unique doit être visible si `MENU_SUIVI` **ou** `MENU_SUIVI_DC`
est accordée.

### Étape 8 — Afficher le périmètre en clair sur l'écran

Renvoyer le `scope` dans la réponse et l'afficher en mention discrète, avec
l'explication qu'il découle des permissions.

### Étape 9 — Protéger les restitutions nominatives

Tout widget/rapport qui nomme des personnes (charge par agent, classement,
productivité) exige `scope === 'all'` — filtré au catalogue **et** rejeté en 403
par l'endpoint.

---

## 9. Table de vérité (à reprendre en tests)

| Cas | Menus effectifs | `scope` | Écran | Données listées |
|---|---|---|---|---|
| Suivi permanent | `['/courriers/suivi']` | `all` | ouvert | tous les courriers ouverts |
| Suivi DC | `['/courriers/suivi-dc']` | `imputed` | ouvert | ceux où l'utilisateur porte une imputation |
| Les deux cochées | `['/courriers/suivi-dc', '/courriers/suivi']` | `all` | ouvert | tous (le plus large gagne) |
| Aucune des deux | `['/courriers/validation', '/']` | `none` | 403 (garde) | — |
| Liste vide de menus | `[]` | `none` | 403 | — |
| Administrateur | toutes les clés | `all` | ouvert | tous |
| Rôle système actif | toutes les clés | `all` | ouvert | tous |
| Rôle désactivé | `['/']` | `none` | 403 | — |
| DC sans identité d'acteur (`userGroupId = null`) | `['/courriers/suivi-dc']` | `imputed` | ouvert | vide (comparaison à `-1`) |

Tests unitaires existants en référence :
[mail-scope.spec.ts](apps/api/src/modules/courriers/domain/mail-scope.spec.ts),
[mails.service.spec.ts](apps/api/src/modules/courriers/mails.service.spec.ts:251).

---

## 10. Pièges à éviter au portage

1. **Ne jamais accepter le périmètre depuis le client.** Ni en query, ni en body,
   ni en en-tête. C'est la seule vraie protection.
2. **Ne pas mettre les menus dans le JWT.** Sinon un droit retiré reste actif
   jusqu'à l'expiration du jeton.
3. **Ne pas cumuler les deux permissions en intersection.** `all` doit l'emporter.
4. **Ne pas oublier `altKeys` dans la navigation** — l'utilisateur DC verrait un
   écran accessible par URL mais absent de son menu.
5. **Ne pas filtrer `imputed` sur les imputations non traitées.** Le périmètre est
   l'existence du lien ; le filtre « non traité » appartient à la file d'action.
6. **Ne jamais laisser une valeur `undefined`/`null` atteindre le `where`.**
   Utiliser une sentinelle (`-1`) ou court-circuiter. Un `where` amputé de sa
   condition rend l'intégralité du corpus.
7. **Ne pas dupliquer la logique de calcul** entre la liste, le badge et le
   tableau de bord : une seule fonction, sinon ils divergent silencieusement.
8. **Le libellé de permission doit dire le périmètre.** Deux cases nommées
   « Suivi » et « Suivi DC » sans précision seront mal cochées.
9. **Une clé fantôme ne doit correspondre à aucune route réelle**, sous peine
   qu'un routeur ou un lien profond la rende accessible.

---

## 11. Fichiers de référence (DocuPro V6)

| Rôle | Fichier |
|---|---|
| Déclaration des clés + libellés | [apps/api/src/modules/roles/menu-catalog.ts](apps/api/src/modules/roles/menu-catalog.ts) |
| Résolution du périmètre (pure) | [apps/api/src/modules/courriers/domain/mail-scope.ts](apps/api/src/modules/courriers/domain/mail-scope.ts) |
| Menus effectifs (admin / rôle système) | [apps/api/src/modules/auth/menu-access.ts](apps/api/src/modules/auth/menu-access.ts) |
| Garde d'autorisation | [apps/api/src/modules/auth/menu-permission.guard.ts](apps/api/src/modules/auth/menu-permission.guard.ts) |
| Liste Suivi + badges | [apps/api/src/modules/courriers/mails.service.ts](apps/api/src/modules/courriers/mails.service.ts) |
| Endpoint Suivi | [apps/api/src/modules/courriers/mails.controller.ts](apps/api/src/modules/courriers/mails.controller.ts:119) |
| Périmètre en SQL (tableau de bord) | [apps/api/src/modules/courriers/dashboard.service.ts](apps/api/src/modules/courriers/dashboard.service.ts:89) |
| Widgets réservés à `all` | [apps/api/src/modules/courriers/dashboard-widgets.ts](apps/api/src/modules/courriers/dashboard-widgets.ts) |
| Navigation + `altKeys` | [apps/web/app/components/nav.ts](apps/web/app/components/nav.ts:119) · [AuthShell.tsx](apps/web/app/components/AuthShell.tsx:62) |
| Mention de périmètre à l'écran | [apps/web/app/courriers/tableau-de-bord/components/ZoneFiles.tsx](apps/web/app/courriers/tableau-de-bord/components/ZoneFiles.tsx:100) |
