import type { AuthUser } from '../../auth/auth.types';
import { EffectRefusedError } from '../catalog.contracts';
import { ApplierRightsService, JointApplierRights } from './applier-rights';

const validator: AuthUser = { userId: 21, username: 'v', isAdmin: false, userGroupId: 20 };
const launcher: AuthUser = { userId: 11, username: 'l', isAdmin: false, userGroupId: 10 };

type Row = { isAdmin: boolean; isDisabled: boolean; role: { isActive: boolean; isSystem: boolean; menus: { menuKey: string }[] } | null };
const role = (keys: string[], over: Partial<{ isActive: boolean; isSystem: boolean }> = {}) => ({
  isActive: true,
  isSystem: false,
  menus: keys.map((menuKey) => ({ menuKey })),
  ...over,
});

function setup(rows: Record<number, Row | null>, readable: Record<number, boolean> = { 21: true, 11: true }) {
  const db = { appUser: { findUnique: jest.fn(async ({ where }: { where: { userId: number } }) => rows[where.userId] ?? null) } };
  const mails = { readMail: jest.fn(async (u: AuthUser) => (readable[u.userId] ? { mailId: 5 } : null)) };
  return { rights: new JointApplierRights(validator, launcher, db as never, mails), db, mails };
}

const MENUS = ['/courriers/controle', '/courriers/parapheur', '/courriers/validation'];

describe('JointApplierRights.requireAnyMenu — les DEUX doivent détenir un menu', () => {
  it('les deux ont un menu (rôle ou administrateur) : accepté ; rôle relu une seule fois par utilisateur', async () => {
    const { rights, db } = setup({
      21: { isAdmin: false, isDisabled: false, role: role(['/courriers/parapheur']) },
      11: { isAdmin: true, isDisabled: false, role: null },
    });
    await rights.requireAnyMenu(MENUS, 'imputer un courrier');
    await rights.requireAnyMenu(MENUS, 'imputer un courrier');
    expect(db.appUser.findUnique).toHaveBeenCalledTimes(2);
  });

  it('rôle système actif : tout ; rôle inactif, compte désactivé, absence de menu : refus nommant la partie', async () => {
    const sys = setup({
      21: { isAdmin: false, isDisabled: false, role: role([], { isSystem: true }) },
      11: { isAdmin: false, isDisabled: false, role: role(['/courriers/validation']) },
    });
    await expect(sys.rights.requireAnyMenu(MENUS, 'imputer')).resolves.toBeUndefined();

    const noValidatorMenu = setup({
      21: { isAdmin: false, isDisabled: false, role: role(['/courriers/suivi']) },
      11: { isAdmin: true, isDisabled: false, role: null },
    });
    await expect(noValidatorMenu.rights.requireAnyMenu(MENUS, 'imputer un courrier')).rejects.toThrow(/valideur/);

    const inactive = setup({
      21: { isAdmin: false, isDisabled: false, role: role(['/courriers/parapheur']) },
      11: { isAdmin: false, isDisabled: false, role: role(['/courriers/parapheur'], { isActive: false }) },
    });
    await expect(inactive.rights.requireAnyMenu(MENUS, 'imputer')).rejects.toThrow(/lanceur/);

    const disabled = setup({
      21: { isAdmin: true, isDisabled: true, role: null },
      11: { isAdmin: true, isDisabled: false, role: null },
    });
    await expect(disabled.rights.requireAnyMenu(MENUS, 'imputer')).rejects.toBeInstanceOf(EffectRefusedError);

    const missing = setup({ 21: null, 11: null });
    await expect(missing.rights.requireAnyMenu(MENUS, 'imputer')).rejects.toMatchObject({ code: 'menu_denied' });
  });

  it('identité machine : jamais de menu', async () => {
    const db = { appUser: { findUnique: jest.fn(async () => ({ isAdmin: true, isDisabled: false, role: null })) } };
    const rights = new JointApplierRights({ ...validator, isScanAgent: true }, launcher, db as never, { readMail: async () => ({}) });
    await expect(rights.requireAnyMenu(MENUS, 'imputer')).rejects.toThrow(/valideur/);
  });
});

describe('JointApplierRights.requireMailReadable — les DEUX doivent pouvoir lire', () => {
  it('lisible par les deux : accepté (mémorisé) ; illisible pour l’un : refus sans contenu', async () => {
    const ok = setup({});
    await ok.rights.requireMailReadable(5);
    await ok.rights.requireMailReadable(5);
    expect(ok.mails.readMail).toHaveBeenCalledTimes(2);
    expect(ok.mails.readMail).toHaveBeenCalledWith(validator, 5, 0);
    expect(ok.mails.readMail).toHaveBeenCalledWith(launcher, 5, 0);

    const launcherBlind = setup({}, { 21: true, 11: false });
    await expect(launcherBlind.rights.requireMailReadable(5)).rejects.toMatchObject({
      code: 'mail_not_readable',
      message: expect.stringContaining('lanceur'),
    });
    const validatorBlind = setup({}, { 21: false, 11: true });
    await expect(validatorBlind.rights.requireMailReadable(5)).rejects.toThrow(/valideur/);
    expect(validatorBlind.mails.readMail).toHaveBeenCalledTimes(1);
    await expect(ok.rights.requireMailReadable(0)).rejects.toMatchObject({ code: 'mail_invalid' });
  });

  it('ApplierRightsService fabrique des droits liés au valideur, au lanceur et à la transaction', async () => {
    const adapter = { readMail: jest.fn(async () => ({ mailId: 5 })) };
    const db = { appUser: { findUnique: jest.fn(async () => ({ isAdmin: true, isDisabled: false, role: null })) } };
    const rights = new ApplierRightsService(adapter as never).create(validator, launcher, db as never);
    expect(rights.validator).toBe(validator);
    expect(rights.launcher).toBe(launcher);
    await rights.requireAnyMenu(MENUS, 'imputer');
    await rights.requireMailReadable(5);
    expect(db.appUser.findUnique).toHaveBeenCalled();
    expect(adapter.readMail).toHaveBeenCalledTimes(2);
  });
});
