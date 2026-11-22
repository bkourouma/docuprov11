import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { AuthUser } from '../../auth/auth.types';
import { effectiveMenuKeys } from '../../auth/menu-access';
import { AgentDataAdapter } from '../../workflow-agents/tools/agent-data.adapter';
import { EffectRefusedError, type ApplierRights } from '../catalog.contracts';

/** Lecture de courrier avec la règle des agents (`AgentDataAdapter.readMail`) : null = refus ou absence. */
export interface MailReadCheck {
  readMail(user: AuthUser, mailId: number, maxChars: number): Promise<unknown>;
}

type MenuDb = Pick<Prisma.TransactionClient, 'appUser'>;

/**
 * Droits CONJOINTS du valideur et du lanceur pour un lot d'actions validées. Chaque contrôle doit réussir
 * pour les DEUX ; le premier refus lève `EffectRefusedError` (message en français, sans contenu de courrier).
 *  - menus : rôle et `isAdmin` RELUS en base, même règle que `MenuPermissionGuard` (`effectiveMenuKeys` :
 *    l'administrateur et le rôle système ont tout ; compte désactivé : aucun menu) ;
 *  - courrier : même règle que l'outil `lire_courrier` (périmètre `mailScope`, confidentialité, courrier actif).
 * Résultats mémorisés le temps de la validation (plusieurs actions sur le même courrier).
 */
export class JointApplierRights implements ApplierRights {
  private readonly menus = new Map<number, Promise<readonly string[]>>();
  private readonly readable = new Map<string, Promise<boolean>>();

  constructor(
    readonly validator: AuthUser,
    readonly launcher: AuthUser,
    private readonly db: MenuDb,
    private readonly mails: MailReadCheck,
  ) {}

  async requireAnyMenu(menuKeys: readonly string[], what: string): Promise<void> {
    for (const [role, user] of this.parties()) {
      const granted = await this.menusOf(user);
      if (!menuKeys.some((k) => granted.includes(k))) {
        throw new EffectRefusedError(
          `Le ${role} n'a pas le droit ${withDe(what)} (menu requis absent) : aucune action n'a été appliquée.`,
          'menu_denied',
        );
      }
    }
  }

  async requireMailReadable(mailId: number): Promise<void> {
    if (!Number.isSafeInteger(mailId) || mailId < 1) {
      throw new EffectRefusedError('Identifiant de courrier invalide : aucune action n’a été appliquée.', 'mail_invalid');
    }
    for (const [role, user] of this.parties()) {
      if (!(await this.canRead(user, mailId))) {
        throw new EffectRefusedError(
          `Le courrier n°${mailId} est introuvable ou n'est pas lisible par le ${role} : aucune action n'a été appliquée.`,
          'mail_not_readable',
        );
      }
    }
  }

  private parties(): Array<[string, AuthUser]> {
    return [
      ['valideur', this.validator],
      ['lanceur', this.launcher],
    ];
  }

  private menusOf(user: AuthUser): Promise<readonly string[]> {
    let cached = this.menus.get(user.userId);
    if (!cached) {
      cached = this.loadMenus(user);
      this.menus.set(user.userId, cached);
    }
    return cached;
  }

  private async loadMenus(user: AuthUser): Promise<readonly string[]> {
    if (user.isScanAgent || user.userGroupId == null) return [];
    const row = await this.db.appUser.findUnique({
      where: { userId: user.userId },
      select: {
        isAdmin: true,
        isDisabled: true,
        role: { select: { isActive: true, isSystem: true, menus: { select: { menuKey: true } } } },
      },
    });
    if (!row || row.isDisabled) return [];
    return effectiveMenuKeys(row.isAdmin === true, row.role);
  }

  private canRead(user: AuthUser, mailId: number): Promise<boolean> {
    const key = `${user.userId}:${user.userGroupId ?? ''}:${mailId}`;
    let cached = this.readable.get(key);
    if (!cached) {
      cached = this.mails.readMail(user, mailId, 0).then((view) => view !== null && view !== undefined);
      this.readable.set(key, cached);
    }
    return cached;
  }
}

/** « de » / « d' » devant l'action décrite (« d'imputer un courrier », « de relancer »). */
function withDe(what: string): string {
  const text = what.trim();
  return /^[aeiouyhâàéèêëîïôûù]/i.test(text) ? `d'${text}` : `de ${text}`;
}

/** Fabrique des droits conjoints (service de droits du module des applicateurs). */
@Injectable()
export class ApplierRightsService {
  constructor(private readonly mails: AgentDataAdapter) {}

  create(validator: AuthUser, launcher: AuthUser, db: MenuDb): ApplierRights {
    return new JointApplierRights(validator, launcher, db, this.mails);
  }
}
