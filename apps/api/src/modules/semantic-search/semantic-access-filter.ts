import { Prisma } from '@prisma/client';
import { DocumentState } from '@archivage/types';
import type { AuthUser } from '../auth/auth.types';

/**
 * Filtre d'accès de la recherche sémantique et des questions-réponses (lot 3).
 *
 * Renvoie une EXPRESSION booléenne SQL (sans `WHERE`) portant sur l'alias `d` (table `document`),
 * à combiner par `AND` DANS la requête pgvector des plus proches voisins : le filtre s'applique
 * avant le classement et la limite, jamais après coup. Filtrer après coup ferait fuiter des
 * segments (et des scores) de documents interdits, et viderait les résultats d'un utilisateur
 * peu habilité dès que les premiers voisins lui sont interdits.
 *
 * SYNCHRONISATION OBLIGATOIRE — la logique de droits est une COPIE de
 * `SearchService.buildWhere` / `permissionCondition` / `ownDocumentGrant` / `inForce` /
 * `actorGroups` / `actorProfiles` (`modules/search/search.service.ts`, non exportés) et doit
 * rester identique à `DocumentsService.canAccess` (`modules/documents/documents.service.ts`).
 * Toute modification de l'une de ces règles doit être reportée ici, et inversement : sinon la
 * recherche sémantique montre (ou cite dans une réponse) ce que l'utilisateur ne peut pas ouvrir,
 * ou l'inverse. `semantic-access-filter.spec.ts` compare la SQL produite ici à celle de
 * `SearchService.buildWhere` et échoue dès que les deux divergent.
 *
 * Conditions d'ÉTAT, appliquées à TOUS (y compris administrateur et agent de numérisation) :
 *  - `d.is_archived = true` : la recherche porte sur l'archive validée, comme `/search` ;
 *  - `d.document_state <> Épuré (3)` : un document épuré (DUA expirée et traitée) n'est plus
 *    consultable par la GED IA ;
 *  - `d.is_frozen = false` : DÉCISION PRUDENTE ET RÉVERSIBLE — un document gelé est exclu de la
 *    recherche sémantique et des réponses. Question métier signalée au superviseur : un document
 *    gelé reste-t-il interrogeable ? `/search` et `canAccess` ne l'excluent pas ; si la réponse
 *    est oui, il suffit de retirer cette condition (et le test correspondant).
 * Les colonnes sont `NOT NULL` ; si l'une valait `NULL`, la comparaison serait `NULL` et la ligne
 * exclue : le doute exclut.
 *
 * Conditions de DROITS, pour tout autre utilisateur que l'administrateur et l'agent de
 * numérisation (même passe-droit que `canAccess`, qui renvoie `true` pour eux sans rien vérifier,
 * et que `buildWhere`) :
 *  - CONFIDENTIALITÉ : aucune confidentialité requise, ou créateur (la personne, sur l'ensemble de
 *    ses comptes-groupes), ou droit nominatif en vigueur sur CE document, ou rang suffisant ;
 *  - DROITS EXPLICITES : refus explicite (niveau 1) en vigueur qui l'emporte sur tout, y compris
 *    le créateur ; puis créateur ; puis document et type sans droit accordé en vigueur (non
 *    restreints) ; puis droit en vigueur sur le document (compte-groupe ou profil) ou sur le type
 *    (compte-groupe ou rôle).
 *
 * Écart connu avec `canAccess` (hérité de `buildWhere`, conservé volontairement) : une
 * confidentialité référencée mais introuvable laisse passer `canAccess` alors que la SQL exclut
 * le document (la jointure échoue). On garde la variante SQL, qui exclut en cas de doute.
 *
 * Toutes les valeurs passent en paramètres liés (`Prisma.sql`) ; seuls des fragments constants
 * écrits ici sont insérés tels quels (`Prisma.raw` de `inForce`, sur des alias fixes).
 */
export function buildSemanticAccessFilter(user: AuthUser): Prisma.Sql {
  if (user == null || typeof user !== 'object') {
    throw new Error('Filtre d’accès sémantique : utilisateur absent.');
  }
  // Valide l'identifiant AVANT tout passe-droit : un jeton corrompu ne doit jamais aboutir à un
  // filtre, même pour un profil privilégié. L'agent de numérisation porte `userId = -1`
  // (identité machine, cf. `jwt-auth.guard.ts`) : seul un entier sûr est exigé pour lui.
  if (typeof user.userId !== 'number' || !Number.isSafeInteger(user.userId)) {
    throw new Error('Filtre d’accès sémantique : identifiant utilisateur invalide.');
  }

  const state: Prisma.Sql[] = [
    Prisma.sql`d.is_archived = true`,
    Prisma.sql`d.document_state <> ${DocumentState.Epure}`,
    Prisma.sql`d.is_frozen = false`,
  ];

  // Comparaison stricte : seul le booléen `true` ouvre le passe-droit (une valeur inattendue
  // retombe sur le filtre complet).
  if (user.isAdmin === true || user.isScanAgent === true) {
    return Prisma.sql`(${Prisma.join(state, ' AND ')})`;
  }

  // Un utilisateur ordinaire correspond à une ligne de `app_user` : identifiant strictement positif.
  if (user.userId <= 0) {
    throw new Error('Filtre d’accès sémantique : identifiant utilisateur invalide.');
  }
  const userId = user.userId;

  return Prisma.sql`(${Prisma.join(
    [...state, confidentialityCondition(userId), permissionCondition(userId)],
    ' AND ',
  )})`;
}

// --- Copie de `search.service.ts` (garder SYNCHRONE) --------------------------------------------

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
const ownDocumentGrant = (userId: number) => Prisma.sql`EXISTS (
  SELECT 1 FROM document_permission dg
  WHERE dg.document_id = d.document_id AND dg.permission_level_id >= 2 AND ${inForce('dg')}
    AND (dg.user_group_id IN (${actorGroups(userId)})
         OR dg.group_id IN (${actorProfiles(userId)}))
)`;

/** Axe CONFIDENTIALITÉ — même clause que `SearchService.buildWhere`. */
function confidentialityCondition(userId: number): Prisma.Sql {
  return Prisma.sql`(
        d.confidentialite_id IS NULL
        OR d.created_by IN (${actorGroups(userId)})
        OR ${ownDocumentGrant(userId)}
        OR EXISTS (
          SELECT 1 FROM app_user u
          JOIN confidentialite uc ON uc.confidentialite_id = u.confidentialite_id
          JOIN confidentialite dc ON dc.confidentialite_id = d.confidentialite_id
          WHERE u.user_id = ${userId} AND uc.rank >= dc.rank
        )
      )`;
}

/** Axe DROITS EXPLICITES — même clause que `SearchService.permissionCondition`. */
function permissionCondition(userId: number): Prisma.Sql {
  return Prisma.sql`(
    NOT EXISTS (
      SELECT 1 FROM document_permission dn
      WHERE dn.document_id = d.document_id AND dn.permission_level_id = 1 AND ${inForce('dn')}
        AND (dn.user_group_id IN (${actorGroups(userId)})
             OR dn.group_id IN (${actorProfiles(userId)}))
    )
    AND (
      d.created_by IN (${actorGroups(userId)})
      OR (
        NOT EXISTS (
          SELECT 1 FROM document_permission dp
          WHERE dp.document_id = d.document_id AND dp.permission_level_id >= 2 AND ${inForce('dp')}
        )
        AND NOT EXISTS (
          SELECT 1 FROM document_type_permission tp
          WHERE tp.document_type_id = d.document_type_id AND tp.permission_level_id >= 2
            AND ${inForce('tp')}
        )
      )
      OR ${ownDocumentGrant(userId)}
      OR EXISTS (
        SELECT 1 FROM document_type_permission tp
        WHERE tp.document_type_id = d.document_type_id AND tp.permission_level_id >= 2
          AND ${inForce('tp')}
          AND (tp.user_group_id IN (${actorGroups(userId)})
               OR tp.role_id = (SELECT role_id FROM app_user WHERE user_id = ${userId}))
      )
    )
  )`;
}
