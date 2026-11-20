// Domaine PUR du contrôle d'accès aux espaces GED : aucune dépendance NestJS/Prisma.
//
// Principe : REFUS PAR DÉFAUT. Toute décision part de `visible: false` et n'ouvre un droit que sur
// un fait positif (propriétaire, ligne de membre, publication, lecture administrateur).
//
// Ce module décide de l'accès à l'ESPACE, jamais à un document : la visibilité d'un document reste
// celle de `DocumentsService.canAccess` (confidentialité + droits par document/type). Être membre
// d'un espace ne donne aucun droit documentaire — cf. `isDocumentListable`.
import { GedSpaceKind, GedSpacePermission, type GedSpaceAccess } from '@archivage/types';

/**
 * L'acteur, résolu au niveau de la PERSONNE (comme `DocumentsService.actorScope`) : le jeton ne
 * porte qu'un compte-groupe, la personne peut en avoir plusieurs.
 */
export interface SpaceActor {
  /** Tous les comptes-groupes (`app_user_group.user_group_id`) de la personne. */
  userGroupIds: readonly number[];
  /** Rôle de la personne, seulement s'il est ACTIF (un rôle désactivé n'ouvre aucun droit). */
  roleId: number | null;
  isAdmin: boolean;
}

export interface SpaceMemberFact {
  userGroupId: number | null;
  roleId: number | null;
  permission: number;
}

export interface SpaceAccessFacts {
  kind: number;
  isActive: boolean;
  ownerUserGroupId: number;
  /** Lignes `ged_space_member` de l'espace (toutes, ou au moins celles qui visent l'acteur). */
  members: readonly SpaceMemberFact[];
}

/**
 * Portée du listing des documents d'un espace :
 *  - `full` : propriétaire, membre (ou administrateur en lecture) — tous les documents qui passent
 *    `canAccess` ;
 *  - `public` : lecteur d'une publication (ni propriétaire ni membre) — en plus de `canAccess`,
 *    seulement les documents SANS niveau de confidentialité : publier ne rend jamais visible un
 *    document dont la confidentialité l'interdit.
 */
export type SpaceDocumentScope = 'full' | 'public';

export interface SpaceAccessDecision {
  /** L'espace existe-t-il pour l'acteur ? `false` ⟹ 404 (ne pas révéler son existence). */
  visible: boolean;
  /** Droit réel : `owner`, niveau de membre, ou `null` (lecture seule sans droit propre). */
  access: GedSpaceAccess | null;
  canContribute: boolean;
  canManage: boolean;
  canDelete: boolean;
  documentScope: SpaceDocumentScope;
}

const DENIED: SpaceAccessDecision = Object.freeze({
  visible: false,
  access: null,
  canContribute: false,
  canManage: false,
  canDelete: false,
  documentScope: 'public',
});

const KNOWN_PERMISSIONS: readonly number[] = [
  GedSpacePermission.Lecture,
  GedSpacePermission.Contribution,
  GedSpacePermission.Gestion,
];

function isPermission(value: number): value is GedSpacePermission {
  return KNOWN_PERMISSIONS.includes(value);
}

/** Le propriétaire est la PERSONNE : `ownerUserGroupId` est l'un de SES comptes-groupes. */
export function isSpaceOwner(space: Pick<SpaceAccessFacts, 'ownerUserGroupId'>, actor: SpaceActor) {
  return actor.userGroupIds.includes(space.ownerUserGroupId);
}

/**
 * Permission de membre de l'acteur, indépendamment de la nature de l'espace : MAXIMUM des lignes
 * qui le visent (par l'un de ses comptes-groupes ou par son rôle actif). `null` si aucune.
 * Une valeur hors 0..2 (donnée corrompue) est ignorée plutôt qu'interprétée.
 */
export function memberPermission(
  members: readonly SpaceMemberFact[],
  actor: SpaceActor,
): GedSpacePermission | null {
  let best: GedSpacePermission | null = null;
  for (const m of members) {
    const byUser = m.userGroupId != null && actor.userGroupIds.includes(m.userGroupId);
    const byRole = m.roleId != null && actor.roleId != null && m.roleId === actor.roleId;
    if (!byUser && !byRole) continue;
    if (!isPermission(m.permission)) continue;
    if (best == null || m.permission > best) best = m.permission;
  }
  return best;
}

function decisionFor(
  access: GedSpaceAccess | null,
  scope: SpaceDocumentScope,
): SpaceAccessDecision {
  const isOwner = access === 'owner';
  const level = typeof access === 'number' ? access : -1;
  return {
    visible: true,
    access,
    canContribute: isOwner || level >= GedSpacePermission.Contribution,
    canManage: isOwner || level >= GedSpacePermission.Gestion,
    canDelete: isOwner,
    documentScope: scope,
  };
}

/**
 * Décision d'accès d'un acteur à un espace.
 *
 *  1. Espace inactif (supprimé logiquement) : accessible à personne.
 *  2. Propriétaire (via n'importe lequel de ses comptes-groupes) : tous les droits.
 *  3. Espace PRIVÉ (0) : propriétaire seul. Ni l'administrateur ni un « membre » résiduel (ligne
 *     restée d'un changement de nature) n'y accèdent.
 *  4. Espaces 1, 2, 3 : membre par compte-groupe ou par rôle, permission maximale en cas de cumul.
 *  5. Administrateur non membre, espaces 1 à 3 : LECTURE seule (`access: null`). Choix prudent et
 *     réversible : l'administrateur supervise sans pouvoir modifier, gérer les membres ni publier
 *     l'espace d'autrui ; lui accorder la gestion se ferait ici sans toucher au reste.
 *  6. Publication (3) : lecture seule pour tout utilisateur authentifié (`access: null`), avec la
 *     portée documentaire `public`.
 *  7. Sinon : invisible.
 */
export function resolveSpaceAccess(
  space: SpaceAccessFacts,
  actor: SpaceActor,
): SpaceAccessDecision {
  if (!space.isActive) return DENIED;

  if (isSpaceOwner(space, actor)) return decisionFor('owner', 'full');

  if (space.kind === GedSpaceKind.Prive) return DENIED;
  if (
    space.kind !== GedSpaceKind.Partage &&
    space.kind !== GedSpaceKind.Collaboration &&
    space.kind !== GedSpaceKind.Publication
  ) {
    return DENIED; // nature inconnue : refus par défaut
  }

  const perm = memberPermission(space.members, actor);
  if (perm != null) return decisionFor(perm, 'full');

  // L'administrateur passe déjà `canAccess` sur tout document : la portée `public` ne lui
  // masquerait rien qu'il ne puisse ouvrir directement, d'où `full`.
  if (actor.isAdmin) return decisionFor(null, 'full');

  if (space.kind === GedSpaceKind.Publication) return decisionFor(null, 'public');

  return DENIED;
}

/**
 * Un document rattaché peut-il figurer dans le listing de l'espace ?
 * `canAccess` est le verdict de `DocumentsService.canAccess` : il prime TOUJOURS.
 */
export function isDocumentListable(
  doc: { confidentialiteId: number | null },
  scope: SpaceDocumentScope,
  canAccess: boolean,
): boolean {
  if (!canAccess) return false;
  if (scope === 'public') return doc.confidentialiteId == null;
  return true;
}

/** L'espace peut-il changer de nature ? Un espace publié doit d'abord être dépublié. */
export function canChangeKind(currentKind: number, nextKind: number): boolean {
  if (currentKind === nextKind) return true;
  return currentKind !== GedSpaceKind.Publication;
}

/** La publication exige un espace déjà partagé (1 ou 2) ; un espace publié peut être republié. */
export function canPublish(kind: number): boolean {
  return (
    kind === GedSpaceKind.Partage ||
    kind === GedSpaceKind.Collaboration ||
    kind === GedSpaceKind.Publication
  );
}
