import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { AuthUser } from '../../auth/auth.types';
import { effectiveMenuKeys } from '../../auth/menu-access';
import { PrismaService } from '../../prisma/prisma.service';
import type { ImputableActorsPort } from '../catalog.contracts';

/**
 * ACTEURS IMPUTABLES — règle prudente et réversible (lot W6), relue en base à chaque appel, échec fermé :
 *
 *  1. Peut imputer (`canImpute`) : compte actif ET (administrateur OU au moins un des menus de la garde de
 *     `POST /courriers/imputations` : `/courriers/controle`, `/courriers/parapheur`, `/courriers/validation`).
 *     Les menus effectifs suivent `effectiveMenuKeys` (même règle que `MenuPermissionGuard` : l'administrateur
 *     et le rôle système ont tout). L'identité machine et un jeton sans acteur ne peuvent jamais imputer.
 *  2. Imputable (`isImputable`) : l'imputeur peut imputer ET la cible est un `app_user_group` existant dont le
 *     compte n'est pas désactivé ET (administrateur OU rôle ACTIF portant au moins un menu courrier :
 *     `/courriers/suivi`, `/courriers/suivi-dc`, `/courriers/controle`, `/courriers/parapheur`,
 *     `/courriers/validation`). Un rôle inactif ou sans menu courrier : non imputable (il ne verrait pas le courrier).
 *  3. Liste (`list`) : mêmes critères, bornée (défaut 50, maximum 100), filtre texte facultatif sur le nom et
 *     le groupe (jamais sur l'identifiant de connexion), libellé « Nom — Groupe », rôle et nœud d'organigramme
 *     du rôle. Aucune donnée sensible (ni e-mail, ni identifiant de connexion, ni matricule).
 *
 * Pour assouplir : élargir `COURRIER_MENU_KEYS` ; pour restreindre (p. ex. par organigramme) : ajouter un
 * filtre commun à `isImputable` et `list`. Le contrôle de groupe actif (`app_group.is_active`) n'est pas appliqué.
 */

/** Menus de la garde de `POST /courriers/imputations`. */
export const IMPUTATION_MENU_KEYS = ['/courriers/controle', '/courriers/parapheur', '/courriers/validation'] as const;

/** Menus courrier qui rendent un acteur imputable (il peut voir et traiter le courrier imputé). */
export const COURRIER_MENU_KEYS = [
  '/courriers/suivi',
  '/courriers/suivi-dc',
  '/courriers/controle',
  '/courriers/parapheur',
  '/courriers/validation',
] as const;

export const IMPUTABLE_LIST_DEFAULT = 50;
export const IMPUTABLE_LIST_MAX = 100;
const SEARCH_MAX = 100;

type RoleRow = {
  isActive: boolean;
  isSystem: boolean;
  menus: { menuKey: string }[];
} | null;

@Injectable()
export class ImputableActorsService implements ImputableActorsPort {
  constructor(private readonly prisma: PrismaService) {}

  async canImpute(imputer: AuthUser): Promise<boolean> {
    if (!imputer || imputer.isScanAgent || imputer.userGroupId == null) return false;
    const row = await this.prisma.appUser.findUnique({
      where: { userId: imputer.userId },
      select: {
        isAdmin: true,
        isDisabled: true,
        role: { select: { isActive: true, isSystem: true, menus: { select: { menuKey: true } } } },
      },
    });
    if (!row || row.isDisabled) return false;
    return hasAny(row.isAdmin === true, row.role, IMPUTATION_MENU_KEYS);
  }

  async isImputable(imputer: AuthUser, targetUserGroupId: number): Promise<boolean> {
    if (!Number.isSafeInteger(targetUserGroupId) || targetUserGroupId < 1) return false;
    if (!(await this.canImpute(imputer))) return false;
    const target = await this.prisma.appUserGroup.findUnique({
      where: { userGroupId: targetUserGroupId },
      select: {
        user: {
          select: {
            isAdmin: true,
            isDisabled: true,
            role: { select: { isActive: true, isSystem: true, menus: { select: { menuKey: true } } } },
          },
        },
      },
    });
    if (!target || !target.user || target.user.isDisabled) return false;
    return hasAny(target.user.isAdmin === true, target.user.role, COURRIER_MENU_KEYS);
  }

  async list(
    imputer: AuthUser,
    opts: { search?: string; limit?: number } = {},
  ): Promise<Array<{ userGroupId: number; label: string; roleId: number | null; roleName: string | null; organigrammeLabel: string | null }>> {
    if (!(await this.canImpute(imputer))) return [];
    const limit = clampLimit(opts.limit);
    const search = typeof opts.search === 'string' ? opts.search.trim().slice(0, SEARCH_MAX) : '';

    const where: Prisma.AppUserGroupWhereInput = {
      user: {
        isDisabled: false,
        OR: [
          { isAdmin: true },
          { role: { isActive: true, isSystem: true } },
          { role: { isActive: true, menus: { some: { menuKey: { in: [...COURRIER_MENU_KEYS] } } } } },
        ],
      },
      ...(search
        ? {
            OR: [
              { user: { fullName: { contains: search, mode: 'insensitive' } } },
              { user: { firstName: { contains: search, mode: 'insensitive' } } },
              { user: { lastName: { contains: search, mode: 'insensitive' } } },
              { group: { name: { contains: search, mode: 'insensitive' } } },
            ],
          }
        : {}),
    };
    const rows = await this.prisma.appUserGroup.findMany({
      where,
      take: limit,
      orderBy: [{ user: { lastName: 'asc' } }, { user: { firstName: 'asc' } }, { userGroupId: 'asc' }],
      select: {
        userGroupId: true,
        group: { select: { name: true } },
        user: {
          select: {
            fullName: true,
            firstName: true,
            lastName: true,
            role: {
              select: {
                roleId: true,
                name: true,
                isActive: true,
                organigramme: { select: { label: true, isActive: true } },
              },
            },
          },
        },
      },
    });
    return rows.map((r) => {
      const name = r.user.fullName?.trim() || `${r.user.firstName ?? ''} ${r.user.lastName ?? ''}`.trim() || `Acteur n°${r.userGroupId}`;
      const role = r.user.role && r.user.role.isActive ? r.user.role : null;
      return {
        userGroupId: r.userGroupId,
        label: r.group?.name ? `${name} — ${r.group.name}` : name,
        roleId: role?.roleId ?? null,
        roleName: role?.name ?? null,
        organigrammeLabel: role?.organigramme && role.organigramme.isActive ? role.organigramme.label : null,
      };
    });
  }
}

function hasAny(isAdmin: boolean, role: RoleRow, keys: readonly string[]): boolean {
  const granted = effectiveMenuKeys(isAdmin, role);
  return keys.some((k) => granted.includes(k));
}

function clampLimit(raw: number | undefined): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return IMPUTABLE_LIST_DEFAULT;
  return Math.min(IMPUTABLE_LIST_MAX, Math.max(1, Math.floor(raw)));
}
