// Docu-Flow — droits d'AFFICHAGE. Le serveur reste seul juge (403/404) : ces règles ne servent qu'à ne pas
// proposer ce qui sera refusé. Source des menus : apps/api/src/modules/workflows/workflows.menus.ts.
import type { WfInstanceStatus } from '@archivage/types';

export const WF_MENU = {
  design: '/workflows/conception',
  launch: '/workflows/lancer',
  admin: '/workflows/administration',
} as const;

/** Sous-ensemble de `Me` (lib/auth.ts) dont dépendent les droits. */
export interface WfAccessInput {
  isAdmin?: boolean;
  /** Absent => backend pas à jour : comme la barre latérale, on n'applique aucun filtre. */
  menuKeys?: string[];
  userGroupId?: number | null;
}

export interface WfAccess {
  /** Compte administrateur : seul à pouvoir marquer un workflow « faible risque ». */
  isAdmin: boolean;
  userGroupId: number | null;
  /** Menu « Conception des workflows ». */
  canDesign: boolean;
  /** Menu « Lancer un workflow ». */
  canLaunch: boolean;
  /** Menu « Administration des workflows » : voit et pilote toutes les instances (jamais les tâches d'autrui). */
  canAdminister: boolean;
}

export function computeWorkflowAccess(me: WfAccessInput | null | undefined): WfAccess {
  if (!me) return { isAdmin: false, userGroupId: null, canDesign: false, canLaunch: false, canAdminister: false };
  const isAdmin = me.isAdmin === true;
  const has = (key: string) => isAdmin || me.menuKeys === undefined || me.menuKeys.includes(key);
  return {
    isAdmin,
    userGroupId: me.userGroupId ?? null,
    canDesign: has(WF_MENU.design),
    canLaunch: has(WF_MENU.launch),
    canAdminister: has(WF_MENU.admin),
  };
}

/** Au moins un menu Docu-Flow : condition pour voir le suivi des instances (liste « les miennes »). */
export function hasAnyWorkflowMenu(access: WfAccess): boolean {
  return access.canDesign || access.canLaunch || access.canAdminister;
}

/** Suivi des instances : `GET /workflows/instances` exige le menu lancer ou administration (la conception seule n'ouvre rien). */
export function canTrackInstances(access: WfAccess): boolean {
  return access.canLaunch || access.canAdminister;
}

/** Réservé aux administrateurs (`POST /workflows/definitions/:id/low-risk`). */
export function canMarkLowRisk(access: WfAccess): boolean {
  return access.isAdmin;
}

export interface WfInstanceActionRights {
  cancel: boolean;
  suspend: boolean;
  resume: boolean;
}

const ACTIVE: readonly number[] = [0, 1];
const SUSPENDED = 5;

/**
 * Actions possibles sur une instance : lanceur (avec le menu « lancer ») ou détenteur du menu
 * d'administration, ET état compatible (annuler : en cours, en attente ou suspendue ; suspendre : en
 * cours ou en attente ; reprendre : suspendue). Les états terminaux n'offrent rien.
 */
export function instanceActionRights(
  access: WfAccess,
  instance: { startedBy: number; status: WfInstanceStatus },
): WfInstanceActionRights {
  const isStarter = access.userGroupId !== null && access.userGroupId === instance.startedBy;
  const mayAct = access.canAdminister || (isStarter && access.canLaunch);
  if (!mayAct) return { cancel: false, suspend: false, resume: false };
  return {
    cancel: ACTIVE.includes(instance.status) || instance.status === SUSPENDED,
    suspend: ACTIVE.includes(instance.status),
    resume: instance.status === SUSPENDED,
  };
}
