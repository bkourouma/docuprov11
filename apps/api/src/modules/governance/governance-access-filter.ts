import { Prisma } from '@prisma/client';
import { GovernanceKind } from '@archivage/types';
import type { AuthUser } from '../auth/auth.types';

/**
 * Filtres SQL de droits de l'écran « Gouvernance » (lot 5).
 *
 * Deux expressions booléennes SQL (sans `WHERE`), à combiner par `AND` DANS les requêtes de
 * lecture (liste, tableau de bord, détail) : le filtre s'applique avant le tri, la pagination et
 * les comptes, jamais après coup — sinon les totaux révéleraient l'existence de propositions sur
 * des documents interdits.
 *
 *  - `buildGovernanceAccessFilter(user, alias)` : « l'utilisateur peut ouvrir le document
 *    d'alias `alias` ». Ce sont les DROITS seuls, sans les conditions d'ÉTAT du lot 3
 *    (`is_archived`, `document_state <> Épuré`, `is_frozen = false`) : un doublon archivé
 *    logiquement (gelé) par une validation doit rester visible ici, avec sa proposition.
 *  - `buildProposalVisibilityFilter(user, decisionAlias)` : « l'utilisateur peut voir la
 *    proposition (`ged_ai_decision`) d'alias `decisionAlias` » : son document existe ET est
 *    ouvrable, ET, si `output.originalDocumentId` est présent, l'original existe ET est ouvrable
 *    (on n'apprend jamais l'existence d'un original qu'on ne peut pas ouvrir).
 *
 * SYNCHRONISATION OBLIGATOIRE — la logique de droits est une COPIE de `buildSemanticAccessFilter`
 * (`modules/semantic-search/semantic-access-filter.ts`, helpers non exportés), elle-même copie de
 * `SearchService.buildWhere` / `permissionCondition` / `ownDocumentGrant` / `inForce` /
 * `actorGroups` / `actorProfiles` (`modules/search/search.service.ts`), et doit rester identique
 * à `DocumentsService.canAccess` (`modules/documents/documents.service.ts`). Toute modification de
 * l'une de ces règles doit être reportée ici, et inversement : sinon l'écran de gouvernance montre
 * ce que l'utilisateur ne peut pas ouvrir, ou l'inverse. `governance-access-filter.spec.ts`
 * compare la SQL produite ici à celle du lot 3 (une fois retirées les trois conditions d'état) et
 * échoue dès que les deux divergent. Seule différence voulue : l'alias du document est un
 * paramètre (validé strictement, voir `assertAlias`), au lieu de `d` en dur.
 *
 * Écart connu avec `canAccess` (hérité, conservé volontairement) : une confidentialité référencée
 * mais introuvable laisse passer `canAccess` alors que la SQL exclut le document. On garde la
 * variante SQL, qui exclut en cas de doute.
 *
 * Toutes les VALEURS passent en paramètres liés (`Prisma.sql`). Les seuls fragments insérés tels
 * quels (`Prisma.raw`) sont des constantes écrites ici et les alias, validés par une expression
 * régulière stricte et une liste d'alias réservés (ceux des sous-requêtes et les noms de tables).
 *
 * LIMITE : aucune base PostgreSQL n'est disponible pour les tests. Le spec prouve (1) que le texte
 * SQL des droits est IDENTIQUE à celui du lot 3, paramètres compris, (2) la structure de la
 * visibilité (deux `EXISTS`, document et original, chacun portant ce même filtre ; `document_id`
 * NULL exclu ; transtypage gardé par une expression régulière dans un `CASE`), (3) les
 * validations d'identité et d'alias. Il ne prouve PAS que PostgreSQL évalue ces expressions comme
 * prévu sur des jeux de droits réels : cela exige un test d'intégration sur une base réelle.
 */

/** Alias SQL acceptés : identifiant minuscule court, rien qui puisse fermer une expression. */
const ALIAS_PATTERN = /^[a-z][a-z0-9_]{0,15}$/;

/** Alias internes des documents de `buildProposalVisibilityFilter`. */
export const VISIBILITY_DOCUMENT_ALIAS = 'gov_doc';
export const VISIBILITY_ORIGINAL_ALIAS = 'gov_orig';

/** `originalDocumentId` n'est transtypé en `int` que s'il correspond à ce motif (au plus 9 chiffres). */
export const ORIGINAL_ID_PATTERN = '^[0-9]{1,9}$';

/**
 * Alias refusés : ceux des sous-requêtes de droits (une collision changerait silencieusement la
 * corrélation), ceux de la visibilité, les tables lues par le filtre (un alias homonyme masquerait
 * la table dans une sous-requête) et quelques mots réservés SQL (requête invalide).
 */
export const RESERVED_ALIASES: ReadonlySet<string> = new Set([
  // sous-requêtes de droits
  'dg',
  'dn',
  'dp',
  'tp',
  'u',
  'uc',
  'dc',
  // visibilité des propositions
  VISIBILITY_DOCUMENT_ALIAS,
  VISIBILITY_ORIGINAL_ALIAS,
  // tables lues
  'document',
  'document_permission',
  'document_type_permission',
  'app_user',
  'app_user_group',
  'confidentialite',
  'ged_ai_decision',
  // mots réservés courants
  'all',
  'and',
  'any',
  'as',
  'case',
  'cast',
  'do',
  'else',
  'end',
  'exists',
  'false',
  'from',
  'in',
  'is',
  'join',
  'not',
  'null',
  'on',
  'or',
  'select',
  'then',
  'true',
  'user',
  'when',
  'where',
  'with',
]);

/** Refuse tout alias qui n'est pas un identifiant sûr et libre (il est inséré tel quel en SQL). */
function assertAlias(alias: unknown, role: string): string {
  if (typeof alias !== 'string' || !ALIAS_PATTERN.test(alias) || RESERVED_ALIASES.has(alias)) {
    throw new Error(`Filtre d’accès de gouvernance : alias ${role} invalide.`);
  }
  return alias;
}

/**
 * Valide l'identité portée par le jeton, comme le lot 3 : un jeton corrompu ne doit jamais
 * aboutir à un filtre, même pour un profil privilégié. Renvoie `null` pour le passe-droit
 * (administrateur / agent de numérisation, comparaison stricte à `true`), sinon l'identifiant.
 */
function resolveUser(user: AuthUser): number | null {
  if (user == null || typeof user !== 'object') {
    throw new Error('Filtre d’accès de gouvernance : utilisateur absent.');
  }
  // L'agent de numérisation porte `userId = -1` (identité machine) : seul un entier sûr est
  // exigé pour lui, comme au lot 3.
  if (typeof user.userId !== 'number' || !Number.isSafeInteger(user.userId)) {
    throw new Error('Filtre d’accès de gouvernance : identifiant utilisateur invalide.');
  }
  if (user.isAdmin === true || user.isScanAgent === true) return null;
  // Un utilisateur ordinaire correspond à une ligne de `app_user` : identifiant strictement positif.
  if (user.userId <= 0) {
    throw new Error('Filtre d’accès de gouvernance : identifiant utilisateur invalide.');
  }
  return user.userId;
}

/** Expression SQL booléenne « l'utilisateur peut ouvrir le document d'alias `alias` » (droits seulement). */
export function buildGovernanceAccessFilter(user: AuthUser, alias = 'd'): Prisma.Sql {
  return rightsFilter(user, assertAlias(alias, 'de document'));
}

/** Droits seuls, sur un alias DÉJÀ validé (les alias internes réservés passent par ici). */
function rightsFilter(user: AuthUser, alias: string): Prisma.Sql {
  const userId = resolveUser(user);
  // Administrateur et agent de numérisation : même passe-droit que `canAccess`, et aucune
  // condition d'état (la gouvernance doit voir aussi les documents gelés).
  if (userId === null) return Prisma.sql`TRUE`;
  const d = Prisma.raw(alias);
  return Prisma.sql`(${Prisma.join(
    [confidentialityCondition(d, userId), permissionCondition(d, userId)],
    ' AND ',
  )})`;
}

/**
 * Expression SQL booléenne « l'utilisateur peut voir la proposition d'alias `decisionAlias` »
 * (`ged_ai_decision`) : document concerné ET, pour un doublon, document original, tous deux
 * existants et ouvrables.
 *
 *  - `document_id` NULL (document supprimé, `ON DELETE SET NULL`) : invisible pour TOUT LE MONDE,
 *    administrateur compris (l'`EXISTS` sur `document` exige aussi que la ligne existe).
 *  - `output->>'originalDocumentId'` : transtypé en `int` UNIQUEMENT s'il s'écrit avec 1 à 9
 *    chiffres, garde placée dans un `CASE` (PostgreSQL n'évalue la branche `THEN` que si la
 *    condition est vraie, alors qu'un `AND` n'a pas d'ordre garanti) : jamais d'erreur de
 *    transtypage. Valeur non numérique, négative ou trop longue : le `CASE` vaut NULL, l'`EXISTS`
 *    est faux, la proposition est invisible (le doute exclut).
 *  - Un DOUBLON (`output.kind` duplicate_*) sans `originalDocumentId` est invisible lui aussi.
 */
export function buildProposalVisibilityFilter(user: AuthUser, decisionAlias = 'a'): Prisma.Sql {
  const alias = assertAlias(decisionAlias, 'de proposition');
  const a = Prisma.raw(alias);
  const docAlias = Prisma.raw(VISIBILITY_DOCUMENT_ALIAS);
  const origAlias = Prisma.raw(VISIBILITY_ORIGINAL_ALIAS);
  const documentRights = rightsFilter(user, VISIBILITY_DOCUMENT_ALIAS);
  const originalRights = rightsFilter(user, VISIBILITY_ORIGINAL_ALIAS);
  const originalId = Prisma.raw(`${alias}.output->>'originalDocumentId'`);

  return Prisma.sql`(
    ${a}.document_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM document ${docAlias}
      WHERE ${docAlias}.document_id = ${a}.document_id
        AND ${documentRights}
    )
    AND (
      (
        ${originalId} IS NULL
        AND COALESCE(${a}.output->>'kind', '') NOT IN (${GovernanceKind.DoublonExact}, ${GovernanceKind.QuasiDoublon})
      )
      OR EXISTS (
        SELECT 1 FROM document ${origAlias}
        WHERE ${origAlias}.document_id = (
            CASE WHEN ${originalId} ~ ${ORIGINAL_ID_PATTERN} THEN (${originalId})::int END
          )
          AND ${originalRights}
      )
    )
  )`;
}

// --- Copie de `semantic-access-filter.ts` / `search.service.ts` (garder SYNCHRONE) ---------------
// Seule différence : l'alias `d` du document est un paramètre déjà validé (`Prisma.raw`).

/** Comptes-groupes de la PERSONNE — un utilisateur peut en avoir plusieurs, le jeton n'en porte qu'un. */
const actorGroups = (userId: number) =>
  Prisma.sql`SELECT user_group_id FROM app_user_group WHERE user_id = ${userId}`;

/** Profils de la personne (`app_group`), bénéficiaire collectif des droits sur UN document. */
const actorProfiles = (userId: number) =>
  Prisma.sql`SELECT group_id FROM app_user_group WHERE user_id = ${userId}`;

/** Un droit n'est effectif que dans sa fenêtre de validité (`null` d'un côté = pas de borne). */
const inForce = (t: 'dg' | 'dn' | 'dp' | 'tp') =>
  Prisma.raw(
    `(${t}.start_date IS NULL OR ${t}.start_date <= now()) AND (${t}.end_date IS NULL OR ${t}.end_date >= now())`,
  );

/** Droit EN VIGUEUR de la personne sur CE document (compte-groupe ou profil). */
const ownDocumentGrant = (d: Prisma.Sql, userId: number) => Prisma.sql`EXISTS (
  SELECT 1 FROM document_permission dg
  WHERE dg.document_id = ${d}.document_id AND dg.permission_level_id >= 2 AND ${inForce('dg')}
    AND (dg.user_group_id IN (${actorGroups(userId)})
         OR dg.group_id IN (${actorProfiles(userId)}))
)`;

/** Axe CONFIDENTIALITÉ — même clause que `SearchService.buildWhere`. */
function confidentialityCondition(d: Prisma.Sql, userId: number): Prisma.Sql {
  return Prisma.sql`(
        ${d}.confidentialite_id IS NULL
        OR ${d}.created_by IN (${actorGroups(userId)})
        OR ${ownDocumentGrant(d, userId)}
        OR EXISTS (
          SELECT 1 FROM app_user u
          JOIN confidentialite uc ON uc.confidentialite_id = u.confidentialite_id
          JOIN confidentialite dc ON dc.confidentialite_id = ${d}.confidentialite_id
          WHERE u.user_id = ${userId} AND uc.rank >= dc.rank
        )
      )`;
}

/** Axe DROITS EXPLICITES — même clause que `SearchService.permissionCondition`. */
function permissionCondition(d: Prisma.Sql, userId: number): Prisma.Sql {
  return Prisma.sql`(
    NOT EXISTS (
      SELECT 1 FROM document_permission dn
      WHERE dn.document_id = ${d}.document_id AND dn.permission_level_id = 1 AND ${inForce('dn')}
        AND (dn.user_group_id IN (${actorGroups(userId)})
             OR dn.group_id IN (${actorProfiles(userId)}))
    )
    AND (
      ${d}.created_by IN (${actorGroups(userId)})
      OR (
        NOT EXISTS (
          SELECT 1 FROM document_permission dp
          WHERE dp.document_id = ${d}.document_id AND dp.permission_level_id >= 2 AND ${inForce('dp')}
        )
        AND NOT EXISTS (
          SELECT 1 FROM document_type_permission tp
          WHERE tp.document_type_id = ${d}.document_type_id AND tp.permission_level_id >= 2
            AND ${inForce('tp')}
        )
      )
      OR ${ownDocumentGrant(d, userId)}
      OR EXISTS (
        SELECT 1 FROM document_type_permission tp
        WHERE tp.document_type_id = ${d}.document_type_id AND tp.permission_level_id >= 2
          AND ${inForce('tp')}
          AND (tp.user_group_id IN (${actorGroups(userId)})
               OR tp.role_id = (SELECT role_id FROM app_user WHERE user_id = ${userId}))
      )
    )
  )`;
}
